/**
 * Settlement-field merge and activity-ordering guards for orchestrator V2.
 *
 * thread.settled / thread.unsettled events historically carried a full AppThread
 * payload. Reducers must only apply settlement fields so a stale or concurrent
 * unsettle cannot restore unrelated thread state (title, archive, model, ...).
 */

export type SettledOverride = "settled" | "active" | null;

export type SettledThreadFields = {
  readonly settledOverride: SettledOverride;
  readonly settledAt: unknown;
  readonly updatedAt: unknown;
};

/**
 * Epoch-ms view used by ordering guards. Callers convert DateTime.Utc (or ISO)
 * once at the boundary so this module stays free of Effect DateTime coupling.
 */
export type SettledThreadTimestamps = {
  readonly settledOverride: SettledOverride;
  /** settledAt when override is "settled"; ignored otherwise. */
  readonly settledAtMs: number | null;
  /** Thread updatedAt; used as the active-pin timestamp. */
  readonly updatedAtMs: number;
};

/**
 * Timestamp that the current explicit override was established at.
 * - settled: settledAt (server accept time of the settle)
 * - active: updatedAt (server accept time of the user unsettle pin)
 * - null override: no pin
 */
export function settledOverrideTimestampMs(state: SettledThreadTimestamps): number | null {
  if (state.settledOverride === null) return null;
  if (state.settledOverride === "settled") return state.settledAtMs;
  return state.updatedAtMs;
}

/**
 * Whether an activity-driven clear (target settledOverride null) may clear the
 * current pin. Activity older than the pin must not clear a newer manual settle
 * or keep-active override (delayed/duplicate provider events).
 */
export function shouldApplyActivityUnsettle(
  state: SettledThreadTimestamps,
  activityAtMs: number,
): boolean {
  if (state.settledOverride === null) return false;
  const overrideMs = settledOverrideTimestampMs(state);
  if (overrideMs === null) return true;
  return activityAtMs >= overrideMs;
}

/**
 * Merge only settlement fields onto the current thread. Never copies title,
 * archive, model, or other non-settlement state from the event payload.
 */
export function applySettlementFieldsToThread<T extends SettledThreadFields>(
  current: T,
  settlement: Pick<T, "settledOverride" | "settledAt" | "updatedAt">,
): T {
  return {
    ...current,
    settledOverride: settlement.settledOverride,
    settledAt: settlement.settledAt,
    updatedAt: settlement.updatedAt,
  };
}

/**
 * Reduce a settle/unsettle event against current thread state.
 * - Explicit settle and user keep-active pin always apply settlement fields.
 * - Activity unsettle (payload.settledOverride === null) applies only when the
 *   activity timestamp wins the ordering guard against the current pin.
 * Returns the current thread unchanged when the event is a no-op.
 */
export function reduceThreadSettlementEvent<T extends SettledThreadFields>(input: {
  readonly current: T;
  readonly eventType: "thread.settled" | "thread.unsettled";
  readonly settlement: Pick<T, "settledOverride" | "settledAt" | "updatedAt">;
  /** Activity/command time as epoch ms (event.occurredAt). */
  readonly activityAtMs: number;
  readonly currentTimestamps: SettledThreadTimestamps;
}): T {
  const { current, eventType, settlement, activityAtMs, currentTimestamps } = input;
  if (eventType === "thread.unsettled" && settlement.settledOverride === null) {
    if (!shouldApplyActivityUnsettle(currentTimestamps, activityAtMs)) {
      return current;
    }
  }
  return applySettlementFieldsToThread(current, settlement);
}
