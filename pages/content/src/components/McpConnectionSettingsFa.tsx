import type React from 'react';
import { useState } from 'react';
import { useMcpCommunication } from '../hooks/useMcpCommunication';

const SECURE_GATEWAY_URL = 'http://127.0.0.1:38106/mcp';

export const McpConnectionSettingsFa: React.FC = () => {
  const { connectionStatus, isConnected, forceReconnect } = useMcpCommunication();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const reconnect = async () => {
    setBusy(true);
    setMessage('در حال اتصال مجدد به Gateway امن...');
    try {
      const connected = await forceReconnect();
      setMessage(connected ? 'اتصال امن MCP برقرار شد ✓' : 'Gateway امن در دسترس نیست.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'اتصال مجدد ناموفق بود.');
    } finally {
      setBusy(false);
    }
  };

  const statusText = isConnected || connectionStatus === 'connected' ? 'متصل' : connectionStatus || 'نامشخص';
  const statusColor = isConnected || connectionStatus === 'connected' ? '#22c55e' : '#f59e0b';

  return (
    <section
      dir="rtl"
      style={{
        border: '1px solid var(--mcp-connection-border, #3f3f46)',
        borderRadius: 14,
        padding: 14,
        background: 'rgba(15, 23, 42, 0.22)',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 850, fontSize: 16 }}>🔌 اتصال امن MCP</div>
          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
            Endpoint و Transport بخشی از مرز امنیتی‌اند و قابل تغییر نیستند.
          </div>
        </div>
        <span style={{ fontSize: 12, fontWeight: 800, color: statusColor }}>● {statusText}</span>
      </div>

      <dl dir="ltr" style={{ marginTop: 14, fontSize: 12, lineHeight: 1.8 }}>
        <div>
          <dt style={{ display: 'inline', opacity: 0.65 }}>URL: </dt>
          <dd style={{ display: 'inline', fontFamily: 'monospace' }}>{SECURE_GATEWAY_URL}</dd>
        </div>
        <div>
          <dt style={{ display: 'inline', opacity: 0.65 }}>Transport: </dt>
          <dd style={{ display: 'inline', fontFamily: 'monospace' }}>Streamable HTTP</dd>
        </div>
        <div>
          <dt style={{ display: 'inline', opacity: 0.65 }}>Policy: </dt>
          <dd style={{ display: 'inline', fontFamily: 'monospace' }}>Prompt-bound / Read-only / Fail-closed</dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={event => {
          if (!event.nativeEvent.isTrusted) return;
          void reconnect();
        }}
        disabled={busy}
        style={{
          marginTop: 12,
          borderRadius: 9,
          border: '1px solid #3b82f6',
          background: '#2563eb',
          color: '#fff',
          padding: '8px 12px',
          cursor: busy ? 'not-allowed' : 'pointer',
          fontSize: 12,
          fontWeight: 800,
        }}>
        {busy ? 'در حال اتصال...' : 'اتصال مجدد امن'}
      </button>

      {message && <div style={{ marginTop: 9, fontSize: 11, lineHeight: 1.7, opacity: 0.82 }}>{message}</div>}
    </section>
  );
};

export default McpConnectionSettingsFa;
