import React, { useEffect, useMemo, useState } from 'react';
import { useMcpCommunication } from '../hooks/useMcpCommunication';
import { emitSecurityToast } from './mcpPopover/securityToast';

type DurationMinutes = 5 | 10 | 20;

interface CodeReviewPreferences {
  owner: string;
  repo: string;
  durationMinutes: DurationMinutes;
  updatedAt: number;
}

interface CodeReviewSession {
  id: string;
  owner: string;
  repo: string;
  approvedTabId: number;
  sourcePath?: string;
  sourceRequestId?: string;
  startedAt: number;
  expiresAt: number;
  durationMinutes: DurationMinutes;
  callCount: number;
  responseBytes: number;
}

interface PendingCodeReviewRequest {
  id: string;
  owner: string;
  repo: string;
  durationMinutes: DurationMinutes;
  requestedAt: number;
  sourcePath?: string;
  sourceTabId?: number;
}

interface ControlResponse {
  success: boolean;
  currentTabId?: number;
  session?: CodeReviewSession | null;
  settings?: CodeReviewPreferences | null;
  pendingRequests?: PendingCodeReviewRequest[];
  pendingRequest?: PendingCodeReviewRequest | null;
  rejected?: PendingCodeReviewRequest | null;
  error?: string;
}

const DURATIONS: DurationMinutes[] = [5, 10, 20];
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

async function sendControlMessage<T = ControlResponse>(message: Record<string, unknown>): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

function currentConversationPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function formatRequestedAt(timestamp: number): string {
  if (!timestamp) return 'زمان نامشخص';
  try {
    return new Intl.DateTimeFormat('fa-IR', {
      hour: '2-digit',
      minute: '2-digit',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function sourceLabel(request: PendingCodeReviewRequest): string {
  if (!request.sourcePath) return 'مبدأ نامشخص / درخواست قدیمی';
  if (request.sourcePath === currentConversationPath()) return 'همین گفتگو';
  return request.sourcePath;
}

export function CodeReviewAccessFa() {
  const { refreshTools } = useMcpCommunication();
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [duration, setDuration] = useState<DurationMinutes>(5);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [session, setSession] = useState<CodeReviewSession | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingCodeReviewRequest[]>([]);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const [requestActionId, setRequestActionId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const applyStatusResponse = (response: ControlResponse, hydrateSettings = false) => {
    setSession(response.session || null);
    setPendingRequests(
      Array.isArray(response.pendingRequests)
        ? response.pendingRequests
        : response.pendingRequest
          ? [response.pendingRequest]
          : [],
    );

    if (hydrateSettings && response.settings && !settingsDirty) {
      setOwner(response.settings.owner);
      setRepo(response.settings.repo);
      setDuration(response.settings.durationMinutes);
      setSettingsSaved(true);
    }
  };

  const loadStatus = async (hydrateSettings = false) => {
    try {
      const response = await sendControlMessage<ControlResponse>({ type: 'code-review:get-status' });
      if (!response.success) throw new Error(response.error || 'دریافت وضعیت دسترسی ناموفق بود.');
      applyStatusResponse(response, hydrateSettings);
      setError('');
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'دریافت وضعیت دسترسی ناموفق بود.');
    }
  };

  useEffect(() => {
    void loadStatus(true);

    const handlePendingUpdate = () => void loadStatus(false);
    window.addEventListener('code-review:pending-updated', handlePendingUpdate);

    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const statusPoll = window.setInterval(() => void loadStatus(false), 3000);

    return () => {
      window.removeEventListener('code-review:pending-updated', handlePendingUpdate);
      window.clearInterval(clock);
      window.clearInterval(statusPoll);
    };
  }, []);

  const remainingSeconds = useMemo(() => {
    if (!session) return 0;
    return Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
  }, [session, now]);

  const formatTime = (seconds: number) => {
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const markSettingsDirty = () => {
    setSettingsDirty(true);
    setSettingsSaved(false);
  };

  const validateRepository = (): boolean => {
    const cleanOwner = owner.trim();
    const cleanRepo = repo.trim();

    if (!cleanOwner || !cleanRepo) {
      setError('نام مالک GitHub و نام مخزن را وارد کنید.');
      return false;
    }
    if (!OWNER_PATTERN.test(cleanOwner)) {
      setError('نام مالک GitHub معتبر نیست.');
      return false;
    }
    if (!REPO_PATTERN.test(cleanRepo) || cleanRepo === '.' || cleanRepo === '..') {
      setError('نام مخزن معتبر نیست.');
      return false;
    }

    setError('');
    return true;
  };

  const saveSettings = async () => {
    if (!validateRepository()) return;

    setLoading(true);
    setError('');
    try {
      const response = await sendControlMessage<ControlResponse>({
        type: 'code-review:save-settings',
        payload: {
          owner: owner.trim(),
          repo: repo.trim(),
          durationMinutes: duration,
        },
      });
      if (!response.success || !response.settings) {
        throw new Error(response.error || 'ذخیره تنظیمات Code Review ناموفق بود.');
      }

      setOwner(response.settings.owner);
      setRepo(response.settings.repo);
      setDuration(response.settings.durationMinutes);
      setSettingsDirty(false);
      setSettingsSaved(true);
      await refreshTools(true).catch(() => []);

      emitSecurityToast({
        title: 'تنظیمات Code Review ذخیره شد',
        message: `${response.settings.owner}/${response.settings.repo} — ${response.settings.durationMinutes} دقیقه`,
        variant: 'success',
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'ذخیره تنظیمات Code Review ناموفق بود.');
    } finally {
      setLoading(false);
    }
  };

  const rejectPending = async (request: PendingCodeReviewRequest) => {
    setRequestActionId(request.id);
    setError('');
    try {
      const response = await sendControlMessage<ControlResponse>({
        type: 'code-review:reject',
        payload: { requestId: request.id },
      });
      if (!response.success) throw new Error(response.error || 'رد درخواست دسترسی ناموفق بود.');

      applyStatusResponse({ ...response, session });
      window.dispatchEvent(new CustomEvent('code-review:pending-updated'));
      emitSecurityToast({
        id: `rejected:${request.id}`,
        title: 'درخواست دسترسی رد شد',
        message: `${request.owner}/${request.repo} از صف تأیید حذف شد.`,
        variant: 'info',
      });
    } catch (rejectError) {
      setError(rejectError instanceof Error ? rejectError.message : 'رد درخواست دسترسی ناموفق بود.');
    } finally {
      setRequestActionId(null);
    }
  };

  const approvePending = async (request: PendingCodeReviewRequest) => {
    if (session) {
      setError('یک نشست Code Review فعال است. برای فعال‌سازی درخواست دیگری ابتدا نشست فعال را لغو کنید.');
      return;
    }

    setRequestActionId(request.id);
    setError('');
    try {
      const response = await sendControlMessage<ControlResponse>({
        type: 'code-review:approve',
        payload: { requestId: request.id },
      });
      if (!response.success || !response.session) {
        throw new Error(response.error || 'فعال‌سازی دسترسی ناموفق بود.');
      }

      applyStatusResponse(response);
      await refreshTools(true).catch(() => []);
      window.dispatchEvent(new CustomEvent('code-review:pending-updated'));

      const isOriginConversation = !request.sourcePath || request.sourcePath === currentConversationPath();
      emitSecurityToast({
        id: `approved:${request.id}`,
        title: 'دسترسی Code Review فعال شد',
        message: isOriginConversation
          ? `${request.owner}/${request.repo} فعال شد؛ ادامه کار در همین گفت‌وگو به‌صورت خودکار انجام می‌شود.`
          : `${request.owner}/${request.repo} فعال شد؛ گفت‌وگوی مبدأ به‌صورت خودکار ادامه می‌دهد.`,
        variant: 'success',
        durationMs: 6500,
      });
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'فعال‌سازی دسترسی ناموفق بود.');
    } finally {
      setRequestActionId(null);
    }
  };

  const revoke = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await sendControlMessage<ControlResponse>({ type: 'code-review:revoke' });
      if (!response.success) throw new Error(response.error || 'لغو دسترسی ناموفق بود.');
      applyStatusResponse(response);
      await refreshTools(true).catch(() => []);
      window.dispatchEvent(new CustomEvent('code-review:pending-updated'));
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'لغو دسترسی ناموفق بود.');
    } finally {
      setLoading(false);
    }
  };

  const openSourceConversation = (request: PendingCodeReviewRequest) => {
    if (!request.sourcePath) return;
    window.open(`${window.location.origin}${request.sourcePath}`, '_blank', 'noopener,noreferrer');
  };

  const statusLabel = session
    ? '● فعال'
    : pendingRequests.length > 0
      ? `● ${pendingRequests.length} در انتظار`
      : '● خاموش';

  return (
    <section
      dir="rtl"
      className="rounded-xl border border-slate-200 bg-white p-4 text-right shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold">🔒 دسترسی بررسی کد</h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            مخزن و مدت را شما تعیین می‌کنید؛ مدل اجازه تغییر این دو مقدار را ندارد.
          </p>
        </div>
        <span
          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${
            session
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
              : pendingRequests.length > 0
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
          }`}>
          {statusLabel}
        </span>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/70">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-bold">تنظیمات درخواست Code Review</div>
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              درخواست‌های بعدی فقط برای همین مخزن و همین مدت ساخته می‌شوند.
            </div>
          </div>
          <span
            className={`rounded-full px-2 py-1 text-[10px] font-bold ${
              settingsSaved && !settingsDirty
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
            }`}>
            {settingsSaved && !settingsDirty ? 'ذخیره‌شده' : 'نیاز به ذخیره'}
          </span>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">مالک GitHub</span>
            <input
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={owner}
              onChange={event => {
                setOwner(event.target.value);
                markSettingsDirty();
              }}
              placeholder="Adiuse"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-900 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">نام مخزن</span>
            <input
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={repo}
              onChange={event => {
                setRepo(event.target.value);
                markSettingsDirty();
              }}
              placeholder="cybersecurity"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-900 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>
        </div>

        <div className="mt-3">
          <div className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">مدت هر تأیید</div>
          <div className="grid grid-cols-3 gap-2">
            {DURATIONS.map(item => (
              <button
                type="button"
                key={item}
                disabled={loading}
                onClick={() => {
                  setDuration(item);
                  markSettingsDirty();
                }}
                className={`rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:opacity-60 ${
                  duration === item
                    ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800'
                }`}>
                {item} دقیقه
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          disabled={loading || (!settingsDirty && settingsSaved)}
          onClick={() => void saveSettings()}
          className="mt-3 w-full rounded-lg bg-slate-950 px-4 py-2 text-sm font-bold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-slate-950">
          {loading ? 'در حال ذخیره...' : settingsSaved && !settingsDirty ? 'تنظیمات ذخیره شده' : 'ذخیره تنظیمات'}
        </button>
      </div>

      {session && (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/40">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm text-slate-600 dark:text-slate-300">نشست فعال</div>
                <div dir="ltr" className="mt-1 text-left font-mono text-sm font-semibold">
                  {session.owner}/{session.repo}
                </div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  مدت تأیید: {session.durationMinutes} دقیقه
                </div>
              </div>
              <span dir="ltr" className="font-mono text-lg font-bold">
                {formatTime(remainingSeconds)}
              </span>
            </div>
            {session.sourcePath && (
              <div dir="ltr" className="mt-2 truncate text-left font-mono text-[11px] text-slate-500 dark:text-slate-400">
                {session.sourcePath}
              </div>
            )}
            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              فقط ابزارهای مجاز Read-only فعال‌اند؛ تمدید خودکار انجام نمی‌شود.
            </div>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => void revoke()}
            className="w-full rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950">
            {loading ? 'در حال لغو...' : 'لغو فوری دسترسی'}
          </button>
        </div>
      )}

      {pendingRequests.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50/70 p-3 dark:border-amber-800 dark:bg-amber-950/20">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-bold text-amber-950 dark:text-amber-200">درخواست‌های منتظر تأیید</div>
              <div className="mt-1 text-xs leading-5 text-amber-900/70 dark:text-amber-200/70">
                صف سراسری است؛ هر درخواست از هر گفت‌وگو قابل تأیید یا رد است.
              </div>
            </div>
            <span className="rounded-full bg-amber-200 px-2.5 py-1 text-xs font-bold text-amber-950 dark:bg-amber-900 dark:text-amber-100">
              {pendingRequests.length}
            </span>
          </div>

          <div className="mt-3 space-y-2">
            {pendingRequests.map((request, index) => {
              const busy = requestActionId === request.id;
              const isCurrent = request.sourcePath === currentConversationPath();
              return (
                <article
                  key={request.id}
                  className="rounded-lg border border-amber-200 bg-white p-3 dark:border-amber-900 dark:bg-slate-900">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                        #{index + 1}
                      </span>
                      {isCurrent && (
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                          همین گفتگو
                        </span>
                      )}
                    </div>
                    <div dir="ltr" className="mt-2 truncate text-left font-mono text-sm font-bold">
                      {request.owner}/{request.repo}
                    </div>
                    <div className="mt-2 grid gap-1 text-xs text-slate-600 dark:text-slate-300 sm:grid-cols-2">
                      <div>مدت: <strong>{request.durationMinutes} دقیقه</strong></div>
                      <div>درخواست: <strong>{formatRequestedAt(request.requestedAt)}</strong></div>
                    </div>
                    <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      مبدأ: <span dir="ltr" className="font-mono">{sourceLabel(request)}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || Boolean(session)}
                      onClick={() => void approvePending(request)}
                      className="flex-1 rounded-lg bg-slate-950 px-3 py-2 text-xs font-bold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-slate-950">
                      {busy ? 'در حال پردازش...' : session ? 'نشست دیگری فعال است' : 'تأیید و فعال‌سازی'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void rejectPending(request)}
                      className="rounded-lg border border-red-300 px-3 py-2 text-xs font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950">
                      رد
                    </button>
                    {request.sourcePath && !isCurrent && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => openSourceConversation(request)}
                        className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 dark:border-slate-600 dark:text-slate-300">
                        باز کردن مبدأ
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
