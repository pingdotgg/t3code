/**
 * Last-observed WebSocket stream activity. A half-open socket can stay "open"
 * while delivering zero bytes, so the transport records every open, connect,
 * and stream value here for the stall watchdog. Import-free so protocol,
 * transport, and UI can share it without cycles.
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
