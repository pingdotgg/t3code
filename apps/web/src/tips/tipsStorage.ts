import type { EnvironmentId, TipId } from "@t3tools/contracts";

import { isGuestPage } from "../guestPage";

import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";
import {
  EMPTY_TIPS_STATE,
  type TipsState,
  TipsState as TipsStateSchema,
  recordTipUse,
  sameTipsState,
  settleTipSend,
  tipProgress,
} from "./tipsState";

// Local tip progress only. Kept apart from analytics and environment state, so any feature can
// record use without loading those.
const STORAGE_KEY = "t3code:new-thread-tips:v1";

export const readTipsState = () =>
  readLocalStorageValue(STORAGE_KEY, EMPTY_TIPS_STATE, TipsStateSchema);

export const useTipsState = () =>
  useLocalStorage(STORAGE_KEY, EMPTY_TIPS_STATE, TipsStateSchema)[0];

/**
 * Applies `update` to the latest stored state, so a stale tab cannot undo another tab's change.
 * Callers send first-time events only for "saved".
 */
export function writeTipsState(
  update: (state: TipsState) => TipsState,
): "saved" | "unchanged" | "failed" {
  const current = readTipsState();
  const next = update(current);
  // An unchanged visit must not rewrite, or it could replace a newer save from another tab.
  if (sameTipsState(next, current)) return "unchanged";
  writeLocalStorageValue(STORAGE_KEY, next, EMPTY_TIPS_STATE, TipsStateSchema);
  // The write helper swallows errors such as a full quota; only a saved change counts.
  return sameTipsState(readTipsState(), next) ? "saved" : "failed";
}

export const updateTipsState = (update: (state: TipsState) => TipsState) =>
  writeTipsState(update) === "saved";

export function canStoreTips(): boolean {
  try {
    window.localStorage.getItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

// Device snapshots arrive often; skip the storage read unless the evidence is older.
const doneThisPage = new Map<TipId, number>();

/**
 * Retires a tip after the user did the thing, from anywhere in the app. `at` is when they did it,
 * so old work seen today is not a new conversion; `on` is the environment it happened on.
 * `completed` is sent at once, and a later visit retries it if no server could take it.
 */
export function markTipDone(
  id: TipId,
  use: {
    readonly at?: number;
    readonly on?: EnvironmentId | undefined;
    /** Use whose environment is unknown or may have telemetry off: never report it. */
    readonly unreported?: boolean;
  } = {},
) {
  // A guest viewing someone else's thread did not do what it shows.
  if (isGuestPage()) return;
  const at = use.at ?? Date.now();
  if ((doneThisPage.get(id) ?? Infinity) <= at) return;
  const saved = updateTipsState((state) => {
    const used = recordTipUse(state, id, { at, on: use.on });
    // Only the use that became the earliest decides; a later one must not drop a pending send.
    return use.unreported && used !== state
      ? settleTipSend(used, id, "completed", "finished")
      : used;
  });
  // Remember only what storage holds, so a refused write is tried again.
  if ((tipProgress(readTipsState(), id).doneAt ?? Infinity) <= at) doneThisPage.set(id, at);
  // Send now: waiting for the next new thread could outlast the week an event may wait. A later
  // visit retries if this cannot load or reach a server.
  if (saved && !use.unreported) {
    void import("./tipsStore")
      .then(({ sendPendingTipUseEvents }) => sendPendingTipUseEvents(use.on ?? null))
      .catch(() => undefined);
  }
}
