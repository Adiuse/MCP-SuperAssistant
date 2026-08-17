import React, { useEffect } from 'react';
import { CodeReviewAccessFa } from '../CodeReviewAccessFa';
import { SecurityCenterFa } from '../SecurityCenterFa';

interface SidebarProps {
  initialPreferences?: unknown;
}

const Sidebar: React.FC<SidebarProps> = () => {
  useEffect(() => {
    const repairDetachedSidebar = () => {
      const manager = window.activeSidebarManager;
      const host = manager?.getShadowHost?.();

      if (host && !host.isConnected && document.body) {
        document.body.appendChild(host);

        if (manager?.getIsVisible?.()) {
          host.style.display = 'block';
          host.style.opacity = '1';
          host.style.transform = 'translateX(0) scale(1)';
          host.classList.add('initialized');
          host.classList.remove('hiding', 'showing');
        }
      }
    };

    repairDetachedSidebar();
    const intervalId = window.setInterval(repairDetachedSidebar, 500);

    return () => window.clearInterval(intervalId);
  }, []);

  const closeSidebar = () => {
    void window.activeSidebarManager?.hide();
  };

  return (
    <aside
      dir="rtl"
      className="pointer-events-auto fixed right-0 top-0 z-[2147483646] flex h-screen w-[380px] flex-col border-l border-slate-200 bg-slate-50 text-right shadow-2xl dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex flex-shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
        <div>
          <h1 className="text-base font-bold text-slate-900 dark:text-slate-100">مرکز امنیت بررسی کد</h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">دسترسی موقت و کنترل‌شده به GitHub</p>
        </div>

        <button
          type="button"
          onClick={closeSidebar}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-lg text-slate-500 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          aria-label="بستن پنل"
          title="بستن">
          ×
        </button>
      </header>

      <main className="flex-1 space-y-4 overflow-y-auto p-4">
        <CodeReviewAccessFa />
        <SecurityCenterFa />
      </main>
    </aside>
  );
};

export default Sidebar;
