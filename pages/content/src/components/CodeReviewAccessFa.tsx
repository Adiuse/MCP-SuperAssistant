import React, { useEffect, useState } from 'react';

interface Props {
  owner?: string;
  repo?: string;
  onApprove?: (duration: number) => void;
  onRevoke?: () => void;
}

const durations = [5, 10, 20];

export function CodeReviewAccessFa({
  owner = '',
  repo = '',
  onApprove,
  onRevoke,
}: Props) {
  const [duration, setDuration] = useState(10);
  const [active, setActive] = useState(false);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!active) return;

    const timer = window.setInterval(() => {
      setRemaining(value => {
        if (value <= 1) {
          setActive(false);
          return 0;
        }
        return value - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [active]);

  const approve = () => {
    setActive(true);
    setRemaining(duration * 60);
    onApprove?.(duration);
  };

  const formatTime = (seconds: number) => {
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <section dir="rtl" className="rounded-xl border p-4 text-right bg-white shadow-sm">
      <h3 className="text-lg font-bold">🔒 دسترسی بررسی کد</h3>
      <p className="mt-2 text-sm text-gray-600">
        دسترسی فقط برای بررسی کد فعال می‌شود و پس از پایان زمان، خودکار لغو خواهد شد.
      </p>

      <div className="mt-4 rounded-lg bg-gray-50 p-3">
        <div>مخزن: {owner || '---'} / {repo || '---'}</div>
        <div className="mt-2">
          وضعیت: {active ? '🟢 فعال' : '🔴 خاموش'}
        </div>
        {active && (
          <div className="mt-2 font-semibold">
            زمان باقی‌مانده: {formatTime(remaining)}
          </div>
        )}
      </div>

      {!active ? (
        <>
          <div className="mt-4">
            <div className="mb-2 font-medium">مدت دسترسی:</div>
            <div className="flex gap-2" dir="rtl">
              {durations.map(item => (
                <button
                  key={item}
                  className={`rounded px-3 py-1 border ${duration === item ? 'font-bold' : ''}`}
                  onClick={() => setDuration(item)}>
                  {item} دقیقه
                </button>
              ))}
            </div>
          </div>

          <button
            className="mt-4 rounded-lg bg-black px-4 py-2 text-white"
            onClick={approve}>
            فعال‌سازی دسترسی
          </button>
        </>
      ) : (
        <button
          className="mt-4 rounded-lg border px-4 py-2"
          onClick={() => {
            setActive(false);
            setRemaining(0);
            onRevoke?.();
          }}>
          لغو فوری دسترسی
        </button>
      )}
    </section>
  );
}
