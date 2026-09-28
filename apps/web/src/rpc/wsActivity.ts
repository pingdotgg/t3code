/**
 * Last-observed WebSocket stream activity, shared by the transport and the
 * connection-surface watchdog.
 *
 * Heartbeats alone cannot prove liveness: a half-open socket can stay "open"
 * while delivering zero bytes (no FIN/RST), so `reader.read()` parks forever
 * and the reconnect loop is never re-entered. The transport records every
 * socket open, protocol connect, and stream value here; the coordinator forces
 * a reconnect after `WS_STALL_SILENCE_MS` without activity while work is
 * pending. Standalone (no imports) so protocol, transport, and UI can share it
 * without cycles.
 */

let lastActivityMs = Date.now();

export function recordWsStreamActivity(atMs: number = Date.now()): void {
  if (!Number.isFinite(atMs)) {
    return;
  }
  lastActivityMs = atMs;
}

export function getLastWsStreamActivityMs(): number {
  return lastActivityMs;
}

export function resetWsStreamActivityForTests(atMs: number = Date.now()): void {
  lastActivityMs = atMs;
}
