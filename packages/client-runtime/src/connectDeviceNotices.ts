import type { AuthConnectDevice } from "@t3tools/contracts";

/**
 * T3 Connect device keys first seen on a host after `seenThrough`, a host-clock watermark each
 * client keeps for itself so a session the relay minted cannot mark its own arrival as read.
 * A client that has never looked starts from the newest key, so it does not announce itself.
 */
export function unseenConnectDevices(
  devices: ReadonlyArray<AuthConnectDevice>,
  seenThrough: number | undefined,
): { readonly unseen: ReadonlyArray<AuthConnectDevice>; readonly newest: number } {
  const newest = Math.max(0, ...devices.map((device) => device.approvedAt.epochMilliseconds));
  if (seenThrough === undefined) return { unseen: [], newest };
  return {
    unseen: devices.filter((device) => device.approvedAt.epochMilliseconds > seenThrough),
    newest: Math.max(seenThrough, newest),
  };
}
