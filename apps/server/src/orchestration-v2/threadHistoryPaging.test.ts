import {
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as NodeVM from "node:vm";

import {
  buildBoundedThreadProjection,
  buildGetThreadProjectionResult,
  boundedTimelineEncodedBytes,
  bytesOfJson,
  computeLatestLocalTurnOrdinal,
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  isThreadHistoryTurnStart,
  isThreadHistoryUserTurn,
  projectedRowBoundedSnapshotEncodedBytes,
  projectedRowEncodedBytes,
  selectHistoryPageFromCursor,
  selectHistoryPageFromCursorOrError,
  selectRecentTimelineWindow,
  stringifyJsonDeep,
  threadHistoryCursorItemTag,
  threadHistoryCursorThreadTag,
  THREAD_HISTORY_CURSOR_MAX_LENGTH,
  THREAD_HISTORY_PAGE_POLICY,
} from "./threadHistoryPaging.ts";
import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const THREAD = ThreadId.make("thread-1");
const RUN = RunId.make("run-interrupt-1");
const NODE = NodeId.make("node-interrupt-1");

function makeRow(
  index: number,
  options?: { readonly outputBytes?: number },
): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make(`item-${index}`);
  const output =
    options?.outputBytes !== undefined ? "x".repeat(options.outputBytes) : `output-${index}`;
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: id,
    item: {
      id,
      type: "command_execution",
      threadId: THREAD,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed",
      title: `Command ${index}`,
      input: `cmd-${index}`,
      output,
      exitCode: 0,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    },
  };
}

function interruptItem(
  id: string,
  type: "run_interrupt_request" | "run_interrupt_result",
  ordinal: number,
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    type,
    threadId: THREAD,
    runId: RUN,
    nodeId: NODE,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: type,
    message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  } as OrchestrationV2TurnItem;
}

function interruptRow(
  index: number,
  type: "run_interrupt_request" | "run_interrupt_result",
): OrchestrationV2ProjectedTurnItem {
  const item = interruptItem(
    type === "run_interrupt_request" ? "interrupt-req" : "interrupt-res",
    type,
    index + 1,
  );
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: item.id,
    item,
  };
}

function makeProjection(visibleTurnItems: OrchestrationV2ProjectedTurnItem[]) {
  return {
    thread: {
      id: THREAD,
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: THREAD,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
    },
    runs: [{ id: "run-1" }],
    attempts: [{ id: "attempt-1" }],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [{ id: "req-1" }],
    messages: [],
    plans: [],
    turnItems: visibleTurnItems.map((row) => row.item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: NOW,
  } as unknown as Parameters<typeof buildBoundedThreadProjection>[0]["projection"];
}

describe("threadHistoryPaging", () => {
  it("builds a resumable bounded socket snapshot frame", () => {
    const projection = makeProjection(Array.from({ length: 90 }, (_, index) => makeRow(index)));
    const item = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 23,
      projection,
    });

    expect(item.kind).toBe("snapshot");
    expect(item.snapshotSequence).toBe(23);
    expect(item.projection.visibleTurnItems).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    expect(item.historyCursor).not.toBeNull();
    expect(item.hasMoreHistory).toBe(true);
    expect(item.latestLocalTurnOrdinal).toBe(90);
    expect(item.payloadBudgetExceeded).toBe(false);
  });

  it("keeps background turns with user turns, with main's 150-turn fan-out ceiling", () => {
    const items = Array.from({ length: 161 }, (_, turn) => {
      const row = makeRow(turn * 2);
      if (row.item.type !== "command_execution") throw new Error("Expected command fixture");
      const prompt: OrchestrationV2ProjectedTurnItem = {
        ...row,
        item: {
          ...row.item,
          type: "user_message",
          createdBy: turn === 0 ? "user" : "agent",
          creationSource: "provider",
          inputIntent: "turn_start",
          messageId: MessageId.make(`prompt-${turn}`),
          text: `Prompt ${turn}`,
          attachments: [],
        },
      };
      return [prompt, makeRow(turn * 2 + 1)];
    }).flat();
    const first = selectRecentTimelineWindow({ items, snapshotSequence: 1 });
    expect(first.items).toHaveLength(300);
    expect(first.items[0]?.sourceItemId).toBe("item-22");
    const older = selectHistoryPageFromCursor({
      items,
      cursor: first.nextCursor!,
      snapshotSequence: 1,
    });
    expect(older.items).toHaveLength(22);
    expect(older.hasMoreHistory).toBe(false);
    expect([...older.items, ...first.items].map((row) => row.sourceItemId)).toEqual(
      items.map((row) => row.sourceItemId),
    );
  });

  it("encodes opaque cursors with stable source identity", () => {
    const cursor = encodeThreadHistoryCursor({
      snapshotSequence: 9,
      sourceThreadId: THREAD,
      sourceItemId: TurnItemId.make("item-4"),
      sourceItemOrdinal: 4,
      position: 3,
    });
    expect(cursor.includes("{")).toBe(false);
    expect(decodeThreadHistoryCursor(cursor)).toEqual({
      v: 2,
      seq: 9,
      sth: threadHistoryCursorThreadTag(THREAD),
      so: 4,
      sih: threadHistoryCursorItemTag(TurnItemId.make("item-4")),
      p: 3,
    });
  });

  it("anchors v2 cursors by ordinal so unbounded item ids fit the cursor cap", () => {
    // TurnItemId and ThreadId are unbounded strings — a cursor embedding a
    // multi-KB id would exceed THREAD_HISTORY_CURSOR_MAX_LENGTH and strand
    // older history. v2 carries the item ordinal and a digest of the thread
    // id instead, so neither can inflate the cursor.
    const longThreadId = ThreadId.make(`thread-${"t".repeat(4_000)}`);
    const items = Array.from({ length: 6 }, (_, index) => {
      const row = makeRow(index);
      const id = TurnItemId.make(`item-${index}-${"i".repeat(4_000)}`);
      return {
        ...row,
        sourceThreadId: longThreadId,
        sourceItemId: id,
        item: { ...row.item, id, threadId: longThreadId },
      };
    });
    const page = selectRecentTimelineWindow({
      items,
      snapshotSequence: 4,
      policy: { maxItems: 3, maxEncodedBytes: 10_000_000 },
    });
    expect(page.nextCursor).not.toBeNull();
    expect(page.nextCursor!.length).toBeLessThanOrEqual(THREAD_HISTORY_CURSOR_MAX_LENGTH);
    const older = selectHistoryPageFromCursorOrError({
      items,
      cursor: page.nextCursor!,
      snapshotSequence: 4,
      policy: { maxItems: 3, maxEncodedBytes: 10_000_000 },
    });
    expect(older._tag).toBe("ok");
    if (older._tag === "ok") {
      expect(older.page.items.map((row) => row.sourceItemId)).toEqual(
        items.slice(0, 3).map((row) => row.sourceItemId),
      );
    }
  });

  it("still decodes v1 item-id cursors issued before the upgrade", () => {
    const v1Cursor = Buffer.from(
      JSON.stringify({ v: 1, seq: 9, st: "thread-1", si: "item-3", p: 3 }),
      "utf8",
    ).toString("base64url");
    expect(decodeThreadHistoryCursor(v1Cursor)).toEqual({
      v: 1,
      seq: 9,
      st: "thread-1",
      si: "item-3",
      p: 3,
    });
    const items = Array.from({ length: 6 }, (_, index) => makeRow(index));
    const result = selectHistoryPageFromCursorOrError({
      items,
      cursor: v1Cursor,
      snapshotSequence: 9,
      policy: { maxItems: 3, maxEncodedBytes: 10_000_000 },
    });
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.page.items.map((row) => row.sourceItemId)).toEqual([
        "item-0",
        "item-1",
        "item-2",
      ]);
    }
  });

  it("keeps thread digests distinct for ids with lone surrogates", () => {
    // utf8 folds lone surrogates to U+FFFD, which would alias these two legal
    // ids onto one anchor; the tag must hash a lossless encoding instead.
    const first = ThreadId.make("thread-\ud800");
    const second = ThreadId.make("thread-\ud801");
    expect(first).not.toBe(second);
    expect(threadHistoryCursorThreadTag(first)).not.toBe(threadHistoryCursorThreadTag(second));
  });

  it("serializes deep values with JSON.stringify semantics", () => {
    const withToJson = Object.assign(() => "never", { toJSON: () => "via-toJSON" });
    const indexed = { toJSON: (key: string) => `key=${key}` };
    const fixture = {
      boxed: new Number(12),
      boxedString: new String("boxed"),
      boxedBoolean: new Boolean(false),
      fn: withToJson,
      dropped: () => "missing",
      list: (() => {
        // Unserializable members (holes and undefined alike) emit null.
        const withHole: Array<unknown> = Array.from({ length: 3 });
        withHole[0] = indexed;
        withHole[2] = new Number(7);
        return withHole;
      })(),
      nested: { deep: [{ ok: true }] },
    };
    expect(stringifyJsonDeep(fixture)).toBe(JSON.stringify(fixture));
    expect(bytesOfJson(fixture)).toBe(Buffer.byteLength(JSON.stringify(fixture), "utf8"));
    // Depth past the recursive serializer's stack must still work.
    let deep: unknown = "leaf";
    for (let i = 0; i < 7_000; i += 1) {
      deep = { child: deep };
    }
    expect(stringifyJsonDeep(deep)).toHaveLength(10 * 7_000 + 6);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stringifyJsonDeep(cyclic)).toThrow(TypeError);
  });

  it("matches JSON.stringify when toJSON mutates the rest of the payload", () => {
    // An accessor's toJSON must be read exactly once per serialization.
    let reads = 0;
    const guarded = {};
    Object.defineProperty(guarded, "toJSON", {
      get() {
        reads += 1;
        return () => `read-${reads}`;
      },
    });
    const container = { guarded };
    expect(stringifyJsonDeep(container)).toBe('{"guarded":"read-1"}');
    expect(reads).toBe(1);

    // Keys are snapshotted but members are read lazily, so an earlier toJSON
    // can still delete or replace a later member — same as the native walk.
    // Each serializer gets a fresh target since traversal itself mutates it.
    const buildMutating = () => {
      const target: Record<string, unknown> = {};
      target.first = { toJSON: () => (delete target.doomed, "a") };
      target.doomed = "x";
      target.keep = 1;
      return target;
    };
    expect(stringifyJsonDeep(buildMutating())).toBe(JSON.stringify(buildMutating()));
    expect(stringifyJsonDeep({ keep: 1, doomed: undefined })).toBe('{"keep":1}');

    // Array length is snapshotted before member toJSON runs.
    const buildList = () => {
      const list: Array<unknown> = ["original"];
      list.unshift({
        toJSON: () => {
          list.push("appended");
          list[1] = "mutated";
          return 0;
        },
      });
      return list;
    };
    expect(stringifyJsonDeep(buildList())).toBe(JSON.stringify(buildList()));
  });

  it("treats boxed-primitive impostors like JSON.stringify", () => {
    // No [[NumberData]] slot: falls back to object enumeration, not a crash.
    const impostor = Object.create(Number.prototype);
    impostor.label = "not a number";
    const fixture = {
      impostor,
      proxiedBox: new Proxy(new Number(3), {}),
      // Number unboxes via ToNumber/ToPrimitive(number): own hooks run, then
      // the primitive result is numerically converted ("abc" -> NaN -> null).
      overridden: Object.assign(new Number(4), { valueOf: () => 99 }),
      primitiveHint: Object.assign(new Number(4), { [Symbol.toPrimitive]: () => 7 }),
      nullPrimitiveHint: Object.assign(new Number(4), { [Symbol.toPrimitive]: null }),
      stringValued: Object.assign(new Number(4), { valueOf: () => "99" }),
      objectValued: Object.assign(new Number(4), {
        valueOf: () => ({}),
        toString: () => "from-toString",
      }),
      nonCallableValueOf: Object.assign(new Number(4), {
        valueOf: 5,
        toString: () => "not-a-number",
      }),
      // String unboxes via ToString (toString before valueOf); Boolean keeps
      // the raw slot — member overrides never run for it.
      strOverride: Object.assign(new String("x"), { valueOf: () => "overridden" }),
      strToString: Object.assign(new String("x"), { toString: () => "TS" }),
      boolOverride: Object.assign(new Boolean(false), { valueOf: () => true }),
      boolThrowing: Object.assign(new Boolean(false), {
        valueOf: () => {
          throw new Error("never called");
        },
      }),
    };
    expect(stringifyJsonDeep(fixture)).toBe(JSON.stringify(fixture));
    expect(bytesOfJson(fixture)).toBe(Buffer.byteLength(JSON.stringify(fixture), "utf8"));

    // Cross-realm wrappers carry the slot without our realm's prototype.
    const crossRealm = NodeVM.runInNewContext(
      "({ n: new Number(4), b: new Boolean(false), s: new String('x') })",
    ) as { n: object; b: object; s: object };
    expect(stringifyJsonDeep(crossRealm)).toBe(JSON.stringify(crossRealm));
  });

  it("does not re-invoke toJSON on a prepared scalar", () => {
    // A function whose first toJSON returns itself: the engine sees the
    // function result and emits null — it never calls toJSON a second time.
    const buildFunction = () => {
      let calls = 0;
      const fn = (() => "never") as (() => string) & { toJSON: () => unknown };
      fn.toJSON = () => ((calls += 1), calls === 1 ? fn : "second call");
      return { fn, calls: () => calls };
    };
    const ours = buildFunction();
    const native = buildFunction();
    expect(stringifyJsonDeep([ours.fn])).toBe(JSON.stringify([native.fn]));
    expect(ours.calls()).toBe(1);

    // BigInt primitives consult toJSON with the property key, like objects.
    const bigintProto = BigInt.prototype as { toJSON?: (key: string) => unknown };
    const originalToJSON = bigintProto.toJSON;
    bigintProto.toJSON = function (key: string) {
      return `key=${key}`;
    };
    try {
      expect(stringifyJsonDeep({ a: 1n })).toBe(JSON.stringify({ a: 1n }));
    } finally {
      if (originalToJSON === undefined) {
        delete bigintProto.toJSON;
      } else {
        bigintProto.toJSON = originalToJSON;
      }
    }
    // A toJSON result that is still a BigInt throws — never a malformed
    // `{"x":}` from restarting serialization on the prepared value.
    bigintProto.toJSON = function () {
      return 1n;
    };
    try {
      expect(() => stringifyJsonDeep({ x: 1n })).toThrow(TypeError);
      expect(() => {
        JSON.stringify({ x: 1n });
      }).toThrow(TypeError);
    } finally {
      if (originalToJSON === undefined) {
        delete bigintProto.toJSON;
      } else {
        bigintProto.toJSON = originalToJSON;
      }
    }
    // A surviving BigInt still throws like the native serializer.
    expect(() => stringifyJsonDeep({ a: 1n })).toThrow(TypeError);
    expect(() => stringifyJsonDeep({ a: Object(5n) })).toThrow(TypeError);
  });

  it("coerces array length like LengthOfArrayLike", () => {
    const proxied = new Proxy([1, 2], {
      get: (target, key) => (key === "length" ? 1.5 : Reflect.get(target, key)),
    });
    expect(stringifyJsonDeep(proxied)).toBe(JSON.stringify(proxied));
    // A function with a shadowed .call still runs as toJSON — invocation never
    // consults the member.
    const fn = (() => "never") as (() => string) & { toJSON: () => string };
    Object.defineProperty(fn, "call", { value: null });
    fn.toJSON = () => "via-toJSON";
    expect(stringifyJsonDeep({ fn })).toBe(JSON.stringify({ fn }));
  });

  it("applies ToNumber's BigInt rejection to object-valued array lengths", () => {
    // `Number(Object(1n))` accepts the boxed bigint, but ToNumber — which
    // LengthOfArrayLike routes through — rejects the primitive after
    // unwrapping, so native serialization throws.
    for (const length of [Object(1n), { valueOf: () => 1n }]) {
      const proxied = new Proxy([1, 2, 3], {
        get: (target, key) => (key === "length" ? length : Reflect.get(target, key)),
      });
      expect(() => stringifyJsonDeep(proxied)).toThrow(TypeError);
      expect(() => JSON.stringify(proxied)).toThrow(TypeError);
    }
  });

  it("rejects array lengths that can never fit the output string", () => {
    const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    if (isBun) {
      // JavaScriptCore has no length preflight: it visits elements and fails
      // on output size, so a throwing element getter surfaces its own error.
      const bunOverLimit = new Proxy([], {
        get: (target, key) => {
          if (key === "length") return 1_073_741_824;
          if (key === "0") throw new Error("visited");
          return Reflect.get(target, key);
        },
      });
      expect(() => stringifyJsonDeep(bunOverLimit)).toThrow("visited");
      expect(() => JSON.stringify(bunOverLimit)).toThrow("visited");
      return;
    }
    // V8 refuses before visiting element 0: every element emits at least one
    // character plus a separator, so a length past half the string limit is
    // unserializable. The walker must bound work the same way instead of
    // looping ~2^40 reads. 268,435,445 is V8's exact threshold
    // (String::kMaxLength / 2 + 1).
    const overLimit = new Proxy([], {
      get: (target, key) => {
        if (key === "length") return 268_435_445;
        if (key === "0") throw new Error("must not visit elements");
        return Reflect.get(target, key);
      },
    });
    expect(() => stringifyJsonDeep(overLimit)).toThrow(RangeError);
    expect(() => JSON.stringify(overLimit)).toThrow(RangeError);
    // Just under the threshold the engine walks — a throwing getter must
    // surface its own error, not a RangeError.
    const atLimit = new Proxy([], {
      get: (target, key) => {
        if (key === "length") return 268_435_444;
        if (key === "0") throw new Error("visited");
        return Reflect.get(target, key);
      },
    });
    expect(() => stringifyJsonDeep(atLimit)).toThrow("visited");
    expect(() => JSON.stringify(atLimit)).toThrow("visited");
  });

  it("emits JSON.rawJSON values verbatim like JSON.stringify", () => {
    // Node 24 exposes rawJSON ahead of the TS lib definitions.
    const rawJSON = (JSON as unknown as { rawJSON: (text: string) => object }).rawJSON;
    const fixture = { x: rawJSON("123"), nested: [rawJSON('"s"')] };
    expect(stringifyJsonDeep(fixture)).toBe(JSON.stringify(fixture));
    expect(stringifyJsonDeep(fixture)).toBe('{"x":123,"nested":["s"]}');
    // A parsed object carrying a rawJSON key is not a rawJSON wrapper —
    // JSON.parse output always has Object.prototype and is never frozen.
    const parsed = JSON.parse('{"rawJSON":"123"}') as unknown;
    expect(stringifyJsonDeep(parsed)).toBe(JSON.stringify(parsed));
    // The wrapper shape is forgeable by hand — only the intrinsic brand
    // distinguishes it, and the forged object serializes as an ordinary
    // object whose rawJSON string is escaped like any other.
    const forged = Object.freeze(
      Object.assign(Object.create(null) as Record<string, unknown>, {
        rawJSON: "not json",
      }),
    );
    expect(stringifyJsonDeep({ forged })).toBe(JSON.stringify({ forged }));
  });

  it("returns undefined for unserializable roots like JSON.stringify", () => {
    expect(stringifyJsonDeep(undefined)).toBe(JSON.stringify(undefined));
    expect(stringifyJsonDeep({ toJSON: () => undefined })).toBe(
      JSON.stringify({ toJSON: () => undefined }),
    );
    expect(stringifyJsonDeep(() => 1)).toBe(JSON.stringify(() => 1));
    expect(stringifyJsonDeep(Symbol("s"))).toBe(JSON.stringify(Symbol("s")));
    expect(bytesOfJson(undefined)).toBe(0);
    // Inside a container the same values still follow member rules.
    expect(stringifyJsonDeep([undefined, () => 1])).toBe(JSON.stringify([undefined, () => 1]));
  });

  it("anchors v2 cursors on the exact item when ordinals collide", () => {
    // Ordinals are not unique across producers; the item digest must pick the
    // exact anchor so the equal-ordinal sibling below it stays reachable.
    const items = Array.from({ length: 6 }, (_, index) => makeRow(index));
    const siblingId = TurnItemId.make("item-4b");
    const sibling = {
      ...items[4]!,
      sourceItemId: siblingId,
      item: { ...items[4]!.item, id: siblingId },
    };
    const itemsWithDuplicate = [...items.slice(0, 4), items[4]!, sibling, items[5]!];
    const cursor = encodeThreadHistoryCursor({
      snapshotSequence: 3,
      sourceThreadId: THREAD,
      sourceItemId: items[5]!.sourceItemId,
      sourceItemOrdinal: 6,
      position: 6,
    });
    const page = selectHistoryPageFromCursor({
      items: itemsWithDuplicate,
      cursor,
      snapshotSequence: 3,
      policy: { maxItems: 10, maxEncodedBytes: 10_000_000 },
    });
    expect(page.items.map((row) => row.sourceItemId)).toEqual([
      "item-0",
      "item-1",
      "item-2",
      "item-3",
      "item-4",
      "item-4b",
    ]);
    // Anchoring on the same-ordinal sibling instead also surfaces item-4 —
    // it sorts below the sibling at ordinal 5 and must stay reachable.
    const siblingCursor = encodeThreadHistoryCursor({
      snapshotSequence: 3,
      sourceThreadId: THREAD,
      sourceItemId: sibling.sourceItemId,
      sourceItemOrdinal: 5,
      position: 5,
    });
    const siblingPage = selectHistoryPageFromCursor({
      items: itemsWithDuplicate,
      cursor: siblingCursor,
      snapshotSequence: 3,
      policy: { maxItems: 10, maxEncodedBytes: 10_000_000 },
    });
    expect(siblingPage.items.map((row) => row.sourceItemId)).toEqual([
      "item-0",
      "item-1",
      "item-2",
      "item-3",
      "item-4",
    ]);
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeThreadHistoryCursor("not-valid")).toThrow(InvalidThreadHistoryCursorError);
    expect(() =>
      decodeThreadHistoryCursor(Buffer.from("{}", "utf8").toString("base64url")),
    ).toThrow(InvalidThreadHistoryCursorError);
  });

  it("rejects cursors longer than the maximum length before decoding", () => {
    const oversized = "A".repeat(THREAD_HISTORY_CURSOR_MAX_LENGTH + 1);
    expect(() => decodeThreadHistoryCursor(oversized)).toThrow(InvalidThreadHistoryCursorError);
  });

  it("selects a recent window by item count", () => {
    const items = Array.from({ length: 120 }, (_, index) => makeRow(index));
    const page = selectRecentTimelineWindow({
      items,
      snapshotSequence: 4,
      policy: { maxItems: 10, maxEncodedBytes: 10_000_000 },
    });
    expect(page.items).toHaveLength(10);
    expect(page.items[0]?.sourceItemId).toBe("item-110");
    expect(page.items[9]?.sourceItemId).toBe("item-119");
    expect(page.hasMoreHistory).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    const cursor = decodeThreadHistoryCursor(page.nextCursor!);
    expect(cursor).toMatchObject({ v: 2, so: 111, seq: 4 });
  });

  it("always includes at least one pathological oversized item", () => {
    const items = [makeRow(0, { outputBytes: 2_000_000 }), makeRow(1, { outputBytes: 10 })];
    const page = selectRecentTimelineWindow({
      items,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes: 1_024 },
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.sourceItemId).toBe("item-1");
    expect(page.hasMoreHistory).toBe(true);

    const older = selectHistoryPageFromCursor({
      items,
      cursor: page.nextCursor!,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes: 1_024 },
    });
    expect(older.items).toHaveLength(1);
    expect(older.items[0]?.sourceItemId).toBe("item-0");
    expect(older.hasMoreHistory).toBe(false);
    expect(older.nextCursor).toBeNull();
  });

  it("rejects cursors whose anchor is missing from the fetched window", () => {
    const items = Array.from({ length: 5 }, (_, index) => makeRow(index));
    const cursor = encodeThreadHistoryCursor({
      snapshotSequence: 3,
      sourceThreadId: THREAD,
      sourceItemId: TurnItemId.make("item-missing"),
      sourceItemOrdinal: 999,
      position: 40,
    });
    // Positions are renumbered per window, so an unresolvable anchor has no
    // durable ordering key; guessing would silently skip history.
    const result = selectHistoryPageFromCursorOrError({
      items,
      cursor,
      snapshotSequence: 3,
      policy: { maxItems: 2, maxEncodedBytes: 10_000_000 },
    });
    expect(result._tag).toBe("invalid_cursor");
  });

  it("keeps cursor resolution stable when newer items append", () => {
    const initial = Array.from({ length: 20 }, (_, index) => makeRow(index));
    const recent = selectRecentTimelineWindow({
      items: initial,
      snapshotSequence: 2,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    const cursor = recent.nextCursor!;
    const grown = [...initial, makeRow(20), makeRow(21)];
    const older = selectHistoryPageFromCursor({
      items: grown,
      cursor,
      snapshotSequence: 5,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    expect(older.items.map((row) => row.sourceItemId)).toEqual([
      "item-10",
      "item-11",
      "item-12",
      "item-13",
      "item-14",
    ]);
    expect(older.hasMoreHistory).toBe(true);
  });

  it("builds a bounded projection that preserves non-timeline control state", () => {
    const full = makeProjection(Array.from({ length: 40 }, (_, index) => makeRow(index)));
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 7,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    expect(bounded.projection.runs).toEqual(full.runs);
    expect(bounded.projection.runtimeRequests).toEqual(full.runtimeRequests);
    expect(bounded.projection.attempts).toEqual(full.attempts);
    expect(bounded.projection.visibleTurnItems).toHaveLength(5);
    expect(bounded.projection.turnItems).toHaveLength(5);
    expect(bounded.hasMoreHistory).toBe(true);
    expect(bounded.historyCursor).not.toBeNull();
    expect(bounded.projection.visibleTurnItems.map((row) => row.position)).toEqual([0, 1, 2, 3, 4]);
    // Watermark comes from the full projection, not the trimmed window.
    expect(bounded.latestLocalTurnOrdinal).toBe(40);
    expect(computeLatestLocalTurnOrdinal(full.turnItems)).toBe(40);
  });

  it("preserves linked control rows as one coherent graph", () => {
    const base = makeProjection(Array.from({ length: 40 }, (_, index) => makeRow(index)));
    const linked = {
      ...base,
      runs: [{ id: "run-linked", threadId: THREAD }],
      attempts: [{ id: "attempt-linked", runId: "run-linked" }],
      nodes: [{ id: "node-linked", runId: "run-linked", attemptId: "attempt-linked" }],
      providerThreads: [{ id: "provider-thread-linked", runId: "run-linked" }],
      providerTurns: [
        {
          id: "provider-turn-linked",
          providerThreadId: "provider-thread-linked",
          nodeId: "node-linked",
        },
      ],
      checkpointScopes: [{ id: "scope-linked", runId: "run-linked" }],
      checkpoints: [{ id: "checkpoint-linked", scopeId: "scope-linked" }],
    } as unknown as typeof base;

    const bounded = buildBoundedThreadProjection({
      projection: linked,
      snapshotSequence: 7,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });

    expect(bounded.projection.runs).toEqual(linked.runs);
    expect(bounded.projection.attempts).toEqual(linked.attempts);
    expect(bounded.projection.nodes).toEqual(linked.nodes);
    expect(bounded.projection.providerThreads).toEqual(linked.providerThreads);
    expect(bounded.projection.providerTurns).toEqual(linked.providerTurns);
    expect(bounded.projection.checkpointScopes).toEqual(linked.checkpointScopes);
    expect(bounded.projection.checkpoints).toEqual(linked.checkpoints);
  });

  it("carries a full-projection watermark when the bounded window is inherited-only", () => {
    const localOlder = makeRow(0);
    const localMid = makeRow(1);
    const inherited = {
      ...makeRow(2),
      visibility: "inherited" as const,
      sourceThreadId: ThreadId.make("parent-thread"),
      item: {
        ...makeRow(2).item,
        threadId: ThreadId.make("parent-thread"),
      },
    };
    // Full projection still has local turnItems even if the recent window is
    // only the inherited row (e.g. after aggressive byte budget on a large
    // local item that is not selected into the recent page). Use a synthetic
    // projection with local turnItems and inherited-only visible window.
    const full = makeProjection([localOlder, localMid, inherited]);
    // Force an inherited-only visible window by rebuilding with only inherited
    // visible rows while retaining full local turnItems for the watermark.
    const inheritedOnly = {
      ...full,
      visibleTurnItems: [inherited],
      turnItems: [localOlder.item, localMid.item],
    };
    const bounded = buildBoundedThreadProjection({
      projection: inheritedOnly,
      snapshotSequence: 2,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });
    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      String(inherited.sourceItemId),
    ]);
    expect(bounded.latestLocalTurnOrdinal).toBe(2);
    expect(computeLatestLocalTurnOrdinal([])).toBeNull();
  });

  it("retains an out-of-window run_interrupt_request needed by a visible result", () => {
    // Older request sits outside a 1-row recent window; result is visible alone.
    const request = interruptRow(0, "run_interrupt_request");
    const filler = makeRow(1);
    const result = interruptRow(2, "run_interrupt_result");
    const full = makeProjection([request, filler, result]);
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 3,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });

    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      "interrupt-res",
    ]);
    expect(bounded.projection.turnItems.map((item) => String(item.id)).sort()).toEqual([
      "interrupt-req",
      "interrupt-res",
    ]);
    expect(bounded.hasMoreHistory).toBe(true);
  });

  it("retains all run_interrupt_request items even when no result is in the initial window", () => {
    // Cold open: recent window is only filler. Request and result both live on
    // older pages, but the request must still ride in turnItems so a later
    // history page can introduce the result safely under live attempt updates.
    const request = interruptRow(0, "run_interrupt_request");
    const result = interruptRow(1, "run_interrupt_result");
    const recent = makeRow(2);
    const full = makeProjection([request, result, recent]);
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 4,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });

    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      "item-2",
    ]);
    expect(bounded.projection.turnItems.map((item) => String(item.id)).sort()).toEqual([
      "interrupt-req",
      "item-2",
    ]);
    expect(bounded.projection.turnItems.some((item) => item.type === "run_interrupt_request")).toBe(
      true,
    );
    expect(bounded.projection.turnItems.some((item) => item.type === "run_interrupt_result")).toBe(
      false,
    );
  });

  it("charges local row.item duplication when measuring bounded timeline bytes", () => {
    const rows = Array.from({ length: 8 }, (_, index) => makeRow(index, { outputBytes: 2_000 }));
    const full = makeProjection(rows);
    const maxEncodedBytes = 12_000;
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes },
    });

    const contribution = boundedTimelineEncodedBytes({
      visibleTurnItems: bounded.projection.visibleTurnItems,
      turnItems: bounded.projection.turnItems,
    });
    expect(contribution).toBeLessThanOrEqual(maxEncodedBytes);
    expect(bounded.projection.visibleTurnItems.length).toBeGreaterThan(0);
    expect(bounded.projection.visibleTurnItems.length).toBeLessThan(rows.length);

    // History pages only charge the projected row once (no turnItems copy).
    const historyPage = selectRecentTimelineWindow({
      items: rows,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes },
    });
    const historyBytes = historyPage.items.reduce(
      (sum, row) => sum + projectedRowEncodedBytes(row),
      0,
    );
    expect(historyBytes).toBeLessThanOrEqual(maxEncodedBytes);
    expect(historyPage.items.length).toBeGreaterThan(bounded.projection.visibleTurnItems.length);

    // Dual-cost for one local row exceeds the plain row cost.
    const sample = rows[0]!;
    expect(projectedRowBoundedSnapshotEncodedBytes(sample, THREAD)).toBeGreaterThan(
      projectedRowEncodedBytes(sample),
    );
  });

  it("allows a single pathological bounded row to exceed the configured cap", () => {
    const huge = makeRow(0, { outputBytes: 50_000 });
    const full = makeProjection([huge]);
    const maxEncodedBytes = 1_000;
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 1,
      policy: { maxItems: 10, maxEncodedBytes },
    });
    expect(bounded.projection.visibleTurnItems).toHaveLength(1);
    const contribution = boundedTimelineEncodedBytes({
      visibleTurnItems: bounded.projection.visibleTurnItems,
      turnItems: bounded.projection.turnItems,
    });
    expect(contribution).toBeGreaterThan(maxEncodedBytes);
  });

  it("exposes conservative default page budgets", () => {
    expect(THREAD_HISTORY_PAGE_POLICY.maxItems).toBeGreaterThanOrEqual(50);
    expect(THREAD_HISTORY_PAGE_POLICY.maxItems).toBeLessThanOrEqual(100);
    expect(THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes).toBe(1_048_576);
  });

  it("does not carry the full duplicated message table into a bounded snapshot", () => {
    const projection = makeProjection(Array.from({ length: 120 }, (_, index) => makeRow(index)));
    const full = {
      ...projection,
      messages: Array.from({ length: 2_000 }, (_, index) => ({
        id: MessageId.make(`message-${index}`),
        threadId: THREAD,
        runId: RunId.make(`old-run-${index}`),
        nodeId: null,
        role: "assistant" as const,
        text: "x".repeat(1_000),
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    } as typeof projection;

    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 9,
    });

    expect(bounded.projection.messages).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(bounded.projection), "utf8")).toBeLessThan(
      THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes + 100_000,
    );
  });

  it("omits historical control details that remain available from history items", () => {
    const projection = makeProjection(Array.from({ length: 200 }, (_, index) => makeRow(index)));
    const populated = {
      ...projection,
      plans: Array.from({ length: 120 }, (_, index) => ({
        id: `plan-${index}`,
        threadId: THREAD,
        runId: null,
        nodeId: `node-${index}`,
        status: "completed",
        kind: "proposed_plan",
        markdown: "p".repeat(2_097_152),
      })),
      contextHandoffs: Array.from({ length: 120 }, (_, index) => ({
        id: `handoff-${index}`,
        threadId: THREAD,
        targetRunId: "run-1",
        fromProviderThreadIds: [],
        toProviderThreadId: "provider-thread-1",
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "manual_context",
        status: "superseded",
        summaryMessageId: null,
        summaryText: "h".repeat(2_097_152),
        createdByProviderInstanceId: null,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    } as unknown as typeof projection;

    const bounded = buildBoundedThreadProjection({
      projection: projectThreadProjectionForWire(populated),
      snapshotSequence: 9,
    });
    const serializedBytes = Buffer.byteLength(JSON.stringify(bounded.projection), "utf8");

    expect(serializedBytes).toBeLessThanOrEqual(THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes);
    expect(bounded.payloadBudgetExceeded).toBe(false);
    expect(bounded.projection.plans).toEqual([]);
    expect(bounded.projection.contextHandoffs).toEqual([]);
    expect(populated.plans).toHaveLength(120);
    expect(
      populated.plans[0]?.kind === "proposed_plan" ? populated.plans[0].markdown.length : 0,
    ).toBe(2_097_152);
  });

  it("preserves oversized actionable state and reports the budget exception", () => {
    const projection = makeProjection([]);
    const actionable = {
      ...projection,
      plans: [
        {
          id: "plan-actionable",
          threadId: THREAD,
          runId: null,
          nodeId: "node-actionable",
          status: "active",
          kind: "proposed_plan",
          markdown: "a".repeat(2_097_152),
        },
      ],
    } as unknown as typeof projection;

    const bounded = buildBoundedThreadProjection({ projection: actionable, snapshotSequence: 9 });

    expect(bounded.payloadBudgetExceeded).toBe(true);
    expect(bounded.projection.plans[0]).toEqual(actionable.plans[0]);
  });

  it("keeps paged historical plan detail in the turn item and only status in its artifact", () => {
    const detail = "Implement the historical plan exactly.\n".repeat(1_000);
    const item = {
      ...makeRow(0).item,
      type: "proposed_plan",
      planId: "plan-historical-visible",
      markdown: detail,
      streaming: false,
    } as OrchestrationV2TurnItem;
    const row = {
      ...makeRow(0),
      sourceItemId: item.id,
      item,
    } as OrchestrationV2ProjectedTurnItem;
    const base = makeProjection([row]);
    const projection = {
      ...base,
      plans: [
        {
          id: "plan-historical-visible",
          threadId: THREAD,
          runId: null,
          nodeId: "node-historical-visible",
          status: "completed",
          kind: "proposed_plan",
          markdown: detail,
        },
      ],
    } as unknown as typeof base;

    const bounded = buildBoundedThreadProjection({ projection, snapshotSequence: 9 });

    expect(bounded.projection.visibleTurnItems[0]?.item).toMatchObject({
      type: "proposed_plan",
      markdown: detail,
    });
    expect(bounded.projection.plans[0]).toMatchObject({
      status: "completed",
      markdown: "",
      detailInTurnItem: true,
    });
    expect(bounded.payloadBudgetExceeded).toBe(false);
  });

  it("bounds the getThreadProjection compat response and pages it to the true end", () => {
    const turnCount = 30;
    const rows = Array.from({ length: turnCount }, (_, turn) => {
      const promptRow = makeRow(turn * 5);
      if (promptRow.item.type !== "command_execution") throw new Error("Expected command fixture");
      const prompt: OrchestrationV2ProjectedTurnItem = {
        ...promptRow,
        item: {
          ...promptRow.item,
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          messageId: MessageId.make(`prompt-${turn}`),
          text: `Prompt ${turn}`,
          attachments: [],
        },
      };
      return [prompt, ...Array.from({ length: 4 }, (_, i) => makeRow(turn * 5 + 1 + i))];
    }).flat();

    const full = makeProjection(rows);
    const result = buildGetThreadProjectionResult({
      projection: full,
      snapshotSequence: 7,
    });

    // The compat response is a projection (flat, legacy-decodable) plus
    // progressive-history metadata — never a bare truncated timeline.
    expect(result.thread.id).toBe(THREAD);
    expect(result.runs).toEqual(full.runs);
    expect(result.snapshotSequence).toBe(7);
    expect(result.hasMoreHistory).toBe(true);
    expect(result.historyCursor).not.toBeNull();
    expect(result.latestLocalTurnOrdinal).toBe(turnCount * 5);
    expect(result.payloadBudgetExceeded).toBe(false);

    // The window stops at a complete user-turn boundary.
    const window = result.visibleTurnItems;
    const first = window[0];
    expect(first).toBeDefined();
    expect(isThreadHistoryTurnStart(first!.item)).toBe(true);
    expect(window.filter((row) => isThreadHistoryUserTurn(row.item))).toHaveLength(
      THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
    );

    // Every older page the cursor yields is disjoint and reaches the start.
    const paged: OrchestrationV2ProjectedTurnItem[] = [];
    let cursor = result.historyCursor;
    while (cursor !== null) {
      const pageOrError = selectHistoryPageFromCursorOrError({
        items: rows,
        cursor,
        snapshotSequence: result.snapshotSequence,
      });
      expect(pageOrError._tag).toBe("ok");
      if (pageOrError._tag !== "ok") return;
      paged.unshift(...pageOrError.page.items);
      cursor = pageOrError.page.nextCursor;
    }
    expect([...paged, ...window].map((row) => row.sourceItemId)).toEqual(
      rows.map((row) => row.sourceItemId),
    );
  });

  it("bounds the compat response by rows and bytes on turn-less histories", () => {
    const rows = Array.from({ length: 300 }, (_, index) => makeRow(index));
    const full = makeProjection(rows);
    const result = buildGetThreadProjectionResult({
      projection: full,
      snapshotSequence: 3,
    });

    expect(result.visibleTurnItems).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    expect(result.hasMoreHistory).toBe(true);
    expect(
      boundedTimelineEncodedBytes({
        visibleTurnItems: result.visibleTurnItems,
        turnItems: result.turnItems,
      }),
    ).toBeLessThanOrEqual(THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes);

    const paged: OrchestrationV2ProjectedTurnItem[] = [];
    let cursor = result.historyCursor;
    let pages = 0;
    while (cursor !== null) {
      const pageOrError = selectHistoryPageFromCursorOrError({
        items: rows,
        cursor,
        snapshotSequence: result.snapshotSequence,
      });
      if (pageOrError._tag !== "ok") throw new Error(`unexpected ${pageOrError._tag}`);
      expect(pageOrError.page.items.length).toBeLessThanOrEqual(
        THREAD_HISTORY_PAGE_POLICY.maxItems,
      );
      paged.unshift(...pageOrError.page.items);
      cursor = pageOrError.page.nextCursor;
      pages += 1;
    }
    expect(pages).toBe(3);
    expect(paged).toHaveLength(300 - THREAD_HISTORY_PAGE_POLICY.maxItems);
    expect([...paged, ...result.visibleTurnItems].map((row) => row.sourceItemId)).toEqual(
      rows.map((row) => row.sourceItemId),
    );
  });

  it("reports payloadBudgetExceeded on the compat response for an oversized item", () => {
    const huge = makeRow(0, { outputBytes: 2_000_000 });
    const result = buildGetThreadProjectionResult({
      projection: makeProjection([huge]),
      snapshotSequence: 1,
    });

    expect(result.visibleTurnItems).toHaveLength(1);
    expect(result.hasMoreHistory).toBe(false);
    expect(result.historyCursor).toBeNull();
    expect(result.payloadBudgetExceeded).toBe(true);
  });

  it("tags malformed cursors distinctly from other page failures", () => {
    const rows = Array.from({ length: 10 }, (_, index) => makeRow(index));
    const invalid = selectHistoryPageFromCursorOrError({
      items: rows,
      cursor: "not-valid",
      snapshotSequence: 1,
    });
    expect(invalid._tag).toBe("invalid_cursor");

    const cursor = encodeThreadHistoryCursor({
      snapshotSequence: 1,
      sourceThreadId: THREAD,
      sourceItemId: TurnItemId.make("item-5"),
      sourceItemOrdinal: 6,
      position: 5,
    });
    const ok = selectHistoryPageFromCursorOrError({
      items: rows,
      cursor,
      snapshotSequence: 1,
    });
    expect(ok._tag).toBe("ok");
    if (ok._tag === "ok") {
      expect(ok.page.items.map((row) => row.sourceItemId)).toEqual([
        "item-0",
        "item-1",
        "item-2",
        "item-3",
        "item-4",
      ]);
    }
  });
});
