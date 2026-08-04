/**
 * Bounded, in-memory record of WebSocket transport lifecycle events.
 *
 * A transparent socket reopen leaves no trace anywhere else: the server sees a
 * fresh connection, the UI keeps rendering, and nothing is written down. This
 * buffer is the client-side counterpart to the server's connection and stream
 * logs, so a stalled tab can be explained after the fact without a repro.
 * Read it from the devtools console via `__t3WsDiagnostics()`.
 */
const MAX_ENTRIES = 200;

export type WsDiagnosticEvent =
  | "socket-attempt"
  | "socket-open"
  | "socket-error"
  | "socket-close"
  | "protocol-connected"
  | "ping-timeout"
  | "streams-restarted"
  | "stream-parked"
  | "stream-retry";

export interface WsDiagnosticEntry {
  readonly at: string;
  readonly event: WsDiagnosticEvent;
  readonly detail?: Readonly<Record<string, unknown>>;
}

const FAULT_EVENTS = new Set<WsDiagnosticEvent>([
  "socket-error",
  "ping-timeout",
  "stream-parked",
  "stream-retry",
]);

const entries: WsDiagnosticEntry[] = [];

/**
 * Strip credentials and short-lived auth material before a socket URL is
 * written to diagnostics, console output, or connection status. Remote
 * environments put `wsToken` in the query string.
 */
export function sanitizeWsSocketUrl(socketUrl: string): string {
  try {
    const url = new URL(socketUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const withoutHash = socketUrl.split("#")[0] ?? socketUrl;
    return withoutHash.split("?")[0] ?? withoutHash;
  }
}

export function recordWsDiagnostic(
  event: WsDiagnosticEvent,
  detail?: Readonly<Record<string, unknown>>,
): void {
  entries.push({ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) });
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  const log = FAULT_EVENTS.has(event) ? console.warn : console.info;
  if (detail) {
    log(`[ws] ${event}`, detail);
  } else {
    log(`[ws] ${event}`);
  }
}

export function getWsDiagnostics(): readonly WsDiagnosticEntry[] {
  return entries.slice();
}

export function clearWsDiagnosticsForTests(): void {
  entries.length = 0;
}

(globalThis as { __t3WsDiagnostics?: typeof getWsDiagnostics }).__t3WsDiagnostics =
  getWsDiagnostics;
