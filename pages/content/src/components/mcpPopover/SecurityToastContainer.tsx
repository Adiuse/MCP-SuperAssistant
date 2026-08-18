import { useEffect, useState } from 'react';
import { SECURITY_TOAST_EVENT, SecurityToastDetail } from './securityToast';

interface ToastItem extends SecurityToastDetail {
  id: string;
}

export function SecurityToastContainer() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<SecurityToastDetail>).detail;
      const id = detail.id || `${Date.now()}-${Math.random()}`;
      const item = { ...detail, id };

      setItems(current => [...current.slice(-3), item]);

      window.setTimeout(() => {
        setItems(current => current.filter(entry => entry.id !== id));
      }, detail.durationMs || 5000);
    };

    window.addEventListener(SECURITY_TOAST_EVENT, handler);
    return () => window.removeEventListener(SECURITY_TOAST_EVENT, handler);
  }, []);

  return (
    <div style={{ position: 'fixed', top: 20, left: 20, zIndex: 20000, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map(item => (
        <div
          key={item.id}
          style={{
            minWidth: 280,
            maxWidth: 420,
            padding: '12px 14px',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,.12)',
            background: item.variant === 'error' ? '#7f1d1d' : item.variant === 'success' ? '#065f46' : '#18181b',
            color: '#fff',
            boxShadow: '0 12px 30px rgba(0,0,0,.35)',
            animation: 'mcp-toast-in .2s ease-out',
          }}>
          <div style={{ fontWeight: 800 }}>{item.title}</div>
          {item.message && <div style={{ marginTop: 4, fontSize: 12 }}>{item.message}</div>}
        </div>
      ))}
      <style>{`@keyframes mcp-toast-in { from { opacity:0; transform:translateY(-8px) } to { opacity:1; transform:translateY(0) } }`}</style>
    </div>
  );
}
