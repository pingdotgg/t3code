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
  /**
   * When the current settledOverride was established. Stable across later
   * metadata renames that advance updatedAt. Null when no override is set, or
   * for rows that predate the field (callers fall back in settledOverrideTimestampMs).
   */
  readonly settledOverrideAt?: unknown;
  readonly updatedAt: unknown;
  readonly pinnedAt?: unknown;
};

/**
 * Epoch-ms view used by ordering guards. Callers convert DateTime.Utc (or ISO)
 * once at the boundary so this module stays free of Effect DateTime coupling.
 */
export type SettledThreadTimestamps = {
  readonly settledOverride: SettledOverride;
  /** settledAt when override is "settled"; ignored otherwise. */
  readonly settledAtMs: number | null;
  /**
   * Dedicated override establishment time when present. Null for pre-field rows
   * and for threads with no override.
   */
  readonly settledOverrideAtMs: number | null;
  /** Thread updatedAt; legacy fallback for active pins without settledOverrideAt. */
  readonly updatedAtMs: number;
};

export type SettlementFieldPatch = {
  readonly settledOverride: SettledOverride;
  readonly settledAt: unknown;
  readonly settledOverrideAt: unknown;
  readonly updatedAt: unknown;
  /**
   * When set (including explicit null), replaces current.pinnedAt.
   * When omitted, the current pin is left alone (activity unsettle path).
   */
  readonly pinnedAt?: unknown;
};

/**
 * Timestamp that the current explicit override was established at.
 * Prefers settledOverrideAt when present. Fallbacks keep pre-field rows honest:
 * - settled: settledAt
 * - active: updatedAt (legacy; can drift on metadata renames)
 * - null override: no pin
 */
export function settledOverrideTimestampMs(state: SettledThreadTimestamps): number | null {
  if (state.settledOverride === null) return null;
  if (state.settledOverrideAtMs !== null) return state.settledOverrideAtMs;
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
 * `pinnedAt` is applied only when the patch includes the key (settle clears it).
 */
export function applySettlementFieldsToThread<T extends SettledThreadFields>(
  current: T,
  settlement: SettlementFieldPatch,
): T {
  const next = {
    ...current,
    settledOverride: settlement.settledOverride,
    settledAt: settlement.settledAt,
    settledOverrideAt: settlement.settledOverrideAt,
    updatedAt: settlement.updatedAt,
  };
  if ("pinnedAt" in settlement) {
    return { ...next, pinnedAt: settlement.pinnedAt };
  }
  return next;
}

/**
 * Reduce a settle/unsettle event against current thread state.
 * - Explicit settle and user keep-active pin always apply settlement fields.
 * - Explicit settle also clears pinnedAt when the patch carries it.
 * - Activity unsettle (payload.settledOverride === null) applies only when the
 *   activity timestamp wins the ordering guard against the current pin, and
 *   never rewinds updatedAt behind a newer metadata bump.
 * Returns the current thread unchanged when the event is a no-op.
 */
export function reduceThreadSettlementEvent<T extends SettledThreadFields>(input: {
  readonly current: T;
  readonly eventType: "thread.settled" | "thread.unsettled";
  readonly settlement: SettlementFieldPatch;
  /** Activity/command time as epoch ms (event.occurredAt). */
  readonly activityAtMs: number;
  readonly currentTimestamps: SettledThreadTimestamps;
}): T {
  const { current, eventType, settlement, activityAtMs, currentTimestamps } = input;
  if (eventType === "thread.unsettled" && settlement.settledOverride === null) {
    if (!shouldApplyActivityUnsettle(currentTimestamps, activityAtMs)) {
      return current;
    }
    // Provider activity stamps may predate a later rename/metadata bump; keep
    // the newer updatedAt so home-list ordering does not rewind.
    const updatedAt =
      activityAtMs < currentTimestamps.updatedAtMs ? current.updatedAt : settlement.updatedAt;
    return applySettlementFieldsToThread(current, {
      settledOverride: null,
      settledAt: null,
      settledOverrideAt: null,
      updatedAt,
    });
  }
  return applySettlementFieldsToThread(current, settlement);
}
