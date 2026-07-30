import { useEffect, useRef, useState } from "react";

import type { WorkspaceState } from "../../state/workspaceModel";
import {
  isTransientWorkspaceSyncTone,
  workspaceSyncTone,
  type WorkspaceSyncTone,
} from "./workspace-connection-status";

/**
 * How long a "connecting"/"syncing" tone must persist before it is shown.
 *
 * The underlying shell-sync signal re-enters "synchronizing" on every
 * websocket resubscribe and retries expected failures every 250ms, so a
 * healthy connection still produces a stream of sub-second sync blips. Longer
 * than that retry cycle, so a reconnect that resolves on its own never reaches
 * the header at all.
 */
export const SYNC_TONE_ENTER_DELAY_MS = 400;

/**
 * Once a transient tone is actually shown, hold it at least this long.
 * Without a floor, a sync that resolves immediately after crossing
 * SYNC_TONE_ENTER_DELAY_MS would appear and vanish within a frame or two — the
 * flicker this exists to prevent, just moved later.
 */
export const SYNC_TONE_MIN_VISIBLE_MS = 900;

export type SyncToneSettlement =
  /** Show this tone now. */
  | { readonly kind: "apply"; readonly tone: WorkspaceSyncTone }
  /** Nothing to change and nothing to schedule. */
  | { readonly kind: "hold" }
  /** Show this tone, but only if it is still current after `delayMs`. */
  | { readonly kind: "schedule"; readonly tone: WorkspaceSyncTone; readonly delayMs: number };

/**
 * Pure settling decision behind useSettledWorkspaceSyncTone.
 *
 * Transient tones must persist before they appear and linger before they
 * leave; tones that report a real problem (offline, connection error, no ready
 * environment) bypass both delays, since suppressing those would mean hiding a
 * fault the user needs to see.
 */
export function planWorkspaceSyncToneSettlement(input: {
  readonly rawTone: WorkspaceSyncTone;
  readonly settledTone: WorkspaceSyncTone;
  /** Timestamp (ms) before which a shown transient tone must not be cleared. */
  readonly holdUntil: number;
  readonly now: number;
}): SyncToneSettlement {
  if (!isTransientWorkspaceSyncTone(input.rawTone)) {
    // A real fault: show it immediately, even over a held spinner.
    if (input.rawTone !== "idle") {
      return { kind: "apply", tone: input.rawTone };
    }

    // Back to idle, but respect an in-flight minimum-visible hold so a
    // just-shown spinner isn't yanked away mid-blink.
    const remainingHold = input.holdUntil - input.now;
    return remainingHold <= 0
      ? { kind: "apply", tone: "idle" }
      : { kind: "schedule", tone: "idle", delayMs: remainingHold };
  }

  // Already showing this exact transient tone — nothing to schedule.
  if (input.settledTone === input.rawTone) {
    return { kind: "hold" };
  }

  return { kind: "schedule", tone: input.rawTone, delayMs: SYNC_TONE_ENTER_DELAY_MS };
}

/**
 * Settles the raw workspace sync tone into one stable enough to render.
 *
 * The sync signal this derives from toggles on every resubscribe and on a
 * 250ms retry cycle; rendering it directly is what made the old inline
 * indicator flash in and out.
 */
export function useSettledWorkspaceSyncTone(state: WorkspaceState): WorkspaceSyncTone {
  const rawTone = workspaceSyncTone(state);
  const [settledTone, setSettledTone] = useState<WorkspaceSyncTone>(() =>
    isTransientWorkspaceSyncTone(rawTone) ? "idle" : rawTone,
  );
  const holdUntilRef = useRef(0);

  useEffect(() => {
    const settlement = planWorkspaceSyncToneSettlement({
      rawTone,
      settledTone,
      holdUntil: holdUntilRef.current,
      now: Date.now(),
    });

    if (settlement.kind === "hold") {
      return;
    }

    if (settlement.kind === "apply") {
      setSettledTone(settlement.tone);
      return;
    }

    const timeout = setTimeout(() => {
      if (isTransientWorkspaceSyncTone(settlement.tone)) {
        holdUntilRef.current = Date.now() + SYNC_TONE_MIN_VISIBLE_MS;
      }
      setSettledTone(settlement.tone);
    }, settlement.delayMs);
    return () => clearTimeout(timeout);
  }, [rawTone, settledTone]);

  return settledTone;
}
