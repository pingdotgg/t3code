import {
  THREAD_HISTORY_COMPACTED_FIELD_CHARS,
  THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES,
} from "./threadHistoryPaging.ts";

// Member-key chains from the payload root to Schema.Unknown subtrees — inside
// those, every shape decodes, so object members may be dropped entirely. The
// per-type table is keyed on the turn-item `type`; the shared list covers
// member names that are free-form on every schema that declares them:
// `answers` is always ProviderUserInputAnswers (Record<String, Unknown>),
// `context` is always OrchestrationMessageContext (records is an
// Array<Schema.Unknown> decoded through a forward-compatible array), and
// `questionAnswer` is always UserInputAttachmentAnswerPayload.
const THREAD_HISTORY_UNTYPED_PATHS: Readonly<Record<string, ReadonlyArray<readonly string[]>>> = {
  dynamic_tool: [["input"], ["output"]],
};
const THREAD_HISTORY_UNTYPED_PATHS_ANY: ReadonlyArray<readonly string[]> = [
  ["answers"],
  ["context", "records"],
  ["questionAnswer", "answers"],
];

// Record-valued members decode from any subset of keys, so tail members may be
// dropped to meet the budget — but their values stay typed and must keep their
// own required keys (unlike Unknown subtrees, which are free-form throughout).
const THREAD_HISTORY_DROPPABLE_KEY_PATHS_ANY: ReadonlyArray<readonly string[]> = [
  ["questionAnswer", "questionTextById"],
  ["questionAnswer", "attachmentsByQuestionId"],
];

// Interactive arrays whose members each carry required structure — dropping a
// question, approval option, or plan step silently changes what the user is
// asked or shown, so these keep every member and let string truncation carry
// the budget. A preserved array's floor may exceed the row cap; the stored
// input already bounds it, and the skeleton stays decode-safe over budget.
const THREAD_HISTORY_PRESERVE_MEMBER_PATHS: Readonly<
  Record<string, ReadonlyArray<readonly string[]>>
> = {
  approval_request: [["options"]],
  todo_list: [["steps"]],
  user_input_request: [["questions"], ["questions", "options"]],
};

// Strings never truncate below this floor: union discriminators, branded ids,
// enum values and timestamps are all short, and a truncated discriminator
// fails schema decode while a truncated long-form string still decodes. A
// payload whose typed skeleton exceeds the cap stays decode-safe but over
// budget — the cap is reached whenever dynamic-key surfaces carry the weight.
const THREAD_HISTORY_COMPACTED_STRING_FLOOR_BYTES = 256;

// Identity members never truncate at all. Cursors and cohort joins compare
// against stored row ids (cursor si/st, runId/turnId/nodeId/parentItemId/
// nativeItemRef, checkpoint/handoff/transfer refs); a truncated id still
// decodes but no longer matches the stored row, which strands pagination on
// an empty terminal page. Suffix matching covers every *Id/*Ref/*Cursor-style
// member, including ones added to payload schemas later. Oversized identity
// strings are preserved whole — the byte cap yields to cursor correctness.
const THREAD_HISTORY_IDENTITY_MEMBER_KEY =
  /(?:_id|Id|Ids|Ref|Refs|Cursor|Cursors|Key|Keys|Hash|Token|Thumbprint|Digest|Signature|Nonce|Url|Uri)$/;
const isIdentityMemberKey = (key: string): boolean =>
  key === "id" || key === "key" || THREAD_HISTORY_IDENTITY_MEMBER_KEY.test(key);

// Bounded previews feed SQLite JSON1 functions (json_extract on $.inputIntent,
// $.createdBy, cohort ids), whose parser rejects documents nested past ~800
// levels in this build — a preview can stay byte-bounded and still be
// unreadable. Two bounds apply:
//
// - Soft: arrays empty and Schema.Unknown/Record objects collapse to `{}` —
//   both decode-safe by construction (no Tuple/NonEmpty arrays exist in the
//   payload union). Typed objects instead keep every key and keep recursing:
//   a legitimately deep recursive structure (SnapShotAccessibilityNode
//   children) carries required members like `bounds` at the same depth, and
//   stubbing those would fail schema decode.
// - Hard: every container stubs. Only unreachable-by-schema content lives
//   here — a member Unknown that never listed in the path tables — so the
//   stub is a bound, not a shaping decision; if it ever invalidated a typed
//   object, decode fails loudly rather than returning corrupt data.
const THREAD_HISTORY_PREVIEW_SOFT_DEPTH = 256;
export const THREAD_HISTORY_PREVIEW_HARD_DEPTH = 512;

const serializedJsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const truncateUtf8 = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  // A UTF-8 sequence is at most 4 bytes, so at most 4 retries land on a
  // complete boundary — strict decoding keeps multi-byte text inside the cap.
  for (let end = maxBytes; end > maxBytes - 4 && end > 0; end -= 1) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      // NonEmpty fields reject "" — a whitespace-only cut must keep its bytes.
      return decoded.trimEnd() || decoded;
    } catch {
      // the cut landed mid-sequence; shorten and retry
    }
  }
  return "";
};

type CompactionPolicy = {
  /** Subtree is Schema.Unknown — object members may drop and values are free-form. */
  readonly untyped: boolean;
  /** This object level is a Record — tail members may drop, values stay typed. */
  readonly droppableKeys: boolean;
  /** Member is identity-named — its string value must survive verbatim. */
  readonly preserveString: boolean;
  /** This array is interactive structure — keep every member regardless of budget. */
  readonly preserveMembers: boolean;
  readonly untypedPaths: ReadonlyArray<readonly string[]>;
  readonly droppablePaths: ReadonlyArray<readonly string[]>;
  readonly preservePaths: ReadonlyArray<readonly string[]>;
  /**
   * Memoized serialized sizes for *input* subtrees. Budget retries and
   * iterated passes re-measure the same input nodes — deep recursive payloads
   * otherwise pay O(depth²) JSON.stringify work per pass.
   */
  readonly sizes: WeakMap<object, number>;
};

const inputJsonBytes = (sizes: WeakMap<object, number>, value: unknown): number => {
  if (typeof value !== "object" || value === null) return serializedJsonBytes(value);
  const cached = sizes.get(value);
  if (cached !== undefined) return cached;
  const size = serializedJsonBytes(value);
  sizes.set(value, size);
  return size;
};

const memberPaths = (paths: ReadonlyArray<readonly string[]>, key: string) =>
  paths.filter((path) => path[0] === key && path.length > 1).map((path) => path.slice(1));

const pathEndsHere = (paths: ReadonlyArray<readonly string[]>, key: string) =>
  paths.some((path) => path.length === 1 && path[0] === key);

// The smallest a subtree can compact to: strings stop at the string floor
// (identity members never shrink at all), objects keep every key, and array
// members all count — measuring the floor never drops a member the way the
// budgeting pass can. Used to decide whether an array keeps every member.
const floorSerializedBytes = (policy: CompactionPolicy, value: unknown): number => {
  if (typeof value === "string") {
    if (policy.preserveString) return serializedJsonBytes(value);
    return (
      Math.min(Buffer.byteLength(value, "utf8"), THREAD_HISTORY_COMPACTED_STRING_FLOOR_BYTES) + 2
    );
  }
  if (value === null || typeof value !== "object") return serializedJsonBytes(value);
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return serializedJsonBytes(value);
  }
  if (Array.isArray(value)) {
    const elementPolicy = policy.untyped ? policy : { ...policy, droppableKeys: false };
    return value.reduce(
      (total, element) => total + 8 + floorSerializedBytes(elementPolicy, element),
      2,
    );
  }
  let total = 2;
  for (const [key, member] of Object.entries(value)) {
    total +=
      8 +
      Buffer.byteLength(key, "utf8") +
      floorSerializedBytes(
        {
          untyped: policy.untyped || pathEndsHere(policy.untypedPaths, key),
          droppableKeys: pathEndsHere(policy.droppablePaths, key),
          preserveString: isIdentityMemberKey(key),
          preserveMembers: pathEndsHere(policy.preservePaths, key),
          untypedPaths: memberPaths(policy.untypedPaths, key),
          droppablePaths: memberPaths(policy.droppablePaths, key),
          preservePaths: memberPaths(policy.preservePaths, key),
          sizes: policy.sizes,
        },
        member,
      );
  }
  return total;
};

/**
 * Bounds one over-cap payload member for the bounded-window path. Shape is
 * always decode-safe: text truncates (never below the string floor), arrays
 * drop tail members past a cumulative serialized-byte budget, and objects keep
 * every key with recursively compacted values — typed turn-item structs nest
 * to arbitrary depth (SnapShotAccessibilityNode.children is recursive), so no
 * fixed depth limit can collapse containers safely. Array members budget by
 * their compacted size and may empty entirely — every array in the payload
 * union is a plain Schema.Array, never a Tuple or NonEmpty — which is what
 * finally bounds self-similar chains like nested accessibility nodes. Members
 * under Schema.Unknown paths drop tail object keys since any shape decodes
 * there; Record-valued members drop tail keys too but keep their values typed.
 */
const compactProjectedHistoryValue = (
  value: unknown,
  policy: CompactionPolicy,
  maxBytes: number,
  depth: number,
): unknown => {
  if (typeof value === "string") {
    if (policy.preserveString) return value;
    return truncateUtf8(value, Math.max(maxBytes, THREAD_HISTORY_COMPACTED_STRING_FLOOR_BYTES));
  }
  if (value === null || typeof value !== "object") return value;
  // Non-plain objects (DateTime, Option, Uint8Array) are not JSON trees —
  // rebuilding them member-wise produces corrupt shapes that fail schema
  // validation. They are always small enough to pass through whole.
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return value;
  }
  // Depth before the size early-return: a small-but-deep subtree must still
  // collapse or the stored preview stays unreachable to JSON1.
  if (depth >= THREAD_HISTORY_PREVIEW_HARD_DEPTH) {
    return Array.isArray(value) ? [] : {};
  }
  if (depth >= THREAD_HISTORY_PREVIEW_SOFT_DEPTH) {
    if (Array.isArray(value)) return [];
    if (policy.untyped || policy.droppableKeys) return {};
    // Typed objects keep every key past the soft cap — required members must
    // not stub — while their own array/unknown members still collapse and the
    // hard cap bounds whatever object-only depth remains.
  }
  // The size fast path is only depth-safe when the subtree cannot out-nest
  // the cap: every level costs at least two serialized bytes ("[]"), so a
  // subtree of `sizeBytes` reaches at most depth + sizeBytes/2. Anything
  // deeper must recurse so the stubs above can fire.
  const sizeBytes = inputJsonBytes(policy.sizes, value);
  if (
    sizeBytes <= maxBytes &&
    depth + Math.floor(sizeBytes / 2) <= THREAD_HISTORY_PREVIEW_SOFT_DEPTH
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const members: unknown[] = [];
    let cumulativeBytes = 0;
    // Greedy first-come budgeting lets head members spend the whole budget and
    // drops identical tail members a fair share would have kept — a pending
    // user_input_request loses questions its compacted form could afford.
    // When every member's floor fits the budget, all members survive and split
    // the slack; tail members only drop when the floors genuinely overflow.
    const floorSizes = value.map((element) =>
      floorSerializedBytes(policy.untyped ? policy : { ...policy, droppableKeys: false }, element),
    );
    const floorTotal = floorSizes.reduce((total, size) => total + 8 + size, 0);
    const keepAll = policy.preserveMembers || floorTotal <= maxBytes;
    const slack =
      keepAll && !policy.preserveMembers && value.length > 0
        ? (maxBytes - floorTotal) / value.length
        : 0;
    for (const [index, element] of value.entries()) {
      // Each element gets the budget that remains for it — or its floor plus
      // an equal slack share when all members are being kept. Members inside
      // the element compact toward that same budget, so a near-budget element
      // can still overflow by its own keys and fixed skeleton — shrink the
      // element's budget until it fits, and drop it (plus the tail) when its
      // skeleton alone is over. That is what finally bounds self-similar
      // chains like nested accessibility nodes.
      const remaining = maxBytes - cumulativeBytes - 8;
      if (remaining <= 0 && !keepAll) break;
      const elementPolicy = policy.untyped ? policy : { ...policy, droppableKeys: false };
      let elementBudget = keepAll ? Math.max(1, Math.floor(floorSizes[index]! + slack)) : remaining;
      let compacted = compactProjectedHistoryValue(
        element,
        elementPolicy,
        elementBudget,
        depth + 1,
      );
      let elementBytes = serializedJsonBytes(compacted);
      const elementCap = keepAll ? maxBytes - cumulativeBytes - 8 : remaining;
      while (elementBytes > elementBudget && elementBudget > 1) {
        elementBudget = Math.max(1, Math.floor(elementBudget / 4));
        compacted = compactProjectedHistoryValue(element, elementPolicy, elementBudget, depth + 1);
        elementBytes = serializedJsonBytes(compacted);
      }
      if (elementBytes > elementCap && !policy.preserveMembers) break;
      cumulativeBytes += 8 + elementBytes;
      members.push(compacted);
    }
    return members;
  }
  const members: Record<string, unknown> = {};
  let cumulativeBytes = 0;
  for (const [key, member] of Object.entries(value)) {
    if (policy.untyped || policy.droppableKeys) {
      cumulativeBytes += 8 + Buffer.byteLength(key, "utf8") + inputJsonBytes(policy.sizes, member);
      if (cumulativeBytes > maxBytes) break;
    }
    members[key] = compactProjectedHistoryValue(
      member,
      {
        untyped: policy.untyped || pathEndsHere(policy.untypedPaths, key),
        droppableKeys: pathEndsHere(policy.droppablePaths, key),
        preserveString: isIdentityMemberKey(key),
        preserveMembers: pathEndsHere(policy.preservePaths, key),
        untypedPaths: memberPaths(policy.untypedPaths, key),
        droppablePaths: memberPaths(policy.droppablePaths, key),
        preservePaths: memberPaths(policy.preservePaths, key),
        sizes: policy.sizes,
      },
      maxBytes,
      depth + 1,
    );
  }
  return members;
};

const compactProjectedHistoryPayloadWithSizes = (
  payload: Record<string, unknown>,
  maxBytes: number,
  sizes: WeakMap<object, number>,
): Record<string, unknown> => {
  const untypedPaths = [
    ...THREAD_HISTORY_UNTYPED_PATHS_ANY,
    ...(THREAD_HISTORY_UNTYPED_PATHS[payload.type as string] ?? []),
  ];
  const preservePaths = THREAD_HISTORY_PRESERVE_MEMBER_PATHS[payload.type as string] ?? [];
  const compacted: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(payload)) {
    compacted[key] = compactProjectedHistoryValue(
      member,
      {
        untyped: pathEndsHere(untypedPaths, key),
        droppableKeys: pathEndsHere(THREAD_HISTORY_DROPPABLE_KEY_PATHS_ANY, key),
        preserveString: isIdentityMemberKey(key),
        preserveMembers: pathEndsHere(preservePaths, key),
        untypedPaths: memberPaths(untypedPaths, key),
        droppablePaths: memberPaths(THREAD_HISTORY_DROPPABLE_KEY_PATHS_ANY, key),
        preservePaths: memberPaths(preservePaths, key),
        sizes,
      },
      maxBytes,
      1,
    );
  }
  return compacted;
};

/**
 * Compacts a payload until its serialized form fits `maxBytes`. Fixed-key
 * objects keep every key, so the floor is the payload's required skeleton —
 * strings and arrays shrink toward it as the member budget quarters each
 * round. Once the budget reaches a single byte the skeleton is what it is;
 * every dynamic-key surface in the projection union is listed above, so the
 * skeleton is the schema's own fixed shape. Input sizes are memoized across
 * iterations so deep payloads stay linear per pass.
 */
export const compactProjectedHistoryPayloadToLimit = (
  payload: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> => {
  const sizes = new WeakMap<object, number>();
  let maxMemberBytes = THREAD_HISTORY_COMPACTED_FIELD_CHARS;
  for (;;) {
    const compacted = compactProjectedHistoryPayloadWithSizes(payload, maxMemberBytes, sizes);
    if (serializedJsonBytes(compacted) <= maxBytes || maxMemberBytes <= 1) return compacted;
    maxMemberBytes = Math.max(1, Math.floor(maxMemberBytes / 4));
  }
};

// Single-pass structural depth check — cheaper than parsing every small write
// just to learn its nesting. Only `{`/`[` outside string literals count.
export const jsonDepthExceeds = (json: string, maxDepth: number): boolean => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === 0x5c) escaped = true;
      else if (char === 0x22) inString = false;
      continue;
    }
    if (char === 0x22) inString = true;
    else if (char === 0x7b || char === 0x5b) {
      depth += 1;
      if (depth > maxDepth) return true;
    } else if (char === 0x7d || char === 0x5d) depth -= 1;
  }
  return false;
};

/**
 * Splices every container opened deeper than `maxDepth` out of JSON text,
 * leaving an empty container of the same kind. This runs on the raw text —
 * recursive parsers and serializers overflow their stack on nesting a
 * supported runtime can still store (a ~7,000-level payload parses fine under
 * Bun but overflows `JSON.stringify` under Node), so compaction must never
 * hand the unbounded text to `JSON.parse` first.
 */
const truncateJsonToDepth = (json: string, maxDepth: number): string => {
  const parts: string[] = [];
  let depth = 0;
  let index = 0;
  let copyStart = 0;
  const skipString = () => {
    index += 1;
    while (index < json.length) {
      const char = json.charCodeAt(index);
      if (char === 0x5c) index += 2;
      else if (char === 0x22) {
        index += 1;
        return;
      } else index += 1;
    }
  };
  while (index < json.length) {
    const char = json.charCodeAt(index);
    if (char === 0x22) {
      skipString();
      continue;
    }
    if (char === 0x7b || char === 0x5b) {
      if (depth >= maxDepth) {
        parts.push(json.slice(copyStart, index), char === 0x7b ? "{}" : "[]");
        index += 1;
        let inner = 0;
        while (index < json.length) {
          const innerChar = json.charCodeAt(index);
          if (innerChar === 0x22) {
            skipString();
            continue;
          }
          if (innerChar === 0x7b || innerChar === 0x5b) inner += 1;
          else if (innerChar === 0x7d || innerChar === 0x5d) {
            if (inner === 0) {
              index += 1;
              break;
            }
            inner -= 1;
          }
          index += 1;
        }
        copyStart = index;
        continue;
      }
      depth += 1;
      index += 1;
      continue;
    }
    if (char === 0x7d || char === 0x5d) {
      depth -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }
  parts.push(json.slice(copyStart));
  return parts.join("");
};

/**
 * Parses stored/encoded payload JSON for compaction. Over-deep documents are
 * depth-spliced on the text first so the parser and the compactor's own
 * `JSON.stringify` calls only ever see bounded nesting — the compactor then
 * applies its soft/hard rules to what remains, which is the same shape a
 * typed recursive payload would get from the depth policy alone.
 */
export const parseBoundedPayloadJson = (json: string): Record<string, unknown> =>
  JSON.parse(
    jsonDepthExceeds(json, THREAD_HISTORY_PREVIEW_HARD_DEPTH)
      ? truncateJsonToDepth(json, THREAD_HISTORY_PREVIEW_HARD_DEPTH)
      : json,
  ) as Record<string, unknown>;

/**
 * Write-time bounded preview stored next to the raw payload. Bounded reads
 * never touch `payload_json`, which keeps SQLite→JS transfer, JSON.parse, and
 * schema decode capped even when a payload nests beyond what SQLite's JSON1
 * parser can read — the preview is built by JSON.parse in JS, not by json_each.
 * Payloads get a preview when they exceed the byte cap OR the depth cap: a
 * deep-but-small raw payload would still push stored previews past what
 * JSON1 can parse (~800 levels), breaking every bounded-path extract. The
 * bounded parse depth-splices on the raw text first, so payloads deeper than
 * the JS parser/serializer stack still produce a preview instead of throwing.
 */
export const boundedPayloadPreviewJson = (payloadJson: string): string | null =>
  Buffer.byteLength(payloadJson, "utf8") <= THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES &&
  !jsonDepthExceeds(payloadJson, THREAD_HISTORY_PREVIEW_HARD_DEPTH)
    ? null
    : JSON.stringify(
        compactProjectedHistoryPayloadToLimit(
          parseBoundedPayloadJson(payloadJson),
          THREAD_HISTORY_MAX_ROW_PAYLOAD_BYTES,
        ),
      );

/**
 * Turn-item preview variant. A stored preview exists only when the raw
 * payload exceeded the row cap, so every preview is content that was dropped;
 * stamping `payloadTruncated` lets bounded reads flag the item and clients
 * recover the raw row through `orchestration.getThreadTurnItem`.
 */
export const boundedTurnItemPreviewJson = (payloadJson: string): string | null => {
  const previewJson = boundedPayloadPreviewJson(payloadJson);
  if (previewJson === null) return null;
  const preview = JSON.parse(previewJson) as Record<string, unknown>;
  preview["payloadTruncated"] = true;
  return JSON.stringify(preview);
};
