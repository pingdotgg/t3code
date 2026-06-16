import { previewBridge } from "~/components/preview/previewBridge";

interface DesktopTabLease {
  references: number;
  closeTimer: number | null;
}

const leases = new Map<string, DesktopTabLease>();

export function acquireDesktopTab(tabId: string): () => void {
  const current = leases.get(tabId) ?? { references: 0, closeTimer: null };
  if (current.closeTimer !== null) window.clearTimeout(current.closeTimer);
  current.references += 1;
  current.closeTimer = null;
  leases.set(tabId, current);
  if (current.references === 1) void previewBridge?.createTab(tabId);

  return () => {
    const lease = leases.get(tabId);
    if (!lease) return;
    lease.references = Math.max(0, lease.references - 1);
    if (lease.references > 0) return;
    lease.closeTimer = window.setTimeout(() => {
      const latest = leases.get(tabId);
      if (!latest || latest.references > 0) return;
      leases.delete(tabId);
      void previewBridge?.closeTab(tabId);
    }, 0);
  };
}
