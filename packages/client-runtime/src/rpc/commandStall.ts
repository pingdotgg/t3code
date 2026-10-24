/**
 * Liveness for a connection whose host has stopped answering commands.
 *
 * The socket-level heartbeat in `protocol.ts` answers one question: is the
 * connection still carrying frames? It fires after `PING_TIMEOUT` of total
 * silence. A host under heavy load still answers small requests, so it keeps
 * the socket alive - and a command that the host will never answer waits
 * forever, with the connection looking perfectly healthy the whole time.
 *
 * This module watches the commands themselves. It answers the other question:
 * is the host still answering the work we ask of it?
 *
 * The rule is deliberately narrow. A command that has been outstanding for
 * longer than the deadline is reported as stalled, but the connection is NOT
 * torn down: the host may still be working on it, and the deadline exists to
 * tell the user so, not to cancel work the server is about to finish.
 */

/** How long a command may stay outstanding before the pipeline is called stalled. */
export const COMMAND_STALL_DEADLINE = "120 seconds";

export interface CommandStallSnapshot {
  /** The command that has been outstanding the longest. */
  readonly method: string;
  /** How long it has been outstanding, in milliseconds. */
  readonly outstandingMs: number;
  /** How many commands are outstanding right now. */
  readonly outstandingCount: number;
}

export interface CommandStallTracker {
  /** Records a command that has started. */
  /**
   * Records that a command has started, and returns the function that records
   * that THIS command has finished.
   *
   * The release is per command, not per method: two commands of the same method
   * can be outstanding at once, and the one that finishes first is not
   * necessarily the one that started first. Releasing by method would drop the
   * wrong command and leave a finished one reported as outstanding.
   */
  readonly begin: (method: string) => { readonly release: () => void };
  /**
   * The longest-outstanding command, if it has been outstanding longer than
   * `deadlineMs`. `null` when nothing is outstanding, or when everything
   * outstanding is still within the deadline.
   */
  readonly stalled: (nowMs: number, deadlineMs: number) => CommandStallSnapshot | null;
  /** How many commands are outstanding right now. */
  readonly outstandingCount: () => number;
}

/**
 * A tracker over the commands currently in flight.
 *
 * `now` is injected so the tracker can be tested without a clock, and so the
 * caller reads the time through Effect's own `Clock` rather than a global.
 * The tracker stays a plain object: it is state, not an effect.
 */
export const makeCommandStallTracker = (options: {
  readonly now: () => number;
}): CommandStallTracker => {
  const now = options.now;
  // One entry per in-flight command. Several commands of the same method can
  // be outstanding at once, so this is a list, not a set of method names.
  const outstanding: Array<{ readonly method: string; readonly startedAtMs: number }> = [];

  return {
    begin: (method: string) => {
      const entry = { method, startedAtMs: now() };
      outstanding.push(entry);
      return {
        release: () => {
          // Remove THIS command, by identity. A command of the same method
          // that started later, or finished earlier, is a different command
          // and must stay outstanding.
          const index = outstanding.indexOf(entry);
          if (index >= 0) outstanding.splice(index, 1);
        },
      };
    },
    stalled: (nowMs: number, deadlineMs: number) => {
      if (outstanding.length === 0) return null;
      let oldest: { readonly method: string; readonly startedAtMs: number } | undefined;
      for (const entry of outstanding) {
        if (oldest === undefined || entry.startedAtMs < oldest.startedAtMs) oldest = entry;
      }
      if (oldest === undefined) return null;
      const outstandingMs = nowMs - oldest.startedAtMs;
      if (outstandingMs < deadlineMs) return null;
      return {
        method: oldest.method,
        outstandingMs,
        outstandingCount: outstanding.length,
      };
    },
    outstandingCount: () => outstanding.length,
  };
};
