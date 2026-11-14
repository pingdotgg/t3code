import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import {
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationThreadSnapshot,
} from "./orchestrationCache.ts";
import {
  COMPACT_THREAD_CACHE_SCHEMA_VERSION,
  decodeStoredThreadSnapshot,
  makeStoredThreadSnapshotEncoder,
} from "./threadCacheEncoding.ts";

const environmentId = EnvironmentId.make("environment-thread-cache");
const otherThreadId = ThreadId.make("thread-parent");
const encodeOriginal = Schema.encodeEffect(
  Schema.fromJsonString(StoredOrchestrationThreadSnapshot),
);

const notice = (index: number, threadId = v2ThreadId) => ({
  id: TurnItemId.make(`notice-${threadId}-${index}`),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: index,
  status: "completed" as const,
  title: index % 2 === 0 ? null : `  Notice ${index}  `,
  startedAt: DateTime.add(v2Now, { seconds: index }),
  completedAt: index % 3 === 0 ? null : v2Now,
  updatedAt: v2Now,
  type: "system_notice" as const,
  message: `Notice ${index}`,
});

// Inherited rows come first, as in a fork, then local rows whose items alias turnItems.
function projectionWith(count: number): OrchestrationV2ThreadProjection {
  const inherited = Array.from({ length: 5 }, (_, index) => notice(index, otherThreadId));
  const turnItems = Array.from({ length: count }, (_, index) => notice(index));
  return {
    ...v2Projection,
    turnItems,
    visibleTurnItems: [
      ...inherited.map((item) => ({
        position: 0,
        visibility: "inherited" as const,
        sourceThreadId: otherThreadId,
        sourceItemId: item.id,
        item,
      })),
      ...turnItems.map((item) => ({
        position: 0,
        visibility: "local" as const,
        sourceThreadId: v2ThreadId,
        sourceItemId: item.id,
        item,
      })),
    ].map((row, position) => ({ ...row, position })),
  };
}

const stored = (projection: OrchestrationV2ThreadProjection) => ({
  environmentId,
  threadId: v2ThreadId,
  snapshot: { snapshotSequence: 7, projection, historyCursor: null, hasMoreHistory: false },
});

describe("cooperative thread cache encoding", () => {
  it.effect("matches the plain encoding across chunks, cold and after rows change", () =>
    Effect.gen(function* () {
      const encode = makeStoredThreadSnapshotEncoder({ format: "full" });
      const original = (projection: OrchestrationV2ThreadProjection) =>
        encodeOriginal({
          ...stored(projection),
          schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        });
      const cold = projectionWith(70);
      expect(yield* encode(stored(cold))).toEqual(Option.some(yield* original(cold)));

      const [first, ...rest] = cold.turnItems;
      const replaced = { ...first!, message: "Edited" };
      const added = notice(70);
      const warm: OrchestrationV2ThreadProjection = {
        ...cold,
        turnItems: [replaced, ...rest, added],
        visibleTurnItems: [
          ...cold.visibleTurnItems.map((row) =>
            row.item === first ? { ...row, item: replaced } : row,
          ),
          {
            position: cold.visibleTurnItems.length,
            visibility: "local",
            sourceThreadId: v2ThreadId,
            sourceItemId: added.id,
            item: added,
          },
        ],
      };
      expect(yield* encode(stored(warm))).toEqual(Option.some(yield* original(warm)));
    }),
  );

  it.effect("round-trips the compact format", () =>
    Effect.gen(function* () {
      const projection = projectionWith(40);
      const encoded = yield* makeStoredThreadSnapshotEncoder({ format: "compact" })(
        stored(projection),
      );
      const decoded = yield* decodeStoredThreadSnapshot(Option.getOrThrow(encoded));
      expect(decoded.snapshot.projection).toEqual(projection);
    }),
  );

  it.effect("encodes nothing once the rows exceed the budget, warm or cold", () =>
    Effect.gen(function* () {
      const small = stored(projectionWith(4));
      const large = stored(projectionWith(200));
      const limit = Option.getOrThrow(
        yield* makeStoredThreadSnapshotEncoder({ format: "full" })(small),
      ).length;
      for (const format of ["full", "compact"] as const) {
        const encode = makeStoredThreadSnapshotEncoder({ format, maxJsonLength: limit });
        expect(Option.isSome(yield* encode(small))).toBe(true);
        expect(Option.isNone(yield* encode(large))).toBe(true);
        expect(Option.isNone(yield* encode(large))).toBe(true);
      }
    }),
  );
});

describe("thread cache records", () => {
  const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
  const BODY = "a body long enough to count ".repeat(4);
  const COMMAND_OUTPUT = "only the items carry this output";

  const base = (id: string, ordinal: number) => ({
    id: TurnItemId.make(id),
    threadId: v2ThreadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
  });

  const messageId = MessageId.make("message-1");
  const answer = {
    ...base("answer", 1),
    type: "assistant_message" as const,
    messageId,
    text: BODY,
    streaming: false,
  };
  const command = {
    ...base("command", 2),
    type: "command_execution" as const,
    input: "pwd",
    output: COMMAND_OUTPUT,
    exitCode: 0,
  };
  const rowOf = <Item extends { readonly id: TurnItemId }>(item: Item, position: number) => ({
    position,
    visibility: "local" as const,
    sourceThreadId: v2ThreadId,
    sourceItemId: item.id,
    item,
  });
  const bodyProjection: OrchestrationV2ThreadProjection = {
    ...v2Projection,
    messages: [
      {
        id: messageId,
        threadId: v2ThreadId,
        runId: null,
        nodeId: null,
        role: "assistant",
        text: BODY,
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: v2Now,
        updatedAt: v2Now,
      },
    ],
    turnItems: [answer, command],
    visibleTurnItems: [rowOf(answer, 0), rowOf(command, 1)],
  };
  const snapshot: OrchestrationV2ThreadDetailSnapshot = {
    snapshotSequence: 3,
    projection: bodyProjection,
  };
  const record = { environmentId: ENVIRONMENT_ID, threadId: v2ThreadId, snapshot };
  const occurrences = (text: string, part: string) => text.split(part).length - 1;

  const encodeStoredThreadSnapshot = (input: typeof record) =>
    makeStoredThreadSnapshotEncoder({ format: "compact" })(input).pipe(
      Effect.map(Option.getOrThrow),
    );

  it.effect("writes each item once", () =>
    Effect.gen(function* () {
      const raw = yield* encodeStoredThreadSnapshot(record);
      expect(JSON.parse(raw).schemaVersion).toBe(COMPACT_THREAD_CACHE_SCHEMA_VERSION);
      expect(occurrences(raw, COMMAND_OUTPUT)).toBe(1);
    }),
  );

  it.effect("decodes to the same projection, with one object per item", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeStoredThreadSnapshot(yield* encodeStoredThreadSnapshot(record));
      const { projection: loaded } = decoded.snapshot;
      expect(loaded).toEqual(bodyProjection);
      expect(loaded.visibleTurnItems[0]!.item).toBe(loaded.turnItems[0]);
      expect(loaded.visibleTurnItems[1]!.item).toBe(loaded.turnItems[1]);
    }),
  );

  it.effect("shares the copies of a record that could not be compacted", () =>
    Effect.gen(function* () {
      // A hidden item between two visible ones: `turnItems` no longer starts with the visible rows.
      const hidden = {
        ...base("hidden", 3),
        type: "reasoning" as const,
        text: "not shown",
        streaming: false,
      };
      const uncompacted = {
        ...bodyProjection,
        turnItems: [answer, hidden, command],
      };
      const raw = yield* encodeStoredThreadSnapshot({
        ...record,
        snapshot: { ...snapshot, projection: uncompacted },
      });
      expect(JSON.parse(raw).snapshot.turnItemsOmitLocalVisible).toBe(false);
      const { projection: loaded } = (yield* decodeStoredThreadSnapshot(raw)).snapshot;
      expect(loaded).toEqual(uncompacted);
      expect(loaded.visibleTurnItems[0]!.item).toBe(loaded.turnItems[0]);
      expect(loaded.visibleTurnItems[1]!.item).toBe(loaded.turnItems[2]);
    }),
  );

  it.effect("shares the matching copies of a full record", () =>
    Effect.gen(function* () {
      const raw = yield* encodeOriginal({
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        ...record,
      });
      expect(occurrences(raw, COMMAND_OUTPUT)).toBe(2);
      const { projection: loaded } = (yield* decodeStoredThreadSnapshot(raw)).snapshot;
      expect(loaded).toEqual(bodyProjection);
      expect(loaded.visibleTurnItems[1]!.item).toBe(loaded.turnItems[1]);
    }),
  );

  it.effect("keeps both copies of a full record when they differ", () =>
    Effect.gen(function* () {
      const stale = { ...command, output: "an older output" };
      const raw = yield* encodeOriginal({
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        ...record,
        snapshot: {
          ...snapshot,
          projection: {
            ...bodyProjection,
            visibleTurnItems: [rowOf(answer, 0), rowOf(stale, 1)],
          },
        },
      });
      const { projection: loaded } = (yield* decodeStoredThreadSnapshot(raw)).snapshot;
      expect(loaded.turnItems[1]).toMatchObject({ output: COMMAND_OUTPUT });
      expect(loaded.visibleTurnItems[1]!.item).toMatchObject({ output: "an older output" });
    }),
  );
});
