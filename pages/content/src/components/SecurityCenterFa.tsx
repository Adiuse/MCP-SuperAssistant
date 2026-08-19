import React, { useEffect, useMemo, useState } from 'react';

type AuditFilter = 'all' | 'allowed' | 'blocked';
type AuditAction =
  | 'access_requested' | 'access_approved' | 'access_rejected'
  | 'session_started' | 'session_revoked' | 'session_expired'
  | 'job_started' | 'job_revoked' | 'job_expired' | 'new_user_turn_invalidated_old_job'
  | 'tool_allowed' | 'tool_denied' | 'response_allowed' | 'response_denied'
  | 'scope_violation' | 'notification_sent' | 'notification_failed';

interface CodeReviewSession {
  id: string;
  jobId?: string;
  userTurnId?: string;
  owner: string;
  repo: string;
  approvedTabId: number;
  sourcePath?: string;
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
  jobId?: string;
  userTurnId?: string;
  toolName?: string;
  owner?: string;
  repo?: string;
  reason?: string;
  tabId?: number;
  responseBytes?: number;
  resource?: string;
}

interface StatusResponse {
  success: boolean;
  session?: CodeReviewSession | null;
  originSession?: CodeReviewSession | null;
  sessions?: CodeReviewSession[];
  error?: string;
}
interface AuditResponse { success: boolean; entries?: CodeReviewAuditEntry[]; error?: string }

const MAX_CALLS = 200;
const MAX_SESSION_BYTES = 25 * 1024 * 1024;

async function sendSecurityMessage<T>(message: Record<string, unknown>): Promise<T> {
  return await chrome.runtime.sendMessage(message) as T;
}

function formatRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function formatClock(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(timestamp));
  } catch { return new Date(timestamp).toLocaleTimeString(); }
}
function shortId(value?: string): string { return value ? value.slice(0, 8) : '—'; }

function actionLabel(action: AuditAction): string {
  switch (action) {
    case 'access_requested': return 'درخواست دسترسی';
    case 'access_approved': return 'تأیید دسترسی';
    case 'access_rejected': return 'رد دسترسی';
    case 'session_started': return 'شروع نشست';
    case 'session_revoked': return 'لغو نشست';
    case 'session_expired': return 'پایان نشست';
    case 'job_started': return 'شروع Job';
    case 'job_revoked': return 'لغو Job';
    case 'job_expired': return 'پایان Job';
    case 'new_user_turn_invalidated_old_job': return 'Prompt جدید؛ Job قبلی باطل شد';
    case 'tool_allowed': return 'درخواست ابزار';
    case 'tool_denied': return 'درخواست مسدودشده';
    case 'response_allowed': return 'خروجی مجاز';
    case 'response_denied': return 'خروجی مسدودشده';
    case 'scope_violation': return 'تخطی از Scope';
    case 'notification_sent': return 'اعلان داخلی ثبت شد';
    case 'notification_failed': return 'خطای اعلان داخلی';
    default: return action;
  }
}
function statusForEntry(entry: CodeReviewAuditEntry): 'allow' | 'deny' | 'info' {
  if (['tool_denied', 'response_denied', 'notification_failed', 'scope_violation'].includes(entry.action)) return 'deny';
  if (['tool_allowed', 'response_allowed', 'access_approved'].includes(entry.action)) return 'allow';
  return 'info';
}
function entryPrimaryText(entry: CodeReviewAuditEntry): string { return entry.toolName || actionLabel(entry.action); }
function entrySecondaryText(entry: CodeReviewAuditEntry): string {
  if (entry.resource) return entry.resource;
  if (entry.owner && entry.repo) return `${entry.owner}/${entry.repo}`;
  if (entry.responseBytes !== undefined) return formatBytes(entry.responseBytes);
  return entry.reason || '—';
}

export function SecurityCenterFa() {
  const [originSession, setOriginSession] = useState<CodeReviewSession | null>(null);
  const [sessions, setSessions] = useState<CodeReviewSession[]>([]);
  const [entries, setEntries] = useState<CodeReviewAuditEntry[]>([]);
  const [filter, setFilter] = useState<AuditFilter>('all');
  const [now, setNow] = useState(Date.now());
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadDashboard = async () => {
    try {
      const [status, audit] = await Promise.all([
        sendSecurityMessage<StatusResponse>({ type: 'code-review:get-status' }),
        sendSecurityMessage<AuditResponse>({ type: 'code-review:get-audit' }),
      ]);
      if (!status.success) throw new Error(status.error || 'دریافت وضعیت نشست ناموفق بود.');
      if (!audit.success) throw new Error(audit.error || 'دریافت لاگ امنیتی ناموفق بود.');
      setOriginSession(status.originSession || status.session || null);
      setSessions(Array.isArray(status.sessions) ? status.sessions : status.session ? [status.session] : []);
      setEntries(Array.isArray(audit.entries) ? audit.entries : []);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'دریافت اطلاعات مرکز امنیت ناموفق بود.');
    }
  };

  useEffect(() => {
    void loadDashboard();
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => void loadDashboard(), 3000);
    return () => { window.clearInterval(clock); window.clearInterval(poll); };
  }, []);

  const blockedCount = useMemo(() => entries.filter(entry => statusForEntry(entry) === 'deny').length, [entries]);
  const filteredEntries = useMemo(() => entries.filter(entry => {
    const status = statusForEntry(entry);
    if (filter === 'allowed') return status === 'allow';
    if (filter === 'blocked') return status === 'deny';
    return true;
  }).slice(-20).reverse(), [entries, filter]);

  const clearAudit = async () => {
    setLoadingId('audit');
    try {
      const response = await sendSecurityMessage<AuditResponse>({ type: 'code-review:clear-audit' });
      if (!response.success) throw new Error(response.error || 'پاک‌کردن لاگ ناموفق بود.');
      setEntries([]);
      setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'پاک‌کردن لاگ ناموفق بود.'); }
    finally { setLoadingId(null); }
  };

  const revoke = async (sessionId: string) => {
    setLoadingId(sessionId);
    try {
      const response = await sendSecurityMessage<StatusResponse>({
        type: 'code-review:revoke',
        payload: { sessionId },
      });
      if (!response.success) throw new Error(response.error || 'لغو دسترسی ناموفق بود.');
      setError('');
      await loadDashboard();
    } catch (e) { setError(e instanceof Error ? e.message : 'لغو دسترسی ناموفق بود.'); }
    finally { setLoadingId(null); }
  };

  return (
    <section id="mcp-security-center" dir="rtl" className="rounded-xl border border-slate-200 bg-white p-4 text-right shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold">🛡️ مرکز امنیت</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">هر Job به مخزن، Prompt واقعی، مبدأ و زمان مشخص متصل است.</p>
        </div>
        <button type="button" onClick={() => void loadDashboard()} className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold dark:border-slate-600">بروزرسانی</button>
      </div>

      {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{error}</div>}

      <div className="mt-4 grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"><div className="text-xs text-slate-500">Job همین گفتگو</div><div className={`mt-1 text-sm font-bold ${originSession ? 'text-emerald-600' : 'text-slate-500'}`}>{originSession ? '🟢 فعال' : '⚪ خاموش'}</div></div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"><div className="text-xs text-slate-500">Jobهای فعال</div><div className="mt-1 text-sm font-bold">{sessions.length}</div></div>
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"><div className="text-xs text-slate-500">مسدودشده</div><div className={`mt-1 text-sm font-bold ${blockedCount ? 'text-amber-600' : 'text-emerald-600'}`}>{blockedCount ? `⚠ ${blockedCount}` : '✓ ۰'}</div></div>
      </div>

      <div className="mt-4 space-y-2">
        {sessions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700">هیچ Job فعالی وجود ندارد.</div>
        ) : sessions.map(session => {
          const remaining = Math.max(0, session.expiresAt - now);
          const callPercent = Math.min(100, (session.callCount / MAX_CALLS) * 100);
          const bytePercent = Math.min(100, (session.responseBytes / MAX_SESSION_BYTES) * 100);
          const isOrigin = originSession?.id === session.id;
          return (
            <div key={session.id} className={`rounded-lg border p-3 ${isOrigin ? 'border-emerald-300 dark:border-emerald-800' : 'border-slate-200 dark:border-slate-700'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div dir="ltr" className="truncate text-left font-mono text-xs font-bold">{session.owner}/{session.repo}</div>
                  <div className="mt-1 text-[10px] text-slate-500">{isOrigin ? 'همین گفتگو' : session.sourcePath || `Tab ${session.approvedTabId}`} · Job {shortId(session.jobId)} · Turn {shortId(session.userTurnId)}</div>
                </div>
                <span dir="ltr" className="font-mono text-xs font-bold">{formatRemaining(remaining)}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                <div><div className="flex justify-between"><span>Call</span><span dir="ltr">{session.callCount}/{MAX_CALLS}</span></div><div className="mt-1 h-1 rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full rounded-full bg-current" style={{ width: `${callPercent}%` }} /></div></div>
                <div><div className="flex justify-between"><span>Data</span><span dir="ltr">{formatBytes(session.responseBytes)}/25 MB</span></div><div className="mt-1 h-1 rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full rounded-full bg-current" style={{ width: `${bytePercent}%` }} /></div></div>
              </div>
              <button type="button" disabled={loadingId === session.id} onClick={() => void revoke(session.id)} className="mt-3 w-full rounded-lg border border-red-300 px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-60 dark:border-red-800 dark:text-red-300">لغو فوری همین Job</button>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex items-center justify-between gap-2">
        <div><div className="text-sm font-bold">Security Log</div><div className="mt-0.5 text-[11px] text-slate-500">آخرین ۲۰ رویداد مطابق فیلتر</div></div>
        <button type="button" disabled={loadingId === 'audit' || entries.length === 0} onClick={() => void clearAudit()} className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-50 dark:border-slate-600">پاک‌کردن لاگ</button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900">
        {([['all','همه'],['allowed','مجاز'],['blocked','مسدود']] as const).map(([value,label]) => <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-md px-2 py-1.5 text-[11px] font-semibold ${filter === value ? 'bg-white shadow-sm dark:bg-slate-700' : 'text-slate-500 dark:text-slate-400'}`}>{label}</button>)}
      </div>
      <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-0.5">
        {filteredEntries.length === 0 ? <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700">رویدادی برای نمایش وجود ندارد.</div> : filteredEntries.map((entry,index) => {
          const status = statusForEntry(entry);
          return <div key={`${entry.timestamp}-${entry.action}-${entry.toolName || index}`} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex items-center justify-between gap-2"><span dir="ltr" className="font-mono text-[11px] text-slate-500">{formatClock(entry.timestamp)}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${status === 'deny' ? 'bg-red-100 text-red-700' : status === 'allow' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{status === 'deny' ? 'DENY' : status === 'allow' ? 'ALLOW' : 'INFO'}</span></div>
            <div dir="ltr" className="mt-2 truncate text-left font-mono text-xs font-bold">{entryPrimaryText(entry)}</div>
            <div dir="ltr" title={entrySecondaryText(entry)} className="mt-1 truncate text-left font-mono text-[11px] text-slate-500">{entrySecondaryText(entry)}</div>
            {(entry.jobId || entry.userTurnId) && <div dir="ltr" className="mt-1 text-left font-mono text-[10px] text-slate-400">job:{shortId(entry.jobId)} turn:{shortId(entry.userTurnId)}</div>}
            {status === 'deny' && entry.reason && <div className="mt-2 line-clamp-2 text-[11px] leading-5 text-red-600">{entry.reason}</div>}
          </div>;
        })}
      </div>
      <p className="mt-3 text-[10px] leading-5 text-slate-400">لاگ فقط metadata عملیاتی و شناسه‌های Job/Turn را نگه می‌دارد؛ محتوای فایل، PAT و capability secret ذخیره نمی‌شود.</p>
    </section>
  );
}
