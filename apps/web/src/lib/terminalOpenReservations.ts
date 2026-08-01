/**
 * Terminal ids with an `terminal.open` request still in flight, per thread key.
 *
 * Reserving them keeps `nextTerminalId` from handing a just-freed id (its
 * optimistic tab closed mid-request) to a new terminal — the first request's
 * failure rollback would then tear down the second terminal's tab. Reservations
 * live only for the request window, so closed ids become reusable again the
 * moment their open settles, and the set never grows with session history.
 */
const inFlightOpenIdsByThreadKey = new Map<string, Set<string>>();

export function reserveTerminalOpen(threadKey: string, terminalId: string): void {
  const ids = inFlightOpenIdsByThreadKey.get(threadKey) ?? new Set<string>();
  ids.add(terminalId);
  inFlightOpenIdsByThreadKey.set(threadKey, ids);
}

export function releaseTerminalOpen(threadKey: string, terminalId: string): void {
  const ids = inFlightOpenIdsByThreadKey.get(threadKey);
  if (!ids) return;
  ids.delete(terminalId);
  if (ids.size === 0) {
    inFlightOpenIdsByThreadKey.delete(threadKey);
  }
}

export function reservedTerminalOpenIds(threadKey: string): string[] {
  return [...(inFlightOpenIdsByThreadKey.get(threadKey) ?? [])];
}
