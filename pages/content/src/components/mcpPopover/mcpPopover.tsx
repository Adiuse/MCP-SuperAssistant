import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useCurrentAdapter, useUserPreferences, useMCPState } from '../../hooks';
import PopoverPortal from './PopoverPortal';
import { instructionsState } from '../sidebar/Instructions/InstructionManager';
import { HeadlessInstructionSync } from '../sidebar/Instructions/HeadlessInstructionSync';
import { CodeReviewAccessFa } from '../CodeReviewAccessFa';
import { SecurityCenterFa } from '../SecurityCenterFa';
import { AutomationService } from '../../services/automation.service';
import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('mcpPopover');

export interface MCPToggleState {
  mcpEnabled: boolean;
  autoInsert: boolean;
  autoSubmit: boolean;
  autoExecute: boolean;
}

interface MCPPopoverProps {
  toggleStateManager: {
    getState(): MCPToggleState;
    setMCPEnabled(enabled: boolean): void;
    setAutoInsert(enabled: boolean): void;
    setAutoSubmit(enabled: boolean): void;
    setAutoExecute(enabled: boolean): void;
    updateUI(): void;
  };
  adapterButtonConfig?: {
    className?: string;
    contentClassName?: string;
    textClassName?: string;
    iconClassName?: string;
    activeClassName?: string;
  };
  adapterName?: string;
}

interface ToggleItemProps {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  isDark: boolean;
}

function parseRgbBrightness(value: string): number | null {
  const match = value.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!match) return null;
  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function detectHostDarkTheme(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;

  const html = document.documentElement;
  const body = document.body;
  const explicitValues = [
    html.getAttribute('data-theme'),
    body?.getAttribute('data-theme'),
    html.getAttribute('data-color-scheme'),
    body?.getAttribute('data-color-scheme'),
    html.getAttribute('data-color-mode'),
    body?.getAttribute('data-color-mode'),
    html.style.colorScheme,
    body?.style.colorScheme,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (explicitValues.includes('dark')) return true;
  if (explicitValues.includes('light')) return false;

  const classText = `${html.className || ''} ${body?.className || ''}`.toLowerCase();
  if (/(^|\s)(dark|theme-dark|dark-theme|dark-mode)(\s|$)/.test(classText)) return true;
  if (/(^|\s)(light|theme-light|light-theme|light-mode)(\s|$)/.test(classText)) return false;

  const candidates = [body, document.querySelector('main'), document.querySelector('[role="main"]')].filter(
    Boolean,
  ) as Element[];
  for (const element of candidates) {
    const background = window.getComputedStyle(element).backgroundColor;
    if (!background || background === 'transparent' || background === 'rgba(0, 0, 0, 0)') continue;
    const brightness = parseRgbBrightness(background);
    if (brightness !== null) return brightness < 145;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

const useThemeDetector = () => {
  const [isDark, setIsDark] = useState(() => detectHostDarkTheme());

  useEffect(() => {
    const update = () => setIsDark(detectHostDarkTheme());
    update();

    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', update);

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'data-color-mode'],
    });
    if (document.body) {
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'data-color-mode'],
      });
    }

    const interval = window.setInterval(update, 1200);
    return () => {
      media?.removeEventListener('change', update);
      observer.disconnect();
      window.clearInterval(interval);
    };
  }, []);

  return isDark;
};

const ToggleItem: React.FC<ToggleItemProps> = ({ id, label, checked, disabled, onChange, isDark }) => (
  <label
    htmlFor={id}
    dir="rtl"
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '10px 12px',
      borderRadius: 10,
      border: `1px solid ${isDark ? '#3f3f46' : '#e2e8f0'}`,
      background: disabled ? (isDark ? '#27272a' : '#f8fafc') : isDark ? '#18181b' : '#ffffff',
      opacity: disabled ? 0.55 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontSize: 13,
      fontWeight: 650,
      color: isDark ? '#f4f4f5' : '#0f172a',
    }}>
    <span>{label}</span>
    <span
      style={{
        position: 'relative',
        width: 38,
        height: 21,
        borderRadius: 999,
        background: checked ? '#2563eb' : isDark ? '#52525b' : '#cbd5e1',
        transition: 'all .18s ease',
        flexShrink: 0,
      }}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
      />
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? 20 : 3,
          width: 15,
          height: 15,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,.25)',
          transition: 'left .18s ease',
        }}
      />
    </span>
  </label>
);

export const MCPPopover: React.FC<MCPPopoverProps> = ({ toggleStateManager, adapterButtonConfig, adapterName }) => {
  const isDark = useThemeDetector();
  const { plugin: activePlugin, insertText, attachFile, isReady: isAdapterActive } = useCurrentAdapter();
  const { preferences, updatePreferences } = useUserPreferences();
  const { mcpEnabled: mcpEnabledFromStore, setMCPEnabled } = useMCPState();

  const [state, setState] = useState<MCPToggleState>(() => ({
    ...toggleStateManager.getState(),
    mcpEnabled: mcpEnabledFromStore,
  }));
  const [instructions, setInstructions] = useState(instructionsState.instructions || '');
  const [isOpen, setIsOpen] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [copyStatus, setCopyStatus] = useState('کپی');
  const [insertStatus, setInsertStatus] = useState('درج در چت');
  const [attachStatus, setAttachStatus] = useState('پیوست');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const colors = {
    panel: isDark ? '#111113' : '#ffffff',
    panel2: isDark ? '#18181b' : '#f8fafc',
    border: isDark ? '#3f3f46' : '#dbe2ea',
    text: isDark ? '#f4f4f5' : '#0f172a',
    muted: isDark ? '#a1a1aa' : '#64748b',
    accent: '#2563eb',
  };

  useEffect(() => {
    setState(prev => ({ ...prev, mcpEnabled: mcpEnabledFromStore }));
  }, [mcpEnabledFromStore]);

  useEffect(() => {
    const synced = {
      ...toggleStateManager.getState(),
      mcpEnabled: mcpEnabledFromStore,
      autoInsert: preferences.autoInsert || false,
      autoSubmit: preferences.autoSubmit || false,
      autoExecute: preferences.autoExecute || false,
    };
    setState(synced);
    toggleStateManager.setAutoInsert(synced.autoInsert);
    toggleStateManager.setAutoSubmit(synced.autoSubmit);
    toggleStateManager.setAutoExecute(synced.autoExecute);
  }, [mcpEnabledFromStore, preferences.autoExecute, preferences.autoInsert, preferences.autoSubmit, toggleStateManager]);

  useEffect(() => {
    setInstructions(instructionsState.instructions || '');
    return instructionsState.subscribe(next => setInstructions(next));
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      if (document.getElementById('mcp-popover-portal')?.contains(target)) return;
      setIsOpen(false);
    };
    const timer = window.setTimeout(() => document.addEventListener('mousedown', handleOutside), 10);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', handleOutside);
    };
  }, [isOpen]);

  const syncAutomation = () => {
    AutomationService.getInstance().updateAutomationStateOnWindow().catch(error => {
      logger.warn('[MCPPopover] automation sync failed', error);
    });
  };

  const handleMCP = (checked: boolean) => {
    setMCPEnabled(checked, 'mcp-popover-user-toggle');
    toggleStateManager.setMCPEnabled(checked);
    setState(prev => ({ ...prev, mcpEnabled: checked }));
  };

  const handleAutoInsert = (checked: boolean) => {
    updatePreferences({ autoInsert: checked });
    toggleStateManager.setAutoInsert(checked);
    setState(prev => ({ ...prev, autoInsert: checked }));
    syncAutomation();
  };

  const handleAutoSubmit = (checked: boolean) => {
    updatePreferences({ autoSubmit: checked });
    toggleStateManager.setAutoSubmit(checked);
    setState(prev => ({ ...prev, autoSubmit: checked }));
    syncAutomation();
  };

  const handleAutoExecute = (checked: boolean) => {
    updatePreferences({ autoExecute: checked });
    toggleStateManager.setAutoExecute(checked);
    setState(prev => ({ ...prev, autoExecute: checked }));
    syncAutomation();
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(instructions);
      setCopyStatus('کپی شد ✓');
    } catch {
      setCopyStatus('خطا');
    }
    window.setTimeout(() => setCopyStatus('کپی'), 1200);
  };

  const handleInsert = async () => {
    if (!instructions.trim()) {
      setInsertStatus('دستوری موجود نیست');
      window.setTimeout(() => setInsertStatus('درج در چت'), 1200);
      return;
    }

    if (!isAdapterActive || !activePlugin || !insertText) {
      setInsertStatus('آداپتر آماده نیست');
      window.setTimeout(() => setInsertStatus('درج در چت'), 1200);
      return;
    }

    try {
      const ok = await insertText(instructions);
      setInsertStatus(ok ? 'درج شد ✓' : 'ناموفق');
    } catch {
      setInsertStatus('ناموفق');
    }
    window.setTimeout(() => setInsertStatus('درج در چت'), 1200);
  };

  const handleAttach = async () => {
    if (!instructions.trim()) {
      setAttachStatus('دستوری موجود نیست');
      window.setTimeout(() => setAttachStatus('پیوست'), 1200);
      return;
    }

    if (!isAdapterActive || !activePlugin || !attachFile || !activePlugin.capabilities.includes('file-attachment')) {
      setAttachStatus('پشتیبانی نمی‌شود');
      window.setTimeout(() => setAttachStatus('پیوست'), 1200);
      return;
    }

    const plain = activePlugin.name === 'Perplexity' || activePlugin.name === 'Gemini';
    const file = new File(
      [instructions],
      `mcp_superassistant_instructions.${plain ? 'txt' : 'md'}`,
      { type: plain ? 'text/plain' : 'text/markdown' },
    );

    try {
      const ok = await attachFile(file);
      setAttachStatus(ok ? 'پیوست شد ✓' : 'ناموفق');
    } catch {
      setAttachStatus('ناموفق');
    }
    window.setTimeout(() => setAttachStatus('پیوست'), 1200);
  };

  const buttonClassName = adapterButtonConfig?.className
    ? `${adapterButtonConfig.className}${state.mcpEnabled && adapterButtonConfig.activeClassName ? ` ${adapterButtonConfig.activeClassName}` : ''}`
    : '';

  const buttonStyle: React.CSSProperties = adapterButtonConfig?.className
    ? {}
    : {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        borderRadius: 10,
        border: `1px solid ${colors.border}`,
        background: state.mcpEnabled ? (isDark ? '#172554' : '#dbeafe') : colors.panel2,
        color: colors.text,
        cursor: 'pointer',
        fontWeight: 700,
      };

  const buttonContent = adapterButtonConfig?.contentClassName ? (
    <span className={adapterButtonConfig.contentClassName}>
      <img
        src={chrome.runtime.getURL('icon-34.png')}
        alt="MCP"
        className={adapterButtonConfig.iconClassName || ''}
        style={{ width: 20, height: 20, borderRadius: '50%' }}
      />
      <span className={adapterButtonConfig.textClassName || ''}>MCP</span>
    </span>
  ) : (
    <>
      <img src={chrome.runtime.getURL('icon-34.png')} alt="MCP" style={{ width: 20, height: 20, borderRadius: '50%' }} />
      <span>MCP</span>
    </>
  );

  return (
    <div id="mcp-popover-container" style={{ position: 'relative', display: 'inline-block' }}>
      <HeadlessInstructionSync />

      <button
        ref={buttonRef}
        type="button"
        className={buttonClassName}
        style={buttonStyle}
        aria-label="تنظیمات MCP"
        title="مرکز کنترل MCP و امنیت GitHub"
        onClick={() => setIsOpen(open => !open)}>
        {buttonContent}
      </button>

      <PopoverPortal isOpen={isOpen} triggerRef={buttonRef}>
        <div
          ref={popoverRef}
          className={isDark ? 'dark' : undefined}
          dir="rtl"
          style={{
            width: 'min(860px, calc(100vw - 28px))',
            maxHeight: '86vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 18,
            border: `1px solid ${colors.border}`,
            background: colors.panel,
            color: colors.text,
            colorScheme: isDark ? 'dark' : 'light',
            boxShadow: isDark ? '0 22px 60px rgba(0,0,0,.55)' : '0 22px 60px rgba(15,23,42,.20)',
            fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Tahoma,sans-serif',
          }}>
          <header
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              padding: '16px 18px',
              borderBottom: `1px solid ${colors.border}`,
              background: colors.panel2,
            }}>
            <div>
              <div style={{ fontWeight: 850, fontSize: 17 }}>مرکز کنترل MCP و امنیت GitHub</div>
              <div style={{ marginTop: 4, color: colors.muted, fontSize: 12 }}>
                ابزارهای MCP، دستورها و دسترسی موقت Code Review در یک پنل
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                border: `1px solid ${colors.border}`,
                background: colors.panel,
                color: colors.text,
                cursor: 'pointer',
                fontSize: 18,
              }}>
              ×
            </button>
          </header>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '210px minmax(0, 1fr)',
              minHeight: 0,
              flex: 1,
            }}>
            <aside
              style={{
                padding: 14,
                borderLeft: `1px solid ${colors.border}`,
                background: colors.panel2,
                overflowY: 'auto',
              }}>
              <div style={{ marginBottom: 9, fontSize: 12, color: colors.muted, fontWeight: 700 }}>کنترل MCP</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <ToggleItem id="mcp-toggle" label="MCP" checked={state.mcpEnabled} disabled={false} onChange={handleMCP} isDark={isDark} />
                <ToggleItem
                  id="auto-insert-toggle"
                  label="درج خودکار دستور"
                  checked={state.autoInsert}
                  disabled={!state.mcpEnabled}
                  onChange={handleAutoInsert}
                  isDark={isDark}
                />
                <ToggleItem
                  id="auto-submit-toggle"
                  label="ارسال خودکار"
                  checked={state.autoSubmit}
                  disabled={!state.mcpEnabled || !state.autoInsert}
                  onChange={handleAutoSubmit}
                  isDark={isDark}
                />
                <ToggleItem
                  id="auto-execute-toggle"
                  label="اجرای خودکار Tool"
                  checked={state.autoExecute}
                  disabled={!state.mcpEnabled}
                  onChange={handleAutoExecute}
                  isDark={isDark}
                />
              </div>

              <div
                style={{
                  marginTop: 14,
                  padding: 11,
                  borderRadius: 10,
                  border: `1px solid ${colors.border}`,
                  color: colors.muted,
                  fontSize: 11,
                  lineHeight: 1.8,
                  background: colors.panel,
                }}>
                دسترسی GitHub به‌صورت پیش‌فرض خاموش است. درخواست مدل فقط یک تأیید محلی ایجاد می‌کند و تا تأیید شما ابزارهای خواندن GitHub فعال نمی‌شوند.
              </div>
            </aside>

            <main style={{ padding: 16, overflowY: 'auto', minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <CodeReviewAccessFa />
                <SecurityCenterFa />

                <section
                  style={{
                    border: `1px solid ${colors.border}`,
                    borderRadius: 14,
                    background: colors.panel2,
                    overflow: 'hidden',
                  }}>
                  <button
                    type="button"
                    onClick={() => setShowInstructions(open => !open)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '13px 14px',
                      border: 0,
                      background: 'transparent',
                      color: colors.text,
                      cursor: 'pointer',
                      fontWeight: 800,
                      fontSize: 14,
                    }}>
                    <span>دستورهای MCP برای مدل</span>
                    <span>{showInstructions ? '▲' : '▼'}</span>
                  </button>

                  {showInstructions && (
                    <div style={{ padding: '0 14px 14px' }}>
                      <pre
                        dir="ltr"
                        style={{
                          margin: 0,
                          maxHeight: 260,
                          overflow: 'auto',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          borderRadius: 10,
                          border: `1px solid ${colors.border}`,
                          padding: 12,
                          background: colors.panel,
                          color: colors.text,
                          fontSize: 11,
                          lineHeight: 1.6,
                          textAlign: 'left',
                        }}>
                        {instructions || 'در حال تولید دستورها...'}
                      </pre>

                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8, marginTop: 10 }}>
                        {[{ label: copyStatus, action: handleCopy }, { label: insertStatus, action: handleInsert }, { label: attachStatus, action: handleAttach }].map(item => (
                          <button
                            key={item.label}
                            type="button"
                            onClick={() => void item.action()}
                            style={{
                              padding: '9px 8px',
                              borderRadius: 9,
                              border: `1px solid ${colors.border}`,
                              background: colors.panel,
                              color: colors.text,
                              cursor: 'pointer',
                              fontWeight: 700,
                              fontSize: 12,
                            }}>
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              </div>
            </main>
          </div>
        </div>
      </PopoverPortal>
    </div>
  );
};

export default MCPPopover;
