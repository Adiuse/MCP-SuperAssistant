import React, { useEffect, useMemo, useState } from 'react';

type AuditFilter = 'all' | 'allowed' | 'blocked';

type AuditAction =
  | 'access_requested'
  | 'session_started'
  | 'session_revoked'
  | 'session_expired'
  | 'tool_allowed'
  | 'tool_denied'
  | 'response_allowed'
  | 'response_denied'
  | 'notification_sent'
  | 'notification_failed';

interface CodeReviewSession {
  id: string;
  owner: string;
  repo: string;
  approvedTabId: number;
  startedAt: number;
  expiresAt: number;
  durationMinutes: 5 | 10 | 20;
  callCount: number;
  responseBytes: number;
}

interface CodeReviewAuditEntry {
  timestamp: number;
  action: AuditAction;
  sessionId?: string;
  toolName?: string;
  owner?: string;
  repo?: string;
  reason?: string;
  tabId?: number;
  responseBytes?: number;
  argKeys?: string[];
  resource?: string;
}

interface StatusResponse {
  success: boolean;
  session?: CodeReviewSession | null;
  error?: string;
}

interface AuditResponse {
  success: boolean;
  entries?: CodeReviewAuditEntry[];
  error?: string;
}

const MAX_CALLS = 200;
const MAX_SESSION_BYTES = 25 * 1024 * 1024;

async function sendSecurityMessage<T>(message: Record<string, unknown>): Promise<T> {
  return await chrome.runtime.sendMessage(message) as T;
}

function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatClock(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleTimeString();
  }
}

function actionLabel(action: AuditAction): string {
  switch (action) {
    case 'access_requested': return 'درخواست دسترسی';
    case 'session_started': return 'شروع نشست';
    case 'session_revoked': return 'لغو نشست';
    case 'session_expired': return 'پایان نشست';
    case 'tool_allowed': return 'درخواست ابزار';
    case 'tool_denied': return 'درخواست مسدودشده';
    case 'response_allowed': return 'خروجی مجاز';
    case 'response_denied': return 'خروجی مسدودشده';
    case 'notification_sent': return 'نوتیفیکیشن ارسال شد';
    case 'notification_failed': return 'خطای نوتیفیکیشن';
    default: return action;
  }
}

function statusForEntry(entry: CodeReviewAuditEntry): 'allow' | 'deny' | 'info' {
  if (entry.action === 'tool_denied' || entry.action === 'response_denied' || entry.action === 'notification_failed') {
    return 'deny';
  }
  if (entry.action === 'tool_allowed' || entry.action === 'response_allowed') {
    return 'allow';
  }
  return 'info';
}

function entryPrimaryText(entry: CodeReviewAuditEntry): string {
  if (entry.toolName) return entry.toolName;
  return actionLabel(entry.action);
}

function entrySecondaryText(entry: CodeReviewAuditEntry): string {
  if (entry.resource) return entry.resource;
  if (entry.owner && entry.repo) return `${entry.owner}/${entry.repo}`;
  if (entry.responseBytes !== undefined) return formatBytes(entry.responseBytes);
  if (entry.reason) return entry.reason;
  return '—';
}

export function SecurityCenterFa() {
  const [session, setSession] = useState<CodeReviewSession | null>(null);
  const [entries, setEntries] = useState<CodeReviewAuditEntry[]>([]);
  const [filter, setFilter] = useState<AuditFilter>('all');
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadDashboard = async () => {
    try {
      const [status, audit] = await Promise.all([
        sendSecurityMessage<StatusResponse>({ type: 'code-review:get-status' }),
        sendSecurityMessage<AuditResponse>({ type: 'code-review:get-audit' }),
      ]);

      if (!status.success) throw new Error(status.error || 'دریافت وضعیت نشست ناموفق بود.');
      if (!audit.success) throw new Error(audit.error || 'دریافت لاگ امنیتی ناموفق بود.');

      setSession(status.session || null);
      setEntries(Array.isArray(audit.entries) ? audit.entries : []);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'دریافت اطلاعات مرکز امنیت ناموفق بود.');
    }
  };

  useEffect(() => {
    void loadDashboard();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => void loadDashboard(), 5000);

    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
  }, []);

  const blockedCount = useMemo(
    () => entries.filter(entry => statusForEntry(entry) === 'deny').length,
    [entries],
  );

  const filteredEntries = useMemo(() => {
    const selected = entries.filter(entry => {
      const status = statusForEntry(entry);
      if (filter === 'allowed') return status === 'allow';
      if (filter === 'blocked') return status === 'deny';
      return true;
    });

    return selected.slice(-20).reverse();
  }, [entries, filter]);

  const remaining = session ? Math.max(0, session.expiresAt - now) : 0;
  const callPercent = session ? Math.min(100, (session.callCount / MAX_CALLS) * 100) : 0;
  const bytePercent = session ? Math.min(100, (session.responseBytes / MAX_SESSION_BYTES) * 100) : 0;

  const clearAudit = async () => {
    setLoading(true);
    try {
      const response = await sendSecurityMessage<AuditResponse>({ type: 'code-review:clear-audit' });
      if (!response.success) throw new Error(response.error || 'پاک‌کردن لاگ ناموفق بود.');
      setEntries([]);
      setError('');
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'پاک‌کردن لاگ ناموفق بود.');
    } finally {
      setLoading(false);
    }
  };

  const revoke = async () => {
    setLoading(true);
    try {
      const response = await sendSecurityMessage<StatusResponse>({ type: 'code-review:revoke' });
      if (!response.success) throw new Error(response.error || 'لغو دسترسی ناموفق بود.');
      setSession(null);
      setError('');
      await loadDashboard();
      try {
        await chrome.runtime.sendMessage({ type: 'mcp:force-reconnect', payload: {} });
      } catch {
        // Gate state is already authoritative; reconnect can happen later.
      }
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'لغو دسترسی ناموفق بود.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      id="mcp-security-center"
      dir="rtl"
      className="rounded-xl border border-slate-200 bg-white p-4 text-right shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold">🛡️ مرکز امنیت</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            وضعیت دسترسی موقت، هشدارها و رویدادهای امنیتی Code Review را از همین‌جا کنترل کنید.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadDashboard()}
          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold dark:border-slate-600">
          بروزرسانی
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="text-xs text-slate-500 dark:text-slate-400">وضعیت نشست</div>
          <div className={`mt-1 text-sm font-bold ${session ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}`}>
            {session ? '🟢 فعال' : '⚪ خاموش'}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="text-xs text-slate-500 dark:text-slate-400">هشدارهای مسدودشده</div>
          <div className={`mt-1 text-sm font-bold ${blockedCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
            {blockedCount > 0 ? `⚠ ${blockedCount}` : '✓ ۰'}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-900/70">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-slate-500 dark:text-slate-400">Repository</span>
          <span dir="ltr" className="max-w-[65%] truncate font-mono font-semibold">
            {session ? `${session.owner}/${session.repo}` : '—'}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 text-xs">
          <span className="text-slate-500 dark:text-slate-400">زمان باقی‌مانده</span>
          <span dir="ltr" className="font-mono font-bold">{session ? formatRemaining(remaining) : '00:00'}</span>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="flex items-center justify-between text-xs">
            <span>تعداد فراخوانی</span>
            <span dir="ltr" className="font-mono">{session?.callCount || 0} / {MAX_CALLS}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div className="h-full rounded-full bg-current text-slate-700 dark:text-slate-300" style={{ width: `${callPercent}%` }} />
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="flex items-center justify-between text-xs">
            <span>حجم مصرف‌شده</span>
            <span dir="ltr" className="font-mono">{formatBytes(session?.responseBytes || 0)} / 25 MB</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div className="h-full rounded-full bg-current text-slate-700 dark:text-slate-300" style={{ width: `${bytePercent}%` }} />
          </div>
        </div>
      </div>

      {session && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void revoke()}
          className="mt-3 w-full rounded-lg border border-red-300 px-3 py-2 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950">
          لغو فوری دسترسی
        </button>
      )}

      <div className="mt-5 flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-bold">Security Log</div>
          <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">آخرین ۲۰ رویداد مطابق فیلتر</div>
        </div>
        <button
          type="button"
          disabled={loading || entries.length === 0}
          onClick={() => void clearAudit()}
          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-50 dark:border-slate-600">
          پاک‌کردن لاگ
        </button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900">
        {([
          ['all', 'همه'],
          ['allowed', 'مجاز'],
          ['blocked', 'مسدود'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`rounded-md px-2 py-1.5 text-[11px] font-semibold ${
              filter === value
                ? 'bg-white shadow-sm dark:bg-slate-700'
                : 'text-slate-500 dark:text-slate-400'
            }`}>
            {label}
          </button>
        ))}
      </div>

      <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-0.5">
        {filteredEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            رویدادی برای نمایش وجود ندارد.
          </div>
        ) : (
          filteredEntries.map((entry, index) => {
            const status = statusForEntry(entry);
            return (
              <div
                key={`${entry.timestamp}-${entry.action}-${entry.toolName || index}`}
                className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex items-center justify-between gap-2">
                  <span dir="ltr" className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    {formatClock(entry.timestamp)}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      status === 'deny'
                        ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                        : status === 'allow'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                          : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
                    }`}>
                    {status === 'deny' ? 'DENY' : status === 'allow' ? 'ALLOW' : 'INFO'}
                  </span>
                </div>
                <div dir="ltr" className="mt-2 truncate text-left font-mono text-xs font-bold">
                  {entryPrimaryText(entry)}
                </div>
                <div dir="ltr" title={entrySecondaryText(entry)} className="mt-1 truncate text-left font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  {entrySecondaryText(entry)}
                </div>
                {status === 'deny' && entry.reason && (
                  <div className="mt-2 line-clamp-2 text-[11px] leading-5 text-red-600 dark:text-red-300">
                    {entry.reason}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className="mt-3 text-[10px] leading-5 text-slate-400">
        لاگ امنیتی فقط metadata عملیاتی را نگه می‌دارد؛ محتوای فایل‌ها، کد، توکن و credential ذخیره نمی‌شود.
      </p>
    </section>
  );
}
