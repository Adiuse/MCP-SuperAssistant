export type SecurityToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface SecurityToastDetail {
  id?: string;
  title: string;
  message?: string;
  variant?: SecurityToastVariant;
  durationMs?: number;
}

export const SECURITY_TOAST_EVENT = 'mcp-security-toast';

export function emitSecurityToast(detail: SecurityToastDetail): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(
    new CustomEvent<SecurityToastDetail>(SECURITY_TOAST_EVENT, {
      detail: {
        variant: 'info',
        durationMs: 5000,
        ...detail,
      },
    }),
  );
}
