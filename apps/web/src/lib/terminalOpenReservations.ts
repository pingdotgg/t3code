/**
 * Terminal ids with an open request still in flight, keyed by thread.
 *
 * Reservations are deliberately scoped to the request lifetime. They protect
 * optimistic failure handlers from racing a new allocation without becoming a
 * history of every terminal id that has ever existed.
 */
const inFlightOpenIdsByThreadKey = new Map<string, Map<string, symbol>>();

export type TerminalOpenReservation = symbol;

export function reserveTerminalOpen(
  threadKey: string,
  terminalId: string,
): TerminalOpenReservation {
  const ids = inFlightOpenIdsByThreadKey.get(threadKey) ?? new Map<string, symbol>();
  const reservation = Symbol(terminalId);
  ids.set(terminalId, reservation);
  inFlightOpenIdsByThreadKey.set(threadKey, ids);
  return reservation;
}

export function isTerminalOpenReservationActive(
  threadKey: string,
  terminalId: string,
  reservation: TerminalOpenReservation,
): boolean {
  return inFlightOpenIdsByThreadKey.get(threadKey)?.get(terminalId) === reservation;
}

export function releaseTerminalOpen(
  threadKey: string,
  terminalId: string,
  reservation?: TerminalOpenReservation,
): void {
  const ids = inFlightOpenIdsByThreadKey.get(threadKey);
  if (!ids) return;
  if (reservation !== undefined && ids.get(terminalId) !== reservation) return;
  ids.delete(terminalId);
  if (ids.size === 0) {
    inFlightOpenIdsByThreadKey.delete(threadKey);
  }
}

export function reservedTerminalOpenIds(threadKey: string): string[] {
  return [...(inFlightOpenIdsByThreadKey.get(threadKey)?.keys() ?? [])];
}
