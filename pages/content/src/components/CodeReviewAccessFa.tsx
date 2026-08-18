import React, { useEffect, useMemo, useState } from 'react';
import { useCurrentAdapter } from '../hooks';
import { useMcpCommunication } from '../hooks/useMcpCommunication';
import { instructionsState } from './sidebar/Instructions/InstructionManager';
import { emitSecurityToast } from './mcpPopover/securityToast';

type DurationMinutes = 5 | 10 | 20;

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
  session?: CodeReviewSession | null;
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

async function refreshMcpTools(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'mcp:force-reconnect', payload: {} });
  } catch {
    // Security state is already persisted. A later refresh can recover the tool list.
  }
}

async function waitForRefreshedInstructions(timeoutMs = 3500): Promise<string> {
  const startedAt = Date.now();
  let latest = instructionsState.instructions || '';

  while (Date.now() - startedAt < timeoutMs) {
    latest = instructionsState.instructions || latest;
    if (/###\s+(get_file_contents|search_code|get_repository_tree|list_commits)\b/.test(latest)) {
      return latest;
    }
    await new Promise(resolve => window.setTimeout(resolve, 100));
  }

  return latest;
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
  const { insertText, submitForm, isReady: isAdapterReady } = useCurrentAdapter();
  const { refreshTools } = useMcpCommunication();
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [duration, setDuration] = useState<DurationMinutes>(10);
  const [session, setSession] = useState<CodeReviewSession | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingCodeReviewRequest[]>([]);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const [requestActionId, setRequestActionId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const applyStatusResponse = (response: ControlResponse) => {
    setSession(response.session || null);
    setPendingRequests(
      Array.isArray(response.pendingRequests)
        ? response.pendingRequests
        : response.pendingRequest
          ? [response.pendingRequest]
          : [],
    );
  };

  const loadStatus = async () => {
    try {
      const response = await sendControlMessage<ControlResponse>({ type: 'code-review:get-status' });
      if (!response.success) throw new Error(response.error || 'دریافت وضعیت دسترسی ناموفق بود.');
      applyStatusResponse(response);
      setError('');
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'دریافت وضعیت دسترسی ناموفق بود.');
    }
  };

  useEffect(() => {
    void loadStatus();

    const handlePendingUpdate = () => void loadStatus();
    window.addEventListener('code-review:pending-updated', handlePendingUpdate);

    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const statusPoll = window.setInterval(() => void loadStatus(), 3000);

    return () => {
      window.removeEventListener('code-review:pending-updated', handlePendingUpdate);
      window.clearInterval(clock);
      window.clearInterval(statusPoll);
    };
  }, []);

  useEffect(() => {
    if (session && now >= session.expiresAt) {
      setSession(null);
      void loadStatus();
      void refreshMcpTools();
    }
  }, [now, session]);

  const remainingSeconds = useMemo(() => {
    if (!session) return 0;
    return Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
  }, [session, now]);

  const formatTime = (seconds: number) => {
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
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

  const requestConfirmation = async () => {
    if (!validateRepository()) return;

    setLoading(true);
    setError('');
    try {
      const response = await sendControlMessage<ControlResponse>({
        type: 'code-review:request',
        payload: {
          owner: owner.trim(),
          repo: repo.trim(),
          durationMinutes: duration,
        },
      });
      if (!response.success) throw new Error(response.error || 'ثبت درخواست دسترسی ناموفق بود.');
      await loadStatus();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'ثبت درخواست دسترسی ناموفق بود.');
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

  const resumeApprovedReview = async (approvedSession: CodeReviewSession) => {
    try {
      await refreshMcpTools();
      await refreshTools(true);

      const updatedInstructions = await waitForRefreshedInstructions();
      if (!isAdapterReady || !updatedInstructions.trim()) {
        emitSecurityToast({
          title: 'دسترسی فعال شد، ادامه خودکار انجام نشد',
          message: 'ابزارهای GitHub فعال هستند اما آداپتر چت برای ادامه خودکار آماده نبود.',
          variant: 'warning',
        });
        return;
      }

      const continuation = `${updatedInstructions}\n\n[MCP Approval Result] Code Review access is now approved and active for ${approvedSession.owner}/${approvedSession.repo}. Continue the user's pending repository task now using the newly available read-only MCP tools. Do not request access again unless this session expires or is revoked.`;
      const inserted = await insertText(continuation);
      if (!inserted) throw new Error('درج پیام ادامه در چت ناموفق بود.');

      const submitted = await submitForm();
      if (!submitted) throw new Error('ارسال خودکار پیام ادامه ناموفق بود.');

      emitSecurityToast({
        title: 'بررسی کد ادامه پیدا کرد',
        message: `${approvedSession.owner}/${approvedSession.repo} — ابزارهای Read-only به مدل اعلام شدند.`,
        variant: 'success',
      });
    } catch (resumeError) {
      emitSecurityToast({
        title: 'ادامه خودکار Code Review ناموفق بود',
        message: resumeError instanceof Error ? resumeError.message : String(resumeError),
        variant: 'warning',
        durationMs: 6500,
      });
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

      const isOriginConversation = !request.sourcePath || request.sourcePath === currentConversationPath();
      if (isOriginConversation) {
        await resumeApprovedReview(response.session);
      } else {
        emitSecurityToast({
          id: `approved-remote:${request.id}`,
          title: 'درخواست سشن دیگر تأیید شد',
          message: `${request.owner}/${request.repo} برای مبدأ ${sourceLabel(request)} فعال شد. این گفت‌وگو به‌جای سشن مبدأ ادامه داده نمی‌شود.`,
          variant: 'success',
          durationMs: 6500,
        });
      }
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
      await refreshMcpTools();
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
            همه درخواست‌های منتظر تأیید در تمام گفتگوها اینجا دیده می‌شوند و هر درخواست را می‌توانید مستقل تأیید یا رد کنید.
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

      {session && (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/40">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm text-slate-600 dark:text-slate-300">نشست فعال</div>
                <div dir="ltr" className="mt-1 text-left font-mono text-sm font-semibold">
                  {session.owner}/{session.repo}
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
              فقط ابزارهای مجاز Code Review فعال‌اند؛ تمدید خودکار انجام نمی‌شود.
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
                این صف سراسری است؛ لازم نیست برای پیدا کردن درخواست به گفتگوهای قبلی سر بزنید.
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
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
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

      {!session && pendingRequests.length === 0 && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">مالک GitHub</span>
              <input
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                value={owner}
                onChange={event => setOwner(event.target.value)}
                placeholder="مثال: Adiuse"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-900 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">نام مخزن</span>
              <input
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                value={repo}
                onChange={event => setRepo(event.target.value)}
                placeholder="مثال: MCP-SuperAssistant"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-900 outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">مدت دسترسی</div>
            <div className="grid grid-cols-3 gap-2">
              {DURATIONS.map(item => (
                <button
                  type="button"
                  key={item}
                  disabled={loading}
                  onClick={() => setDuration(item)}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:opacity-60 ${
                    duration === item
                      ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900'
                      : 'border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700'
                  }`}>
                  {item} دقیقه
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg bg-slate-50 p-3 text-xs leading-6 text-slate-600 dark:bg-slate-900 dark:text-slate-300">
            این مجوز فقط برای Code Review است. عملیات نوشتن، ساخت Fork و ابزارهای خارج از allowlist فعال نمی‌شوند.
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => void requestConfirmation()}
            className="w-full rounded-lg bg-slate-950 px-4 py-2.5 text-sm font-bold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-slate-950">
            {loading ? 'در حال ثبت درخواست...' : 'بررسی و ادامه برای تأیید'}
          </button>
        </div>
      )}
    </section>
  );
}
