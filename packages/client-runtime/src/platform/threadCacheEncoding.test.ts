import {
  EnvironmentId,
  MessageId,
  TurnItemId,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import {
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationThreadSnapshot,
} from "./orchestrationCache.ts";
import {
  COMPACT_THREAD_CACHE_SCHEMA_VERSION,
  decodeStoredThreadSnapshot,
  encodeStoredThreadSnapshot,
} from "./threadCacheEncoding.ts";

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
const projection: OrchestrationV2ThreadProjection = {
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
const snapshot: OrchestrationV2ThreadDetailSnapshot = { snapshotSequence: 3, projection };
const stored = { environmentId: ENVIRONMENT_ID, threadId: v2ThreadId, snapshot };
const encodeFull = Schema.encodeEffect(Schema.fromJsonString(StoredOrchestrationThreadSnapshot));
const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe("thread cache records", () => {
  it.effect("writes each item once", () =>
    Effect.gen(function* () {
      const raw = yield* encodeStoredThreadSnapshot(stored);
      expect(JSON.parse(raw).schemaVersion).toBe(COMPACT_THREAD_CACHE_SCHEMA_VERSION);
      expect(occurrences(raw, COMMAND_OUTPUT)).toBe(1);
    }),
  );

  it.effect("decodes to the same projection, with one object per item", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeStoredThreadSnapshot(yield* encodeStoredThreadSnapshot(stored));
      const { projection: loaded } = decoded.snapshot;
      expect(loaded).toEqual(projection);
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
        ...projection,
        turnItems: [answer, hidden, command],
      };
      const raw = yield* encodeStoredThreadSnapshot({
        ...stored,
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
      const raw = yield* encodeFull({
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        ...stored,
      });
      expect(occurrences(raw, COMMAND_OUTPUT)).toBe(2);
      const { projection: loaded } = (yield* decodeStoredThreadSnapshot(raw)).snapshot;
      expect(loaded).toEqual(projection);
      expect(loaded.visibleTurnItems[1]!.item).toBe(loaded.turnItems[1]);
    }),
  );

  it.effect("keeps both copies of a full record when they differ", () =>
    Effect.gen(function* () {
      const stale = { ...command, output: "an older output" };
      const raw = yield* encodeFull({
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        ...stored,
        snapshot: {
          ...snapshot,
          projection: {
            ...projection,
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
