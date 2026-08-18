import { useEffect, useState } from 'react';
import { SECURITY_TOAST_EVENT, type SecurityToastDetail, type SecurityToastVariant } from './securityToast';

interface ToastItem extends SecurityToastDetail {
  id: string;
  durationMs: number;
}

const TOAST_OWNER_KEY = '__mcpSecurityToastOwner';

function palette(variant: SecurityToastVariant | undefined) {
  switch (variant) {
    case 'success':
      return { background: '#052e2b', border: '#0f766e', accent: '#2dd4bf', icon: '✓' };
    case 'warning':
      return { background: '#422006', border: '#a16207', accent: '#facc15', icon: '!' };
    case 'error':
      return { background: '#450a0a', border: '#b91c1c', accent: '#f87171', icon: '×' };
    default:
      return { background: '#172554', border: '#1d4ed8', accent: '#60a5fa', icon: 'i' };
  }
}

export function SecurityToastContainer() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    const currentOwner = (window as any)[TOAST_OWNER_KEY];
    if (currentOwner) return;

    const ownerId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    (window as any)[TOAST_OWNER_KEY] = ownerId;
    setIsOwner(true);

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<SecurityToastDetail>).detail;
      if (!detail?.title) return;

      const id = detail.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const durationMs = Math.max(1500, detail.durationMs || 5000);
      const item: ToastItem = { ...detail, id, durationMs };

      setItems(current => [...current.filter(entry => entry.id !== id).slice(-3), item]);

      window.setTimeout(() => {
        setItems(current => current.filter(entry => entry.id !== id));
      }, durationMs);
    };

    window.addEventListener(SECURITY_TOAST_EVENT, handler);
    return () => {
      window.removeEventListener(SECURITY_TOAST_EVENT, handler);
      if ((window as any)[TOAST_OWNER_KEY] === ownerId) {
        delete (window as any)[TOAST_OWNER_KEY];
      }
    };
  }, []);

  if (!isOwner) return null;

  return (
    <div
      dir="rtl"
      aria-live="polite"
      aria-atomic="false"
      style={{
        position: 'fixed',
        top: 18,
        right: 18,
        zIndex: 2147483647,
        display: 'flex',
        width: 'min(390px, calc(100vw - 36px))',
        flexDirection: 'column',
        gap: 10,
        pointerEvents: 'none',
        fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Tahoma,sans-serif',
      }}>
      {items.map(item => {
        const colors = palette(item.variant);
        return (
          <div
            key={item.id}
            role="status"
            style={{
              position: 'relative',
              overflow: 'hidden',
              padding: '13px 14px 12px',
              borderRadius: 14,
              border: `1px solid ${colors.border}`,
              background: colors.background,
              color: '#f8fafc',
              boxShadow: '0 18px 45px rgba(0,0,0,.42)',
              pointerEvents: 'auto',
              animation: `mcp-toast-life ${item.durationMs}ms ease both`,
            }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div
                aria-hidden="true"
                style={{
                  display: 'flex',
                  width: 24,
                  height: 24,
                  flexShrink: 0,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 999,
                  background: `${colors.accent}22`,
                  color: colors.accent,
                  fontSize: 14,
                  fontWeight: 900,
                }}>
                {colors.icon}
              </div>

              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 850, lineHeight: 1.55 }}>{item.title}</div>
                {item.message && (
                  <div style={{ marginTop: 3, color: '#cbd5e1', fontSize: 12, lineHeight: 1.7 }}>
                    {item.message}
                  </div>
                )}
              </div>

              <button
                type="button"
                aria-label="بستن اعلان"
                onClick={() => setItems(current => current.filter(entry => entry.id !== item.id))}
                style={{
                  width: 24,
                  height: 24,
                  flexShrink: 0,
                  border: 0,
                  borderRadius: 7,
                  background: 'transparent',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  fontSize: 17,
                  lineHeight: '24px',
                }}>
                ×
              </button>
            </div>

            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                right: 0,
                bottom: 0,
                height: 3,
                width: '100%',
                transformOrigin: 'right center',
                background: colors.accent,
                animation: `mcp-toast-progress ${item.durationMs}ms linear both`,
              }}
            />
          </div>
        );
      })}

      <style>{`
        @keyframes mcp-toast-life {
          0% { opacity: 0; transform: translateY(-10px) scale(.98); }
          5% { opacity: 1; transform: translateY(0) scale(1); }
          90% { opacity: 1; transform: translateY(0) scale(1); }
          100% { opacity: 0; transform: translateY(-8px) scale(.985); }
        }
        @keyframes mcp-toast-progress {
          from { transform: scaleX(1); }
          to { transform: scaleX(0); }
        }
      `}</style>
    </div>
  );
}
