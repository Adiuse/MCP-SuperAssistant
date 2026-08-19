import type React from 'react';
import { useEffect, useState } from 'react';
import { useMcpCommunication } from '../hooks/useMcpCommunication';
import type { ConnectionType } from '../types/stores';

const SECURE_GATEWAY_URL = 'http://127.0.0.1:38106/mcp';

export const McpConnectionSettingsFa: React.FC = () => {
  const {
    connectionStatus,
    isConnected,
    serverConfig,
    getServerConfig,
    updateServerConfig,
    forceReconnect,
  } = useMcpCommunication();

  const [uri, setUri] = useState(serverConfig.uri || SECURE_GATEWAY_URL);
  const [connectionType, setConnectionType] = useState<ConnectionType>(
    serverConfig.connectionType || 'streamable-http',
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;

    void getServerConfig()
      .then(config => {
        if (cancelled || !config) return;
        setUri(config.uri || SECURE_GATEWAY_URL);
        setConnectionType(config.connectionType || 'streamable-http');
      })
      .catch(() => {
        if (cancelled) return;
        setUri(current => current || SECURE_GATEWAY_URL);
        setConnectionType(current => current || 'streamable-http');
      });

    return () => {
      cancelled = true;
    };
  }, [getServerConfig]);

  useEffect(() => {
    if (serverConfig.uri) setUri(serverConfig.uri);
    if (serverConfig.connectionType) setConnectionType(serverConfig.connectionType);
  }, [serverConfig.connectionType, serverConfig.uri]);

  const validate = () => {
    const trimmed = uri.trim();
    if (!trimmed) return 'آدرس MCP نمی‌تواند خالی باشد.';

    try {
      const parsed = new URL(trimmed);
      if (connectionType === 'websocket') {
        if (!['ws:', 'wss:'].includes(parsed.protocol)) return 'برای WebSocket باید از ws:// یا wss:// استفاده شود.';
      } else if (!['http:', 'https:'].includes(parsed.protocol)) {
        return 'برای SSE / Streamable HTTP باید از http:// یا https:// استفاده شود.';
      }
    } catch {
      return 'آدرس MCP معتبر نیست.';
    }

    return '';
  };

  const saveAndReconnect = async () => {
    const validationError = validate();
    if (validationError) {
      setMessage(validationError);
      return;
    }

    setBusy(true);
    setMessage('در حال ذخیره و اتصال مجدد...');
    try {
      const saved = await updateServerConfig({
        uri: uri.trim(),
        connectionType,
      });
      if (!saved) throw new Error('ذخیره تنظیمات MCP ناموفق بود.');

      const connected = await forceReconnect();
      setMessage(connected ? 'اتصال MCP برقرار شد ✓' : 'تنظیمات ذخیره شد، اما اتصال برقرار نشد.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'خطا در ذخیره یا اتصال MCP.');
    } finally {
      setBusy(false);
    }
  };

  const useSecureGateway = () => {
    setUri(SECURE_GATEWAY_URL);
    setConnectionType('streamable-http');
    setMessage('Gateway امن انتخاب شد؛ برای اعمال، «ذخیره و اتصال مجدد» را بزنید.');
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
          <div style={{ fontWeight: 850, fontSize: 16 }}>🔌 اتصال MCP</div>
          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
            آدرس Gateway محلی و نوع Transport را همین‌جا تنظیم کنید.
          </div>
        </div>
        <span style={{ fontSize: 12, fontWeight: 800, color: statusColor }}>● {statusText}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 190px', gap: 10, marginTop: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 700 }}>
          Server URL
          <input
            dir="ltr"
            value={uri}
            onChange={event => setUri(event.target.value)}
            placeholder={SECURE_GATEWAY_URL}
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              borderRadius: 9,
              border: '1px solid #52525b',
              padding: '9px 10px',
              fontSize: 12,
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 700 }}>
          Transport
          <select
            value={connectionType}
            onChange={event => setConnectionType(event.target.value as ConnectionType)}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              borderRadius: 9,
              border: '1px solid #52525b',
              padding: '9px 10px',
              fontSize: 12,
            }}>
            <option value="streamable-http">Streamable HTTP</option>
            <option value="sse">SSE</option>
            <option value="websocket">WebSocket</option>
          </select>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 11, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={useSecureGateway}
          disabled={busy}
          style={{
            borderRadius: 9,
            border: '1px solid #52525b',
            padding: '8px 11px',
            cursor: busy ? 'not-allowed' : 'pointer',
            fontSize: 12,
            fontWeight: 750,
          }}>
          استفاده از Gateway امن
        </button>
        <button
          type="button"
          onClick={() => void saveAndReconnect()}
          disabled={busy}
          style={{
            borderRadius: 9,
            border: '1px solid #3b82f6',
            background: '#2563eb',
            color: '#fff',
            padding: '8px 12px',
            cursor: busy ? 'not-allowed' : 'pointer',
            fontSize: 12,
            fontWeight: 800,
          }}>
          {busy ? 'در حال اتصال...' : 'ذخیره و اتصال مجدد'}
        </button>
      </div>

      {message && <div style={{ marginTop: 9, fontSize: 11, lineHeight: 1.7, opacity: 0.82 }}>{message}</div>}

      <div dir="ltr" style={{ marginTop: 10, fontSize: 11, opacity: 0.65, wordBreak: 'break-all' }}>
        Secure Code Review gateway: {SECURE_GATEWAY_URL}
      </div>
    </section>
  );
};

export default McpConnectionSettingsFa;
