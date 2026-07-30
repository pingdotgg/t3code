import { useEffect, useRef, useState } from "react";

import type { WorkspaceState } from "../../state/workspaceModel";
import { isWorkspaceConnectionStatusBusy } from "./workspace-connection-status";

/**
 * How long a busy status must persist before the bar switches into it.
 *
 * The shell-sync signal re-enters "synchronizing" on every websocket
 * resubscribe and retries expected failures every 250ms, so a healthy
 * connection still produces a stream of sub-second sync blips. Longer than that
 * retry cycle, so a reconnect that resolves on its own never reaches the bar.
 */
export const STATUS_BUSY_ENTER_DELAY_MS = 400;

/**
 * Once the bar is showing a busy status, keep it there at least this long.
 * Without a floor, a sync that resolves right after crossing the enter delay
 * would flip the text twice within a few frames — the churn this exists to
 * prevent, just moved later.
 */
export const STATUS_BUSY_MIN_VISIBLE_MS = 900;

export type StatusSettlement =
  /** Adopt this busy-ness now. */
  | { readonly kind: "apply"; readonly busy: boolean }
  /** Nothing to change and nothing to schedule. */
  | { readonly kind: "hold" }
  /** Adopt it, but only if it is still current after `delayMs`. */
  | { readonly kind: "schedule"; readonly busy: boolean; readonly delayMs: number };

/**
 * Pure settling decision behind useSettledWorkspaceStatusBusy.
 *
 * Becoming busy is delayed so blips never surface; going quiet is delayed only
 * by whatever remains of the minimum-visible hold. A status that is not busy
 * but still worth reporting (offline, an error) is a steady fact, so it is
 * adopted immediately — suppressing it would hide a real problem.
 */
export function planWorkspaceStatusSettlement(input: {
  readonly rawBusy: boolean;
  readonly settledBusy: boolean;
  /** Timestamp (ms) before which a shown busy status must not be cleared. */
  readonly holdUntil: number;
  readonly now: number;
}): StatusSettlement {
  if (input.rawBusy === input.settledBusy) {
    return { kind: "hold" };
  }

  if (input.rawBusy) {
    return { kind: "schedule", busy: true, delayMs: STATUS_BUSY_ENTER_DELAY_MS };
  }

  const remainingHold = input.holdUntil - input.now;
  return remainingHold <= 0
    ? { kind: "apply", busy: false }
    : { kind: "schedule", busy: false, delayMs: remainingHold };
}

/**
 * Settles the raw busy signal into one stable enough to render.
 *
 * Rendering the raw signal is what made the old indicator flash: it toggles far
 * faster than a person can read. The label text itself is derived from live
 * state, so only the busy/quiet transition is damped here.
 */
export function useSettledWorkspaceStatusBusy(state: WorkspaceState): boolean {
  const rawBusy = isWorkspaceConnectionStatusBusy(state);
  const [settledBusy, setSettledBusy] = useState(false);
  const holdUntilRef = useRef(0);

  useEffect(() => {
    const settlement = planWorkspaceStatusSettlement({
      rawBusy,
      settledBusy,
      holdUntil: holdUntilRef.current,
      now: Date.now(),
    });

    if (settlement.kind === "hold") {
      return;
    }

    if (settlement.kind === "apply") {
      setSettledBusy(settlement.busy);
      return;
    }

    const timeout = setTimeout(() => {
      if (settlement.busy) {
        holdUntilRef.current = Date.now() + STATUS_BUSY_MIN_VISIBLE_MS;
      }
      setSettledBusy(settlement.busy);
    }, settlement.delayMs);
    return () => clearTimeout(timeout);
  }, [rawBusy, settledBusy]);

  return settledBusy;
}
