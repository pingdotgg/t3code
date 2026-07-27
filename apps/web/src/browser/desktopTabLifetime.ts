import { previewBridge } from "~/components/preview/previewBridge";

import { stopBrowserRecording } from "./browserRecording";

interface DesktopTabLease {
  references: number;
  closeTimer: number | null;
  ready: Promise<void>;
}

const leases = new Map<string, DesktopTabLease>();
const pendingTabOperations = new Map<string, Promise<void>>();

const enqueueDesktopTabOperation = (
  tabId: string,
  operation: () => Promise<void> | void,
): Promise<void> => {
  const previous = pendingTabOperations.get(tabId);
  const pending = previous
    ? previous.catch(() => undefined).then(operation)
    : Promise.resolve(operation());
  pendingTabOperations.set(tabId, pending);
  void pending
    .finally(() => {
      if (pendingTabOperations.get(tabId) === pending) {
        pendingTabOperations.delete(tabId);
      }
    })
    .catch(() => undefined);
  return pending;
};

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
      ready: enqueueDesktopTabOperation(tabId, () => previewBridge?.createTab(tabId)),
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
        void enqueueDesktopTabOperation(tabId, async () => {
          await stopBrowserRecording(tabId).catch(() => null);
          await previewBridge?.closeTab(tabId);
        }).catch(() => undefined);
      }, 0);
    },
  };
}
