/**
 * Watchdog for a settle that the server accepted but the local view never
 * reflects.
 *
 * An accepted `thread.settle` always publishes an authoritative
 * `thread-upserted`, so the thread should read as settled locally within a
 * moment. When it does not, the client is working from a view the server no
 * longer agrees with — and because settling an already-settled thread is a
 * deliberate idempotent no-op, every further click succeeds while changing
 * nothing. The control looks dead and the thread cannot be moved to settled at
 * all until the client is restarted.
 *
 * Polling rather than subscribing keeps this out of the atom graph: it runs
 * only after an explicit user action, and only until the view agrees.
 */

/** How long to wait before each re-read. Spaced out rather than uniform: the
 *  common case resolves on the first check, and a slow environment gets a
 *  couple of longer chances before we escalate to a resync. */
export const SETTLE_CONVERGENCE_DELAYS_MS: readonly number[] = [150, 500, 1200];

export type SettleConvergenceOutcome =
  /** The local view caught up on its own; nothing to do. */
  | "converged"
  /** The view never caught up, so a reconcile was requested. */
  | "resync-requested"
  /** The thread left the shell entirely (deleted, archived); not our problem. */
  | "thread-absent";

export interface SettleConvergenceOptions {
  /** `true` when the local view shows the thread settled, `false` when it does
   *  not, and `null` when the thread is no longer in the local shell. */
  readonly readSettled: () => boolean | null;
  readonly requestResync: () => void;
  readonly delay: (ms: number) => Promise<void>;
  readonly delaysMs?: readonly number[];
}

export async function confirmSettleConverged(
  options: SettleConvergenceOptions,
): Promise<SettleConvergenceOutcome> {
  const delays = options.delaysMs ?? SETTLE_CONVERGENCE_DELAYS_MS;
  for (const waitMs of delays) {
    await options.delay(waitMs);
    const settled = options.readSettled();
    if (settled === null) {
      return "thread-absent";
    }
    if (settled) {
      return "converged";
    }
  }
  options.requestResync();
  return "resync-requested";
}
