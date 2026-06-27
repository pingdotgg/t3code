import { previewBridge } from "~/components/preview/previewBridge";

interface DesktopTabLease {
  references: number;
  closeTimer: number | null;
  ready: Promise<void>;
}

const leases = new Map<string, DesktopTabLease>();

export interface AcquiredDesktopTab {
  readonly ready: Promise<void>;
  readonly release: () => void;
}

export function acquireDesktopTab(tabId: string): AcquiredDesktopTab {
  const current =
    leases.get(tabId) ??
    ({
      references: 0,
      closeTimer: null,
      ready: previewBridge?.createTab(tabId) ?? Promise.resolve(),
    } satisfies DesktopTabLease);
  if (current.closeTimer !== null) window.clearTimeout(current.closeTimer);
  current.references += 1;
  current.closeTimer = null;
  leases.set(tabId, current);

  return {
    ready: current.ready,
    release: () => {
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
    },
  };
}
