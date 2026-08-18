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
  startedAt: number;
  expiresAt: number;
  durationMinutes: DurationMinutes;
  callCount: number;
  responseBytes: number;
}

interface PendingCodeReviewRequest {
  owner: string;
  repo: string;
  durationMinutes: DurationMinutes;
}

interface ControlResponse {
  success: boolean;
  session?: CodeReviewSession | null;
  pendingRequest?: PendingCodeReviewRequest | null;
  error?: string;
}

const DURATIONS: DurationMinutes[] = [5, 10, 20];
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

async function sendControlMessage<T = ControlResponse>(message: Record<string, unknown>): Promise<T> {
  return await chrome.runtime.sendMessage(message) as T;
}

async function refreshMcpTools(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'mcp:force-reconnect', payload: {} });
  } catch {
    // The security state is already persisted. A later MCP refresh/reconnect will
    // pick it up even if the immediate refresh fails.
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

export function CodeReviewAccessFa() {
  const { insertText, submitForm, isReady: isAdapterReady } = useCurrentAdapter();
  const { refreshTools } = useMcpCommunication();
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [duration, setDuration] = useState<DurationMinutes>(10);
  const [session, setSession] = useState<CodeReviewSession | null>(null);
  const [now, setNow] = useState(Date.now());
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = async () => {
    try {
      const response = await sendControlMessage<ControlResponse>({ type: 'code-review:get-status' });
      if (!response.success) {
        throw new Error(response.error || 'دریافت وضعیت دسترسی ناموفق بود.');
      }

      const activeSession = response.session || null;
      const pendingRequest = response.pendingRequest || null;

      setSession(activeSession);

      if (activeSession) {
        setConfirming(false);
      } else if (pendingRequest) {
        setOwner(pendingRequest.owner);
        setRepo(pendingRequest.repo);
        setDuration(pendingRequest.durationMinutes);
        setConfirming(true);
      }
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'دریافت وضعیت دسترسی ناموفق بود.');
    }
  };

  useEffect(() => {
    void loadStatus();

    const handlePendingUpdate = () => void loadStatus();
    window.addEventListener('code-review:pending-updated', handlePendingUpdate);

    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const statusPoll = window.setInterval(() => void loadStatus(), 5000);

    return () => {
      window.removeEventListener('code-review:pending-updated', handlePendingUpdate);
      window.clearInterval(clock);
      window.clearInterval(statusPoll);
    };
  }, []);

  useEffect(() => {
    if (session && now >= session.expiresAt) {
      setSession(null);
      setConfirming(false);
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

      if (!response.success) {
        throw new Error(response.error || 'ثبت درخواست دسترسی ناموفق بود.');
      }

      setConfirming(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'ثبت درخواست دسترسی ناموفق بود.');
    } finally {
      setLoading(false);
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
      if (!inserted) {
        throw new Error('درج پیام ادامه در چت ناموفق بود.');
      }

      const submitted = await submitForm();
      if (!submitted) {
        throw new Error('ارسال خودکار پیام ادامه ناموفق بود.');
      }

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

  const approve = async () => {
    if (!validateRepository()) return;

    setLoading(true);
    setError('');
    try {
      const response = await sendControlMessage<ControlResponse>({
        type: 'code-review:approve',
        payload: {
          owner: owner.trim(),
          repo: repo.trim(),
          durationMinutes: duration,
        },
      });

      if (!response.success || !response.session) {
        throw new Error(response.error || 'فعال‌سازی دسترسی ناموفق بود.');
      }

      setSession(response.session);
      setConfirming(false);
      await resumeApprovedReview(response.session);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'فعال‌سازی دسترسی ناموفق بود.');
    } finally {
      setLoading(false);
    }
  };

  const revoke = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await sendControlMessage<ControlResponse>({ type: 'code-review:revoke' });
      if (!response.success) {
        throw new Error(response.error || 'لغو دسترسی ناموفق بود.');
      }
      setSession(null);
      setConfirming(false);
      await refreshMcpTools();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'لغو دسترسی ناموفق بود.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      dir="rtl"
      className="rounded-xl border border-slate-200 bg-white p-4 text-right shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold">🔒 دسترسی بررسی کد</h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            دسترسی پیش‌فرض خاموش است و فقط پس از تأیید شما، برای همان مخزن و مدت انتخاب‌شده فعال می‌شود.
          </p>
        </div>
        <span
          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${
            session
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
              : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
          }`}>
          {session ? '● فعال' : '● خاموش'}
        </span>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {session ? (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/40">
            <div className="text-sm text-slate-600 dark:text-slate-300">مخزن مجاز</div>
            <div dir="ltr" className="mt-1 text-left font-mono text-sm font-semibold">
              {session.owner}/{session.repo}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-sm text-slate-600 dark:text-slate-300">زمان باقی‌مانده</span>
              <span dir="ltr" className="font-mono text-lg font-bold">
                {formatTime(remainingSeconds)}
              </span>
            </div>
            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              فقط ابزارهای مجاز Code Review در دسترس هستند؛ تمدید خودکار انجام نمی‌شود.
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
      ) : confirming ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
          <div className="font-bold text-amber-900 dark:text-amber-200">تأیید نهایی دسترسی</div>
          <p className="mt-2 text-sm text-amber-900/80 dark:text-amber-200/80">
            درخواست ثبت شد. قبل از فعال‌سازی، مشخصات زیر را بررسی کنید. بعد از پایان زمان، دسترسی خودکار منقضی می‌شود و تمدید نیاز به تأیید دوباره شما دارد.
          </p>

          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt>مخزن:</dt>
              <dd dir="ltr" className="font-mono font-semibold">{owner.trim()}/{repo.trim()}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt>مدت:</dt>
              <dd className="font-semibold">{duration} دقیقه</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt>حالت:</dt>
              <dd className="font-semibold">فقط بررسی کد — Read-only</dd>
            </div>
          </dl>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => void approve()}
              className="flex-1 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-slate-950">
              {loading ? 'در حال فعال‌سازی...' : 'تأیید و فعال‌سازی'}
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => setConfirming(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold dark:border-slate-600">
              انصراف
            </button>
          </div>
        </div>
      ) : (
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
