import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

/**
 * Match the V1 conversation windows. Item/byte budgets only apply to histories
 * without turn starts; tool activity must not split an ordinary conversation turn.
 */
export const THREAD_HISTORY_PAGE_POLICY = {
  maxUserTurns: 10,
  maxItems: 75,
  maxEncodedBytes: 1_048_576,
} as const;

export const OLDER_THREAD_USER_TURN_LIMIT = 20;
export const THREAD_HISTORY_MAX_RAW_TURNS = 150;

/**
 * Hard bounds applied inside the projection query before any payload is
 * decoded. Turn-aware windows still prefer complete turns, but a single
 * oversized turn cannot materialize unbounded rows or bytes; rows dropped by
 * these caps stay reachable through history paging.
 */
export const THREAD_HISTORY_MAX_WINDOW_ROWS = 1_500;
export const THREAD_HISTORY_MAX_WINDOW_BYTES = 4_194_304;
/** Rows larger than this carry a write-time `bounded_json` preview used by bounded reads. */
export const THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES = 65_536;
/** Cap applied to each oversized string field during payload compaction. */
export const THREAD_HISTORY_COMPACTED_FIELD_CHARS = 16_384;

/** Extra rows let the projection query retain an inclusive cursor and prove another page exists. */
export const THREAD_HISTORY_SNAPSHOT_ROW_LIMIT = THREAD_HISTORY_PAGE_POLICY.maxItems + 2;

/** Reject absurd cursors before base64 work or JSON parse. */
export const THREAD_HISTORY_CURSOR_MAX_LENGTH = 4_096;

export type ThreadHistoryPagePolicy = {
  readonly maxUserTurns?: number | undefined;
  readonly maxItems: number;
  readonly maxEncodedBytes: number;
};

/**
 * Fixed-length thread identity for cursors — sha256 as base64url is exactly 43
 * chars no matter how long the stored thread id is.
 */
export const THREAD_HISTORY_CURSOR_THREAD_TAG_LENGTH = 43;

export function threadHistoryCursorThreadTag(threadId: ThreadId | string): string {
  // utf16le keeps lone surrogates lossless — utf8 folds them to U+FFFD, which
  // would alias distinct legal thread ids onto the same cursor anchor.
  return NodeCrypto.createHash("sha256").update(String(threadId), "utf16le").digest("base64url");
}

/**
 * Fixed-length item identity for cursors. Ordinals alone do not uniquely
 * identify a stored row — several producers allocate ordinals independently —
 * so v2 anchors also carry the item id's digest.
 */
export function threadHistoryCursorItemTag(itemId: TurnItemId | string): string {
  return NodeCrypto.createHash("sha256").update(String(itemId), "utf16le").digest("base64url");
}

/**
 * v1 cursors embed the source item id (`si`) and thread id (`st`) verbatim —
 * both are unbounded strings, so a legal multi-KB id produced an oversized
 * cursor that decode then rejected, stranding older history. v2 anchors on the
 * item's ordinal plus a fixed-length digest of the source thread id, keeping
 * the cursor bounded no matter how long the stored ids are. The server
 * resolves the digest by walking the requested thread's fork ancestry — an
 * anchor's source thread is always an ancestor — so no id ever needs to be
 * stored in the cursor itself. `sih` disambiguates equal-ordinal rows. v1
 * remains decodable so cursors issued before the upgrade still resolve.
 */
export type ThreadHistoryCursorPayload =
  | {
      readonly v: 1;
      readonly seq: number;
      readonly st: string;
      readonly si: string;
      readonly p: number;
    }
  | {
      readonly v: 2;
      readonly seq: number;
      readonly sth: string;
      readonly so: number;
      readonly sih: string;
      readonly p: number;
    };

export type SelectTimelinePageResult = {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly nextCursor: string | null;
  readonly hasMoreHistory: boolean;
};

export type BoundedProjectionResult = {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  /** Max ordinal across the authoritative full projection's local turnItems. */
  readonly latestLocalTurnOrdinal: number | null;
  readonly payloadBudgetExceeded: boolean;
};

export class InvalidThreadHistoryCursorError extends Error {
  readonly _tag = "InvalidThreadHistoryCursorError";
  constructor(message = "Invalid thread history cursor.") {
    super(message);
    this.name = "InvalidThreadHistoryCursorError";
  }
}

interface JsonWalkFrame {
  readonly container: Record<string, unknown> | ReadonlyArray<unknown>;
  // Objects snapshot enumerable keys; arrays snapshot length. Members are read
  // lazily at visit time so an earlier member's toJSON can still delete or
  // shrink a later one, matching the reference serializer.
  readonly keys: ReadonlyArray<string> | undefined;
  readonly length: number;
  index: number;
  emitted: number;
}

const resolveToJsonValue = (value: unknown, key: string): unknown => {
  if (
    value === null ||
    (typeof value !== "object" &&
      typeof value !== "function" &&
      // SerializeJSONProperty consults toJSON on BigInt primitives too.
      typeof value !== "bigint")
  ) {
    return value;
  }
  // Read toJSON once: an accessor returning different values on each get must
  // behave exactly as it does under JSON.stringify. Reflect.apply invokes the
  // captured function directly — a member-defined `.call` is never consulted.
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  return typeof toJSON === "function" ? Reflect.apply(toJSON, value, [key]) : value;
};

const isUnserializable = (value: unknown): boolean =>
  value === undefined || typeof value === "function" || typeof value === "symbol";

const isPrimitiveJsonResult = (value: unknown): boolean =>
  value === null || (typeof value !== "object" && typeof value !== "function");

/** ToPrimitive(hint): a callable Symbol.toPrimitive wins (null/undefined is
 * absent, a non-callable throws), then valueOf/toString in hint order —
 * non-callable members are skipped and the first primitive result wins. */
const toPrimitiveForJson = (value: object, hint: "number" | "string"): unknown => {
  const exotic = (value as Record<symbol, unknown>)[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== "function") {
      throw new TypeError("Cannot convert object to primitive value");
    }
    const result = Reflect.apply(exotic, value, [hint]);
    if (!isPrimitiveJsonResult(result)) {
      throw new TypeError("Cannot convert object to primitive value");
    }
    return result;
  }
  const order = hint === "number" ? ["valueOf", "toString"] : ["toString", "valueOf"];
  for (const name of order) {
    const fn = (value as Record<string, unknown>)[name];
    if (typeof fn !== "function") continue;
    const result = Reflect.apply(fn, value, []);
    if (isPrimitiveJsonResult(result)) return result;
  }
  throw new TypeError("Cannot convert object to primitive value");
};

// Slot reads are captured once at module load: the spec's internal-slot check
// is intrinsic, so reading the prototype method per call would let a runtime
// patch to e.g. Number.prototype.valueOf change which objects count as boxes.
const booleanValueOf = Boolean.prototype.valueOf;
const bigintValueOf = BigInt.prototype.valueOf;

/**
 * SerializeJSONProperty unboxes [[NumberData]] via ToNumber and [[StringData]]
 * via ToString, so own valueOf/toString/Symbol.toPrimitive members run for
 * those two; [[BooleanData]] and [[BigIntData]] come from the raw internal
 * slot, so member overrides never run there. util.types predicates read the
 * slot directly — cross-realm wrappers qualify, proxies and impostors report
 * false without running a getPrototypeOf trap, and no user code executes on
 * the hot path. Slotless values stay objects and fall back to enumeration,
 * matching the engine.
 */
const unboxJsonPrimitive = (value: object): unknown => {
  if (NodeUtil.types.isNumberObject(value)) {
    const primitive = toPrimitiveForJson(value, "number");
    if (typeof primitive === "bigint" || typeof primitive === "symbol") {
      throw new TypeError("Cannot convert object to number");
    }
    return Number(primitive);
  }
  if (NodeUtil.types.isStringObject(value)) {
    const primitive = toPrimitiveForJson(value, "string");
    if (typeof primitive === "symbol") {
      throw new TypeError("Cannot convert a Symbol value to a string");
    }
    return String(primitive);
  }
  if (NodeUtil.types.isBooleanObject(value)) {
    return Reflect.apply(booleanValueOf, value, []);
  }
  if (NodeUtil.types.isBigIntObject(value)) {
    return Reflect.apply(bigintValueOf, value, []);
  }
  return value;
};

const prepareJsonMember = (member: unknown, key: string): unknown => {
  const resolved = resolveToJsonValue(member, key);
  return resolved !== null && typeof resolved === "object"
    ? unboxJsonPrimitive(resolved)
    : resolved;
};

/** LengthOfArrayLike's ToLength: ToNumber (ToPrimitive for objects, so a
 * valueOf returning a bigint throws like the engine — `Number()` alone would
 * accept it), then ToIntegerOrInfinity clamped to [0, 2^53-1]. */
const toLengthForJson = (value: unknown): number => {
  const primitive =
    (typeof value === "object" && value !== null) || typeof value === "function"
      ? toPrimitiveForJson(value, "number")
      : value;
  if (typeof primitive === "bigint") {
    throw new TypeError("Cannot convert a BigInt value to a number");
  }
  if (typeof primitive === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a number");
  }
  const n = Number(primitive);
  if (!Number.isFinite(n)) return n === Infinity ? 2 ** 53 - 1 : 0;
  return Math.min(Math.max(Math.trunc(n), 0), 2 ** 53 - 1);
};

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** The engine's max string length: V8's String::kMaxLength on 64-bit,
 * JavaScriptCore's (Bun) 2^31-1. `JSON.stringify` throws
 * RangeError("Invalid string length") past it; this walk must bound work the
 * same way rather than traverse toward a string that can never exist. */
const MAX_JSON_STRING_LENGTH = IS_BUN ? 0x7fffffff : 0x1fffffe8;

// Node >= 22.3 and Bun both expose the brand check; a forged
// { rawJSON: string } shape (null proto + frozen is constructible by hand)
// must not emit raw text, so only the intrinsic is trusted. The shape check
// below remains the fallback for engines lacking it.
const nativeIsRawJson = (JSON as unknown as { isRawJSON?: (value: unknown) => boolean }).isRawJSON;

const isRawJsonObject = (value: object): value is { readonly rawJSON: string } => {
  if (nativeIsRawJson !== undefined) {
    return nativeIsRawJson(value);
  }
  if (Object.getPrototypeOf(value) !== null || !Object.isFrozen(value)) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value);
  return (
    names.length === 1 &&
    names[0] === "rawJSON" &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    typeof (value as { rawJSON?: unknown }).rawJSON === "string"
  );
};

/**
 * `JSON.stringify`'s traversal with an explicit stack — decoded projection
 * values can nest past the serializer's recursion limit, and bounding them
 * must not throw. Mirrors the spec: one toJSON call per member (functions
 * included, array members keyed by index), boxed primitives unbox, rawJSON
 * wrappers emit their payload verbatim, array holes emit `null`,
 * unserializable object members are skipped, cycles throw, and output past
 * the engine's string limit throws RangeError.
 */
const emitJson = (value: unknown, write: (text: string) => void): void => {
  const ancestors = new Set<unknown>();
  const stack: Array<JsonWalkFrame> = [];
  let writtenLength = 0;
  const emitChunk = (text: string): void => {
    writtenLength += text.length;
    if (writtenLength > MAX_JSON_STRING_LENGTH) {
      throw new RangeError("Invalid string length");
    }
    write(text);
  };
  const emit = (member: unknown, inArray: boolean): void => {
    if (member === null || typeof member !== "object") {
      // The member is already prepared: toJSON ran, boxes unboxed. Emit the
      // scalar directly — delegating to JSON.stringify here would invoke a
      // function- or bigint-valued toJSON result's hook a second time.
      if (isUnserializable(member)) {
        // Root-level unserializable values emit nothing at all — native
        // JSON.stringify returns undefined; array members emit null and
        // object members are skipped by the caller before emit runs.
        if (inArray) emitChunk("null");
        return;
      }
      if (typeof member === "bigint") {
        throw new TypeError("Do not know how to serialize a BigInt");
      }
      emitChunk(JSON.stringify(member as string | number | boolean));
      return;
    }
    if (ancestors.has(member)) {
      throw new TypeError("Converting circular structure to JSON");
    }
    ancestors.add(member);
    if (Array.isArray(member)) {
      // SerializeJSONArray reads LengthOfArrayLike once: ToLength coerces
      // array-like (proxy-provided) lengths — 1.5 walks one element.
      const length = toLengthForJson(member.length);
      // Every element emits at least one character plus a separator, so a
      // length past half the string limit can never complete — V8 rejects
      // before visiting element 0, and this walk does the same instead of
      // traversing toward the overflow. JavaScriptCore has no preflight: it
      // visits members and fails on output size, so a throwing getter must
      // still surface there.
      if (!IS_BUN && length * 2 > MAX_JSON_STRING_LENGTH) {
        throw new RangeError("Invalid string length");
      }
      emitChunk("[");
      stack.push({
        container: member,
        keys: undefined,
        length,
        index: 0,
        emitted: 0,
      });
    } else if (isRawJsonObject(member)) {
      // rawJSON wrappers carry pre-serialized JSON; the engine emits it
      // verbatim instead of enumerating the wrapper.
      ancestors.delete(member);
      emitChunk(member.rawJSON);
    } else {
      emitChunk("{");
      stack.push({
        container: member as Record<string, unknown>,
        keys: Object.keys(member),
        length: 0,
        index: 0,
        emitted: 0,
      });
    }
  };
  emit(prepareJsonMember(value, ""), false);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const bound = frame.keys === undefined ? frame.length : frame.keys.length;
    if (frame.index >= bound) {
      ancestors.delete(frame.container);
      emitChunk(frame.keys === undefined ? "]" : "}");
      stack.pop();
      continue;
    }
    if (frame.keys !== undefined) {
      const key = frame.keys[frame.index]!;
      frame.index += 1;
      const member = (frame.container as Record<string, unknown>)[key];
      const resolved = prepareJsonMember(member, key);
      if (isUnserializable(resolved)) {
        continue;
      }
      if (frame.emitted > 0) {
        emitChunk(",");
      }
      frame.emitted += 1;
      emitChunk(JSON.stringify(key));
      emitChunk(":");
      emit(resolved, false);
    } else {
      const memberIndex = frame.index;
      frame.index += 1;
      const member = (frame.container as ReadonlyArray<unknown>)[memberIndex];
      if (frame.emitted > 0) {
        emitChunk(",");
      }
      frame.emitted += 1;
      emit(prepareJsonMember(member, String(memberIndex)), true);
    }
  }
};

export function stringifyJsonDeep(value: unknown): string | undefined {
  const chunks: Array<string> = [];
  emitJson(value, (text) => {
    chunks.push(text);
  });
  return chunks.length === 0 ? undefined : chunks.join("");
}

/**
 * Byte length of `JSON.stringify(value)` computed with the same explicit-stack
 * walk — billing deep decoded rows must not materialize or overflow on them.
 */
export function bytesOfJson(value: unknown): number {
  let total = 0;
  emitJson(value, (text) => {
    total += Buffer.byteLength(text, "utf8");
  });
  return total;
}

/** Ordinary history-page cost: one projected row (item is nested once). */
export function projectedRowEncodedBytes(row: OrchestrationV2ProjectedTurnItem): number {
  return bytesOfJson(row);
}

/**
 * Bounded-snapshot cost: local rows also land in `projection.turnItems`, so
 * charge the nested item a second time. Inherited rows only appear in the
 * visible list.
 */
export function projectedRowBoundedSnapshotEncodedBytes(
  row: OrchestrationV2ProjectedTurnItem,
  threadId: ThreadId | string,
): number {
  const rowBytes = projectedRowEncodedBytes(row);
  if (row.visibility === "local" || String(row.sourceThreadId) === String(threadId)) {
    return rowBytes + bytesOfJson(row.item);
  }
  return rowBytes;
}

function renumberPositions(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ProjectedTurnItem[] {
  return items.map((row, position) => (row.position === position ? row : { ...row, position }));
}

function encodeCursorPayload(payload: ThreadHistoryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function encodeThreadHistoryCursor(input: {
  readonly snapshotSequence: number;
  readonly sourceThreadId: ThreadId | string;
  readonly sourceItemId: TurnItemId | string;
  readonly sourceItemOrdinal: number;
  readonly position: number;
}): string {
  return encodeCursorPayload({
    v: 2,
    seq: input.snapshotSequence,
    sth: threadHistoryCursorThreadTag(input.sourceThreadId),
    so: input.sourceItemOrdinal,
    sih: threadHistoryCursorItemTag(input.sourceItemId),
    p: input.position,
  });
}

export function decodeThreadHistoryCursor(cursor: string): ThreadHistoryCursorPayload {
  if (cursor.length === 0 || cursor.length > THREAD_HISTORY_CURSOR_MAX_LENGTH) {
    throw new InvalidThreadHistoryCursorError();
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new InvalidThreadHistoryCursorError();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    ((parsed as { v: unknown }).v !== 1 && (parsed as { v: unknown }).v !== 2) ||
    !("seq" in parsed) ||
    typeof (parsed as { seq: unknown }).seq !== "number" ||
    !Number.isInteger((parsed as { seq: number }).seq) ||
    (parsed as { seq: number }).seq < 0 ||
    !("p" in parsed) ||
    typeof (parsed as { p: unknown }).p !== "number" ||
    !Number.isInteger((parsed as { p: number }).p) ||
    (parsed as { p: number }).p < 0
  ) {
    throw new InvalidThreadHistoryCursorError();
  }
  if ((parsed as { v: number }).v === 1) {
    if (
      !("st" in parsed) ||
      typeof (parsed as { st: unknown }).st !== "string" ||
      (parsed as { st: string }).st.length === 0 ||
      !("si" in parsed) ||
      typeof (parsed as { si: unknown }).si !== "string" ||
      (parsed as { si: string }).si.length === 0
    ) {
      throw new InvalidThreadHistoryCursorError();
    }
    return parsed as ThreadHistoryCursorPayload;
  }
  if (
    !("sth" in parsed) ||
    typeof (parsed as { sth: unknown }).sth !== "string" ||
    (parsed as { sth: string }).sth.length !== THREAD_HISTORY_CURSOR_THREAD_TAG_LENGTH ||
    !("so" in parsed) ||
    typeof (parsed as { so: unknown }).so !== "number" ||
    !Number.isInteger((parsed as { so: number }).so) ||
    (parsed as { so: number }).so < 0 ||
    !("sih" in parsed) ||
    typeof (parsed as { sih: unknown }).sih !== "string" ||
    (parsed as { sih: string }).sih.length !== THREAD_HISTORY_CURSOR_THREAD_TAG_LENGTH
  ) {
    throw new InvalidThreadHistoryCursorError();
  }
  return parsed as ThreadHistoryCursorPayload;
}

export function isThreadHistoryTurnStart(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "user_message" &&
    (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn")
  );
}

/** Steering belongs to its existing turn and must not consume another page slot. */
export function isThreadHistoryUserTurn(item: OrchestrationV2TurnItem): boolean {
  return (
    isThreadHistoryTurnStart(item) && item.type === "user_message" && item.createdBy === "user"
  );
}

/**
 * Walk a chronological timeline backward from the exclusive end, collecting rows
 * through complete user turns. Histories without turn starts use row budgets
 * and always admit at least one row so oversized items cannot deadlock paging.
 * When the store reports it dropped rows below the fetched window
 * (`hasOlderHistory`), the page reports more history even though nothing older
 * was fetched.
 */
function selectOlderTimelinePage(input: {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly exclusiveEndIndex: number;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly rowEncodedBytes?: ((row: OrchestrationV2ProjectedTurnItem) => number) | undefined;
  readonly hasOlderHistory?: boolean | undefined;
}): SelectTimelinePageResult {
  const policy = input.policy ?? THREAD_HISTORY_PAGE_POLICY;
  const rowCost = input.rowEncodedBytes ?? projectedRowEncodedBytes;
  const end = Math.min(Math.max(input.exclusiveEndIndex, 0), input.items.length);
  if (end <= 0) {
    return { items: [], nextCursor: null, hasMoreHistory: false };
  }

  const selected: OrchestrationV2ProjectedTurnItem[] = [];
  let encodedBytes = 0;
  let userTurns = 0;
  let rawTurns = 0;
  const turnLimit = input.items.slice(0, end).some((row) => isThreadHistoryTurnStart(row.item))
    ? policy.maxUserTurns
    : undefined;
  for (let index = end - 1; index >= 0; index -= 1) {
    const row = input.items[index]!;
    const rowBytes = turnLimit === undefined ? rowCost(row) : 0;
    if (
      selected.length > 0 &&
      (turnLimit === undefined
        ? selected.length >= policy.maxItems || encodedBytes + rowBytes > policy.maxEncodedBytes
        : userTurns >= turnLimit || rawTurns >= THREAD_HISTORY_MAX_RAW_TURNS)
    ) {
      break;
    }
    selected.push(row);
    encodedBytes += rowBytes;
    if (isThreadHistoryUserTurn(row.item)) userTurns += 1;
    if (isThreadHistoryTurnStart(row.item)) rawTurns += 1;
  }
  selected.reverse();

  const oldest = selected[0];
  const oldestIndex = oldest
    ? input.items.findIndex(
        (row) =>
          row.sourceThreadId === oldest.sourceThreadId && row.sourceItemId === oldest.sourceItemId,
      )
    : -1;
  const hasMoreHistory = oldestIndex > 0 || input.hasOlderHistory === true;
  const nextCursor =
    hasMoreHistory && oldest
      ? encodeThreadHistoryCursor({
          snapshotSequence: input.snapshotSequence,
          sourceThreadId: oldest.sourceThreadId,
          sourceItemId: oldest.sourceItemId,
          sourceItemOrdinal: oldest.item.ordinal,
          position: oldest.position,
        })
      : null;

  return {
    items: renumberPositions(selected),
    nextCursor,
    hasMoreHistory,
  };
}

export function selectRecentTimelineWindow(input: {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly rowEncodedBytes?: ((row: OrchestrationV2ProjectedTurnItem) => number) | undefined;
  readonly hasOlderHistory?: boolean | undefined;
}): SelectTimelinePageResult {
  return selectOlderTimelinePage({
    items: input.items,
    exclusiveEndIndex: input.items.length,
    snapshotSequence: input.snapshotSequence,
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.rowEncodedBytes === undefined ? {} : { rowEncodedBytes: input.rowEncodedBytes }),
    ...(input.hasOlderHistory === undefined ? {} : { hasOlderHistory: input.hasOlderHistory }),
  });
}

function findCursorIndex(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  cursor: ThreadHistoryCursorPayload,
): number {
  const byIdentity = items.findIndex((row) =>
    cursor.v === 2
      ? threadHistoryCursorThreadTag(row.sourceThreadId) === cursor.sth &&
        row.item.ordinal === cursor.so &&
        threadHistoryCursorItemTag(row.sourceItemId) === cursor.sih
      : String(row.sourceThreadId) === cursor.st && String(row.sourceItemId) === cursor.si,
  );
  // A resolvable anchor is always inside the fetched window, and positions are
  // renumbered per window so `p` cannot order rows across windows. Guessing an
  // index from it would silently skip history, so a miss is a typed error;
  // the client refetches the bounded snapshot and repaginates.
  if (byIdentity === -1) {
    throw new InvalidThreadHistoryCursorError();
  }
  return byIdentity;
}

export function selectHistoryPageFromCursor(input: {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly cursor: string;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly hasOlderHistory?: boolean | undefined;
}): SelectTimelinePageResult {
  const decoded = decodeThreadHistoryCursor(input.cursor);
  const anchorIndex = findCursorIndex(input.items, decoded);
  return selectOlderTimelinePage({
    items: input.items,
    exclusiveEndIndex: anchorIndex,
    snapshotSequence: input.snapshotSequence,
    policy: input.policy ?? {
      ...THREAD_HISTORY_PAGE_POLICY,
      maxUserTurns: OLDER_THREAD_USER_TURN_LIMIT,
    },
    ...(input.hasOlderHistory === undefined ? {} : { hasOlderHistory: input.hasOlderHistory }),
  });
}

function isLocalProjectedRow(
  projection: OrchestrationV2ThreadProjection,
  row: OrchestrationV2ProjectedTurnItem,
): boolean {
  return row.visibility === "local" || String(row.sourceThreadId) === String(projection.thread.id);
}

/**
 * Visibility for superseded `run_interrupt_result` rows depends on a matching
 * `run_interrupt_request` in `turnItems`. Keep every small request item from the
 * full projection even when it sits outside the recent visible window, so a
 * later history page that introduces the matching result still has the request
 * available for live attempt/run reducers.
 */
function retainedInterruptRequestTurnItems(
  projection: OrchestrationV2ThreadProjection,
  visible: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2TurnItem[] {
  const visibleLocalIds = new Set<string>();
  for (const row of visible) {
    if (isLocalProjectedRow(projection, row)) {
      visibleLocalIds.add(String(row.sourceItemId));
    }
  }

  const retained: OrchestrationV2TurnItem[] = [];
  for (const item of projection.turnItems) {
    if (item.type !== "run_interrupt_request") {
      continue;
    }
    // Already covered by local turnItems for the visible window.
    if (visibleLocalIds.has(String(item.id))) {
      continue;
    }
    retained.push(item);
  }
  return retained;
}

function localTurnItemsForVisibleWindow(
  projection: OrchestrationV2ThreadProjection,
  visible: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2TurnItem[] {
  const localIds = new Set<string>();
  for (const row of visible) {
    if (isLocalProjectedRow(projection, row)) {
      localIds.add(String(row.sourceItemId));
    }
  }
  if (localIds.size === 0) {
    return [];
  }
  return projection.turnItems.filter((item) => localIds.has(String(item.id)));
}

function messagesForBoundedProjection(
  projection: OrchestrationV2ThreadProjection,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ThreadProjection["messages"] {
  const retainedMessageIds = new Set<string>();
  for (const item of turnItems) {
    if ("messageId" in item) {
      retainedMessageIds.add(String(item.messageId));
    }
  }

  const latestRun = projection.runs.reduce<(typeof projection.runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  const retainedRunIds = new Set<string>();
  for (const run of projection.runs) {
    if (
      run.id === latestRun?.id ||
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting" ||
      run.status === "queued"
    ) {
      retainedRunIds.add(String(run.id));
      retainedMessageIds.add(String(run.userMessageId));
    }
  }

  return projection.messages.filter(
    (message) =>
      retainedMessageIds.has(String(message.id)) ||
      (message.runId !== null && retainedRunIds.has(String(message.runId))) ||
      message.delegatedCompletion !== undefined,
  );
}

/**
 * Max local turn ordinal over the authoritative full projection turnItems.
 * Used as a cheap partial-timeline watermark so old missing turn-item updates
 * cannot append newest when the bounded window has no local rows.
 */
export function computeLatestLocalTurnOrdinal(
  turnItems: ReadonlyArray<{ readonly ordinal: number }>,
): number | null {
  let latest: number | null = null;
  for (const item of turnItems) {
    if (latest === null || item.ordinal > latest) {
      latest = item.ordinal;
    }
  }
  return latest;
}

/**
 * Encoded timeline contribution for a bounded snapshot: visible rows plus the
 * duplicated local turnItems and any retained interrupt-request dependencies.
 */
export function boundedTimelineEncodedBytes(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): number {
  let total = 0;
  for (const row of input.visibleTurnItems) {
    total += projectedRowEncodedBytes(row);
  }
  for (const item of input.turnItems) {
    total += bytesOfJson(item);
  }
  return total;
}

/**
 * Builds a partial thread projection with full control-plane arrays and a
 * bounded recent timeline window plus matching local turnItems.
 */
export function buildBoundedThreadProjection(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly hasOlderHistory?: boolean | undefined;
}): BoundedProjectionResult {
  const policy = input.policy ?? THREAD_HISTORY_PAGE_POLICY;
  const threadId = input.projection.thread.id;
  const controlProjection = {
    ...input.projection,
    plans: input.projection.plans.filter((plan) => plan.status === "active"),
    contextHandoffs: input.projection.contextHandoffs.filter(
      (handoff) => handoff.status === "pending" || handoff.status === "ready",
    ),
  };
  const latestLocalTurnOrdinal = computeLatestLocalTurnOrdinal(input.projection.turnItems);

  // Reserve bytes for small interrupt-request dependencies that may sit outside
  // the recent window but are required for visibility of results inside it.
  const dependencyReserve = (() => {
    // Upper bound: all request items in the full projection. Window selection
    // uses this reserve so the final contribution stays under the cap.
    let reserve = 0;
    for (const item of controlProjection.turnItems) {
      if (item.type === "run_interrupt_request") {
        reserve += bytesOfJson(item);
      }
    }
    return reserve;
  })();
  const controlBytes = bytesOfJson({
    ...controlProjection,
    messages: [],
    turnItems: [],
    visibleTurnItems: [],
  });
  const windowBudget = Math.max(
    0,
    policy.maxEncodedBytes - dependencyReserve - controlBytes - 1_024,
  );
  const windowPolicy: ThreadHistoryPagePolicy = {
    maxUserTurns: policy.maxUserTurns,
    maxItems: policy.maxItems,
    // Zero still admits the first row via the at-least-one rule.
    maxEncodedBytes: windowBudget,
  };

  const window = selectRecentTimelineWindow({
    items: controlProjection.visibleTurnItems,
    snapshotSequence: input.snapshotSequence,
    policy: windowPolicy,
    rowEncodedBytes: (row) => projectedRowBoundedSnapshotEncodedBytes(row, threadId),
    ...(input.hasOlderHistory === undefined ? {} : { hasOlderHistory: input.hasOlderHistory }),
  });
  const visibleTurnItems = renumberPositions(window.items);
  const windowTurnItems = localTurnItemsForVisibleWindow(controlProjection, visibleTurnItems);
  const dependencyTurnItems = retainedInterruptRequestTurnItems(
    controlProjection,
    visibleTurnItems,
  );
  const turnItemById = new Map<string, OrchestrationV2TurnItem>();
  for (const item of windowTurnItems) {
    turnItemById.set(String(item.id), item);
  }
  for (const item of dependencyTurnItems) {
    turnItemById.set(String(item.id), item);
  }
  const turnItems = [...turnItemById.values()];

  const visiblePlanIds = new Set(
    turnItems.flatMap((item) =>
      item.type === "proposed_plan" || item.type === "todo_list" ? [String(item.planId)] : [],
    ),
  );
  const visibleHandoffIds = new Set(
    turnItems.flatMap((item) => (item.type === "handoff" ? [String(item.contextHandoffId)] : [])),
  );
  const plans = input.projection.plans
    .filter((plan) => plan.status === "active" || visiblePlanIds.has(String(plan.id)))
    .map((plan) =>
      plan.status === "active"
        ? plan
        : plan.kind === "proposed_plan"
          ? { ...plan, markdown: "", detailInTurnItem: true as const }
          : { ...plan, explanation: undefined, detailInTurnItem: true as const },
    );
  const contextHandoffs = input.projection.contextHandoffs
    .filter(
      (handoff) =>
        handoff.status === "pending" ||
        handoff.status === "ready" ||
        visibleHandoffIds.has(String(handoff.id)),
    )
    .map((handoff) =>
      handoff.status === "pending" || handoff.status === "ready"
        ? handoff
        : { ...handoff, summaryText: "", detailInTurnItem: true as const },
    );

  const projection = {
    ...controlProjection,
    plans,
    contextHandoffs,
    messages: messagesForBoundedProjection(controlProjection, turnItems),
    turnItems,
    visibleTurnItems,
  };
  return {
    projection,
    historyCursor: window.nextCursor,
    hasMoreHistory: window.hasMoreHistory,
    // Always from the full projection so inherited-only windows still carry a
    // watermark for partial live reducers.
    latestLocalTurnOrdinal,
    payloadBudgetExceeded: bytesOfJson(projection) > policy.maxEncodedBytes,
  };
}

/**
 * Result of `selectHistoryPageFromCursor` split by failure class so transport
 * handlers can surface invalid cursors as typed client errors instead of
 * internal failures. Shared by the HTTP history endpoint and the WS
 * `getThreadHistoryPage` RPC.
 */
export function selectHistoryPageFromCursorOrError(
  input: Parameters<typeof selectHistoryPageFromCursor>[0],
):
  | { readonly _tag: "ok"; readonly page: SelectTimelinePageResult }
  | { readonly _tag: "invalid_cursor" }
  | { readonly _tag: "error"; readonly cause: unknown } {
  try {
    return { _tag: "ok", page: selectHistoryPageFromCursor(input) };
  } catch (cause) {
    if (cause instanceof InvalidThreadHistoryCursorError) {
      return { _tag: "invalid_cursor" };
    }
    return { _tag: "error", cause };
  }
}

export type GetThreadProjectionCompatResult = OrchestrationV2ThreadProjection & {
  readonly snapshotSequence: number;
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly latestLocalTurnOrdinal: number | null;
  readonly payloadBudgetExceeded: boolean;
};

/**
 * Shapes a bounded snapshot window for the legacy `getThreadProjection` RPC.
 * The timeline fields carry the bounded recent window while the metadata is
 * spread flat over the projection fields, so clients decoding the historical
 * `OrchestrationV2ThreadProjection` schema still get a valid projection and
 * newer clients receive the cursor to page older history.
 */
export function buildGetThreadProjectionResult(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly snapshotSequence: number;
  readonly policy?: ThreadHistoryPagePolicy | undefined;
  readonly hasOlderHistory?: boolean | undefined;
}): GetThreadProjectionCompatResult {
  const bounded = buildBoundedThreadProjection(input);
  return {
    ...bounded.projection,
    snapshotSequence: input.snapshotSequence,
    historyCursor: bounded.historyCursor,
    hasMoreHistory: bounded.hasMoreHistory,
    latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
    payloadBudgetExceeded: bounded.payloadBudgetExceeded,
  };
}
