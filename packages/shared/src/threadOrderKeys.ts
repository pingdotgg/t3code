// Ordering rules for the user-arranged pinned and active lists. Shared so
// clients and the server (MCP reorder tools) compute the same keys and order.

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Sort anchor for the active thread list: creation time, re-anchored to
 * unsettledAt when the thread last re-entered the active list (an explicit
 * un-settle, or a settled thread waking on activity). The list stays static
 * between lifecycle transitions, but an un-settled thread surfaces at the
 * top instead of sinking back to its creation-order slot. Shared by web and
 * mobile so both render the same order. Malformed timestamps sink to 0.
 */
export function activeThreadAnchorTimestampMs(thread: {
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
}): number {
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
  );
}

// ── Pinned reorder: fractional index keys ──────────────────────────────
// Pinned threads carry an optional pinOrderKey (a base-26 string). The
// pinned block sorts keyed threads by plain string comparison, so a drag
// (web) or Move up/down (mobile) writes ONE key to ONE thread on that
// thread's own server — neighbors, possibly living on other servers, are
// never touched, and every client connected to the same servers converges
// on the same order.
const PIN_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

function isValidPinOrderKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    if (!PIN_ORDER_DIGITS.includes(char)) return false;
  }
  // A trailing minimum digit would leave no room to sort a key immediately
  // before this one; generators never produce it, so treat it as corrupt.
  return key.at(-1) !== PIN_ORDER_DIGITS[0];
}

/** Midpoint of two digit strings interpreted as fractions in (0, 1).
    "" stands for the open bound on either side. Requires a < b. */
function pinOrderMidpoint(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error("pinOrderMidpoint: bounds out of order");
  if (b !== "") {
    // Recurse past the longest common prefix ("a" pads the shorter side).
    let n = 0;
    while ((a.charAt(n) || PIN_ORDER_DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + pinOrderMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : PIN_ORDER_DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? PIN_ORDER_DIGITS.length : PIN_ORDER_DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return PIN_ORDER_DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  // Consecutive leading digits: either b has spare digits to shorten into,
  // or we extend a (never producing a trailing minimum digit — the base
  // case midpoint("", "") is the middle of the alphabet).
  if (b.length > 1) return b.charAt(0);
  return PIN_ORDER_DIGITS.charAt(digitA) + pinOrderMidpoint(a.slice(1), "");
}

/** Key that sorts strictly between two neighbors; null bounds mean "top of
    the pinned block" / "bottom of the keyed run". Returns null instead of
    throwing when existing keys are corrupt or out of order — callers fall
    back to rewriting the section. */
export function pinOrderKeyBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidPinOrderKey(a)) return null;
  if (b !== "" && !isValidPinOrderKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return pinOrderMidpoint(a, b);
}

/** Evenly spaced keys for materializing an order. Wider keys keep a large
    active list from exhausting the space between two-digit keys. */
export function generateSpreadPinOrderKeys(count: number): string[] {
  let width = 2;
  let space = PIN_ORDER_DIGITS.length ** width;
  while (space <= (count + 1) * 2) {
    width += 1;
    space *= PIN_ORDER_DIGITS.length;
  }
  const step = space / (count + 1);
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let value = Math.round(step * (i + 1));
    // Skip values whose low digit is the minimum (a trailing "a" key).
    if (value % PIN_ORDER_DIGITS.length === 0) value += 1;
    let key = "";
    for (let digit = 0; digit < width; digit += 1) {
      key = PIN_ORDER_DIGITS.charAt(value % PIN_ORDER_DIGITS.length) + key;
      value = Math.floor(value / PIN_ORDER_DIGITS.length);
    }
    keys.push(key);
  }
  return keys;
}

/**
 * Assignments needed to realize a new pinned order. When the moved thread
 * sits between two keyed (or absent) neighbors, this is a single write to
 * the moved thread. When a neighbor is keyless (threads pinned before
 * reordering shipped), the whole section gets fresh spread keys — a
 * one-time materialization; every move after that is single-write. Active
 * reordering uses the same planner with activeOrderKey values.
 */
export function planPinnedReorder(input: {
  /** Thread ids in the desired visual order (after the move). */
  readonly orderedIds: readonly string[];
  /** Include retained keys from hidden rows; only orderedIds receive writes. */
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const { orderedIds, keysById, movedId } = input;
  const visibleIds = new Set(orderedIds);
  const reservedKeys = new Set(
    [...keysById].flatMap(([id, key]) => (!visibleIds.has(id) && key != null ? [key] : [])),
  );
  const movedIndex = orderedIds.indexOf(movedId);
  if (movedIndex === -1) return [];
  const beforeId = movedIndex > 0 ? orderedIds[movedIndex - 1] : null;
  const afterId = movedIndex < orderedIds.length - 1 ? orderedIds[movedIndex + 1] : null;
  const beforeKey = beforeId != null ? (keysById.get(beforeId) ?? null) : null;
  const afterKey = afterId != null ? (keysById.get(afterId) ?? null) : null;
  const beforeUsable = beforeId === null || beforeKey != null;
  const afterUsable = afterId === null || afterKey != null;
  if (beforeUsable && afterUsable) {
    let key = pinOrderKeyBetween(beforeKey, afterKey);
    while (key !== null && reservedKeys.has(key)) key = pinOrderKeyBetween(key, afterKey);
    if (key !== null) return [{ id: movedId, orderKey: key }];
  }
  // Keyless neighbor (or corrupt keys): rewrite the section in the new order.
  const keys = generateSpreadPinOrderKeys(orderedIds.length + reservedKeys.size)
    .filter((key) => !reservedKeys.has(key))
    .slice(0, orderedIds.length);
  return orderedIds.flatMap((id, index) => {
    const key = keys[index]!;
    return keysById.get(id) === key ? [] : [{ id, orderKey: key }];
  });
}

/**
 * Pinned block order: user-arranged keys first (string comparison, id
 * tiebreak), then keyless threads newest-created first — so threads on
 * servers that predate reordering keep the static creation order at the
 * bottom of the block instead of breaking the section.
 */
export function sortPinnedThreadsByOrderKey<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly pinOrderKey?: string | null | undefined;
    /** Thread ids are only unique within an environment, and the pinned
        block merges environments — the tiebreak needs both parts or two
        clients could render equal-key threads in stream-arrival order. */
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  if (threads.length < 2) return [...threads];
  const keyed: T[] = [];
  const keyless: T[] = [];
  for (const thread of threads) {
    (thread.pinOrderKey != null ? keyed : keyless).push(thread);
  }
  const identityTiebreak = (left: T, right: T) =>
    left.id.localeCompare(right.id) ||
    (left.environmentId ?? "").localeCompare(right.environmentId ?? "");
  keyed.sort((left, right) => {
    const leftKey = left.pinOrderKey!;
    const rightKey = right.pinOrderKey!;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : identityTiebreak(left, right);
  });
  const timestamps = new Map(
    keyless.map((thread) => [thread, toSortableTimestamp(thread.createdAt) ?? 0]),
  );
  keyless.sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! || identityTiebreak(left, right),
  );
  return [...keyed, ...keyless];
}

/** New and reopened threads lead the active list. Arranged threads follow
    their saved keys; activity leaves both groups in place. */
export function sortActiveThreadsByOrderKey<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
    readonly activeOrderKey?: string | null | undefined;
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  if (threads.length < 2) return [...threads];
  const timestamps = new Map<T, number>();
  for (const thread of threads) {
    if (thread.activeOrderKey == null) {
      timestamps.set(thread, activeThreadAnchorTimestampMs(thread));
    }
  }
  return [...threads].sort((left, right) => {
    const leftKey = left.activeOrderKey;
    const rightKey = right.activeOrderKey;
    if (leftKey == null && rightKey != null) return -1;
    if (leftKey != null && rightKey == null) return 1;
    let order = 0;
    if (leftKey != null && rightKey != null) {
      order = leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    } else {
      order = timestamps.get(right)! - timestamps.get(left)!;
    }
    return (
      order ||
      left.id.localeCompare(right.id) ||
      (left.environmentId ?? "").localeCompare(right.environmentId ?? "")
    );
  });
}
