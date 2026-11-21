import type { EnvironmentId, PrinterServiceState, PrinterSnapshot } from "@t3tools/contracts";

export interface FleetPrinterEnvironmentSource {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly relayManaged: boolean;
  readonly state: PrinterServiceState | null;
}

export interface FleetPrinterEntry {
  readonly key: string;
  readonly printer: PrinterSnapshot;
  readonly proxyEnvironmentId: EnvironmentId;
  readonly proxyEnvironmentLabel: string;
  readonly isLocalToThread: boolean;
  readonly isProxied: boolean;
  readonly relayManaged: boolean;
}

function fleetPrinterKey(environmentId: EnvironmentId, printerId: string): string {
  return `${environmentId}\u0000${printerId}`;
}

/**
 * Collects printers across all connected T3 Connect environments and orders them so
 * local printers on the thread's environment come first, followed by online printers
 * on any T3 Connect proxy environment, then offline printers.
 */
export function collectFleetPrinters(
  sources: ReadonlyArray<FleetPrinterEnvironmentSource>,
  threadEnvironmentId: EnvironmentId | null,
): ReadonlyArray<FleetPrinterEntry> {
  const entries: Array<FleetPrinterEntry> = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (!source.state || !source.state.enabled) continue;
    const isLocalToThread =
      threadEnvironmentId !== null && source.environmentId === threadEnvironmentId;
    for (const printer of source.state.printers) {
      const key = fleetPrinterKey(source.environmentId, printer.id);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        key,
        printer,
        proxyEnvironmentId: source.environmentId,
        proxyEnvironmentLabel: source.label,
        isLocalToThread,
        isProxied: threadEnvironmentId !== null && !isLocalToThread,
        relayManaged: source.relayManaged,
      });
    }
  }

  return entries.toSorted((left, right) => {
    if (left.isLocalToThread !== right.isLocalToThread) {
      return left.isLocalToThread ? -1 : 1;
    }
    if (left.printer.online !== right.printer.online) {
      return left.printer.online ? -1 : 1;
    }
    const envCmp = left.proxyEnvironmentLabel.localeCompare(right.proxyEnvironmentLabel);
    if (envCmp !== 0) return envCmp;
    return left.printer.label.localeCompare(right.printer.label);
  });
}

/** Resolves an exact pinned fleet printer (never falling back across pins), or the best fleet entry when unpinned. */
export function selectFleetPrinter(
  entries: ReadonlyArray<FleetPrinterEntry>,
  preferredPrinterId?: string,
  preferredProxyEnvironmentId?: EnvironmentId,
): FleetPrinterEntry | undefined {
  if (entries.length === 0) return undefined;
  if (preferredProxyEnvironmentId !== undefined && preferredPrinterId !== undefined) {
    return entries.find(
      (entry) =>
        entry.proxyEnvironmentId === preferredProxyEnvironmentId &&
        entry.printer.id === preferredPrinterId,
    );
  }
  if (preferredPrinterId !== undefined) {
    const matches = entries.filter((entry) => entry.printer.id === preferredPrinterId);
    // Fail closed if multiple environments share the same printerId without an explicit owner environment pin.
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (preferredProxyEnvironmentId !== undefined) {
    return entries.find((entry) => entry.proxyEnvironmentId === preferredProxyEnvironmentId);
  }
  return entries[0];
}
