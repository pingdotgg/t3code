import { assert, it, describe } from "@effect/vitest";
import {
  EventId,
  MessageId,
  PlanId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadHistoryPage,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as EventStore from "./EventStore.ts";
import {
  encodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
} from "./threadHistoryPaging.ts";
import { projectTurnItemForWire } from "./WireProjection.ts";

const layerTest = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: { readonly archivedAt?: DateTime.Utc; readonly deletedAt?: DateTime.Utc } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const threadId = ThreadId.make("thread:find");
const projectId = ProjectId.make("project:find");
const runId = RunId.make("run:find");

function item(
  id: string,
  ordinal: number,
  text: string,
  kind: "user_message" | "assistant_message" | "proposed_plan" = "assistant_message",
  owner = threadId,
): Extract<
  OrchestrationV2TurnItem,
  { type: "user_message" | "assistant_message" | "proposed_plan" }
> {
  const base = {
    id: TurnItemId.make(id),
    threadId: owner,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at(100 - ordinal),
    completedAt: at(100 - ordinal),
    updatedAt: at(1),
  };
  if (kind === "proposed_plan")
    return { ...base, type: kind, planId: PlanId.make(id), markdown: text, streaming: false };
  if (kind === "user_message")
    return {
      ...base,
      type: kind,
      messageId: MessageId.make(id),
      text,
      inputIntent: "turn_start",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    };
  return { ...base, type: kind, messageId: MessageId.make(id), text, streaming: false };
}

function run(
  owner = threadId,
  id = runId,
  ordinal = 1,
  status: OrchestrationV2Run["status"] = "completed",
): Extract<OrchestrationV2DomainEvent, { type: "run.created" }> {
  return {
    id: EventId.make(`run:${owner}:${id}:${status}`),
    threadId: owner,
    occurredAt: at(1),
    type: "run.created",
    payload: {
      id,
      threadId: owner,
      ordinal,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-6" },
      providerThreadId: null,
      userMessageId: MessageId.make("prompt"),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: at(1),
      startedAt: at(1),
      completedAt: at(2),
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

const commit = Effect.fn("ThreadFindTest.commit")(function* (
  events: readonly OrchestrationV2DomainEvent[],
) {
  const store = yield* EventStore.EventStoreV2;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.append({ events });
  yield* Effect.forEach(events, projection.apply, { discard: true });
});
const putItems = (items: readonly OrchestrationV2TurnItem[], version = "initial") =>
  commit(
    items.map((payload) => ({
      id: EventId.make(`${payload.threadId}:${payload.id}:${version}`),
      threadId: payload.threadId,
      occurredAt: at(1),
      type: "turn-item.updated" as const,
      payload,
    })),
  );
const setup = Effect.gen(function* () {
  yield* createProject(projectId);
  yield* commit([thread(threadId, projectId), run()]);
  return yield* ProjectionStore.ProjectionStoreV2;
});




describe("V2 history materialization", () => {
  it.effect(
    "combines history pages through a match's message identity without skipping intervening turns",
    () =>
      Effect.gen(function* () {
        const projection = yield* setup;
        const items = Array.from({ length: 45 }, (_, turn) => [
          item(`user:${turn}`, turn * 3, `turn ${turn}`, "user_message"),
          {
            ...item(`answer:${turn}`, turn * 3 + 1, `answer ${turn}`),
            messageId: MessageId.make(`message:${turn}`),
          },
          {
            ...item(`tool:${turn}`, turn * 3 + 2, ""),
            type: "command_execution" as const,
            input: "pwd",
            output: "huge output".repeat(1000),
            exitCode: 0,
          },
        ]).flat();
        yield* putItems(items);
        const snapshot = yield* projection.getThreadSnapshot(threadId);
        const cursor = encodeThreadHistoryCursor({
          snapshotSequence: snapshot.snapshotSequence,
          sourceThreadId: threadId,
          sourceItemId: "absent",
          position: items.length,
        });
        const ordinary = yield* projection.getThreadHistoryPage(threadId, cursor);
        assert.equal(ordinary.items[0]?.sourceItemId, "user:25");
        const targeted = yield* projection.getThreadHistoryPage(threadId, cursor, "message:10");
        assert.equal(targeted.items[0]?.sourceItemId, "user:10");
        assert.deepEqual(
          targeted.items.map((row) => row.sourceItemId),
          items.slice(30).map((entry) => entry.id),
        );
        const conversation = yield* projection.getThreadHistoryPage(
          threadId,
          cursor,
          "message:10",
          true,
        );
        assert.equal(conversation.nextCursor, targeted.nextCursor);
        assert.equal(conversation.hasMoreHistory, targeted.hasMoreHistory);
        assert.deepEqual(
          conversation.items.map((row) => row.sourceItemId),
          targeted.items
            .filter((row) => row.item.type !== "command_execution")
            .map((row) => row.sourceItemId),
        );
        assert.equal(conversation.items.length, 70);
        assert.equal(targeted.items.length, 105);
        assert.isTrue(targeted.hasMoreHistory);
        const earlier = yield* projection.getThreadHistoryPage(threadId, targeted.nextCursor!);
        assert.deepEqual(
          earlier.items.map((row) => row.sourceItemId),
          items.slice(0, 30).map((entry) => entry.id),
        );
        assert.isFalse(earlier.hasMoreHistory);
        const capped = yield* projection.getThreadHistoryPage(threadId, cursor, "message:0");
        assert.equal(capped.items[0]?.sourceItemId, "user:5");
        const absent = yield* projection.getThreadHistoryPage(
          threadId,
          cursor,
          "another-thread-message",
        );
        assert.deepEqual(absent, ordinary);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("pages long turns without duplicating or skipping messages", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const items = Array.from({ length: 45 }, (_, turn) => [
        item(`user:${turn}`, turn * 3, `turn ${turn}`, "user_message"),
        {
          ...item(`steer:${turn}`, turn * 3 + 1, "steer", "user_message"),
          inputIntent: "steer" as const,
        },
        item(
          `answer:${turn}`,
          turn * 3 + 2,
          turn === 40 ? "large ".repeat(200_000) : `answer ${turn}`,
        ),
      ]).flat();
      yield* putItems(items);
      const snapshot = yield* projection.getThreadSnapshot(threadId);
      const rows = snapshot.projection.visibleTurnItems.map((row) => ({
        ...row,
        item: projectTurnItemForWire(row.item),
      }));
      let cursor: string | null = encodeThreadHistoryCursor({
        snapshotSequence: snapshot.snapshotSequence,
        sourceThreadId: threadId,
        sourceItemId: "absent",
        position: rows.length,
      });
      const collected: string[] = [];
      while (cursor !== null) {
        const page: OrchestrationV2ThreadHistoryPage = yield* projection.getThreadHistoryPage(
          threadId,
          cursor,
        );
        assert.deepEqual(page, {
          snapshotSequence: snapshot.snapshotSequence,
          ...selectHistoryPageFromCursor({
            items: rows,
            cursor,
            snapshotSequence: snapshot.snapshotSequence,
          }),
        });
        // A turn larger than the byte budget is split, but only a lone oversized item may exceed it.
        assert.isTrue(
          page.items.length === 1 ||
            Buffer.byteLength(JSON.stringify(page.items), "utf8") <=
              THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
        );
        collected.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.nextCursor;
      }
      assert.deepEqual(
        collected,
        items.map((entry) => String(entry.id)),
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("enforces fallback item and byte limits and always admits an oversized row", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems(
        Array.from({ length: 80 }, (_, ordinal) =>
          item(`row:${ordinal}`, ordinal, ordinal < 78 ? "small" : "large ".repeat(200_000)),
        ),
      );
      const snapshot = yield* projection.getThreadSnapshot(threadId);
      const rows = snapshot.projection.visibleTurnItems.map((row) => ({
        ...row,
        item: projectTurnItemForWire(row.item),
      }));
      let cursor: string | null = encodeThreadHistoryCursor({
        snapshotSequence: snapshot.snapshotSequence,
        sourceThreadId: threadId,
        sourceItemId: "absent",
        position: rows.length,
      });
      const sizes: number[] = [];
      while (cursor !== null) {
        const page: OrchestrationV2ThreadHistoryPage = yield* projection.getThreadHistoryPage(
          threadId,
          cursor,
        );
        assert.deepEqual(page, {
          snapshotSequence: snapshot.snapshotSequence,
          ...selectHistoryPageFromCursor({
            items: rows,
            cursor,
            snapshotSequence: snapshot.snapshotSequence,
          }),
        });
        sizes.push(page.items.length);
        cursor = page.nextCursor;
      }
      assert.deepEqual(sizes, [1, 1, 75, 3]);
    }).pipe(Effect.provide(layerTest)),
  );
});

