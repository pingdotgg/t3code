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
  type OrchestrationV2SearchThreadResult,
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
import { vi } from "vite-plus/test";
import * as ThreadFindText from "@t3tools/shared/threadFindText";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as EventStore from "./EventStore.ts";
import { encodeThreadHistoryCursor, selectHistoryPageFromCursor } from "./threadHistoryPaging.ts";
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
    // Creation time deliberately opposes the canonical item order.
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

describe("V2 thread find", () => {
  it.effect("delivers the reading-position match before parsing the remaining history", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([
        item("before", 0, "before progressive needle needle"),
        item("reading", 1, "reading progressive needle needle"),
        item("after", 2, "after progressive needle"),
      ]);
      const parse = vi.spyOn(ThreadFindText, "searchableMessageSegments");
      const frames: OrchestrationV2SearchThreadResult[] = [];
      try {
        yield* projection
          .searchThreadStream({
            threadId,
            query: "needle",
            start: { entryId: "reading", occurrence: 1 },
          })
          .pipe(
            Stream.runForEach((frame) =>
              Effect.sync(() => {
                frames.push(frame);
                if (frame.complete === false) {
                  assert.deepEqual(frame.match, { entryId: "reading", runId, occurrence: 1 });
                  assert.equal(parse.mock.calls.length, 1);
                  assert.equal(parse.mock.calls[0]![0].text, "reading progressive needle needle");
                }
              }),
            ),
          );
        assert.equal(frames.length, 2);
        assert.notEqual(frames[1]!.complete, false);
        assert.deepEqual(frames[1]!.match, frames[0]!.match);
        assert.equal(frames[1]!.totalMatches, 5);
        assert.equal(frames[1]!.activeIndex, 3);
        const cached = yield* projection
          .searchThreadStream({ threadId, query: "needle" })
          .pipe(Stream.runCollect);
        assert.equal(cached.length, 1);
        assert.notEqual(cached[0]!.complete, false);
      } finally {
        parse.mockRestore();
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("wraps from an exhausted bottom anchor and cancels without counting the rest", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([
        item("first", 0, "cancel progressive needle"),
        item("later", 1, "cancel later needle needle"),
        item("bottom", 2, "cancel bottom needle"),
      ]);
      const parse = vi.spyOn(ThreadFindText, "searchableMessageSegments");
      try {
        const frames = yield* projection
          .searchThreadStream({
            threadId,
            query: "needle",
            start: { entryId: "bottom", occurrence: 1 },
          })
          .pipe(Stream.take(1), Stream.runCollect);
        assert.equal(frames[0]!.complete, false);
        assert.equal(frames[0]!.match?.entryId, "first");
        assert.deepEqual(
          parse.mock.calls.map(([message]) => message.text),
          ["cancel bottom needle", "cancel progressive needle"],
        );
        const complete = yield* projection.searchThread({ threadId, query: "needle" });
        assert.equal(complete.totalMatches, 4);
        assert.equal(parse.mock.calls.length, 3);
      } finally {
        parse.mockRestore();
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("finishes one snapshot while later searches include newly inserted matches", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([
        item("selected", 1, "snapshot needle"),
        item("last", 2, "snapshot last needle"),
      ]);
      const frames = yield* projection.searchThreadStream({ threadId, query: "needle" }).pipe(
        Stream.tap((frame) =>
          frame.complete === false
            ? putItems([item("inserted", 0, "snapshot inserted needle")], "during-search")
            : Effect.void,
        ),
        Stream.runCollect,
      );
      assert.equal(frames.length, 2);
      assert.equal(frames[1]!.totalMatches, 2);
      assert.deepEqual(frames[1]!.match, frames[0]!.match);
      const updated = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "selected", occurrence: 0 },
      });
      assert.equal(updated.totalMatches, 3);
      assert.equal(updated.activeIndex, 1);
      assert.equal(updated.match?.entryId, "selected");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("returns only a final frame for empty searches and relative navigation", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([item("only", 0, "needle needle")]);
      const empty = yield* projection
        .searchThreadStream({ threadId, query: "missing" })
        .pipe(Stream.runCollect);
      assert.equal(empty.length, 1);
      assert.equal(empty[0]!.totalMatches, 0);
      assert.notEqual(empty[0]!.complete, false);
      const relative = yield* projection
        .searchThreadStream({ threadId, query: "needle", offset: 1 })
        .pipe(Stream.runCollect);
      assert.equal(relative.length, 1);
      assert.equal(relative[0]!.match?.occurrence, 1);
      assert.notEqual(relative[0]!.complete, false);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("returns bounded navigation counts around the selection, including wraparound", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems(
        Array.from({ length: 30 }, (_, i) =>
          item(`message:${i}`, i, "needle ".repeat((i % 3) + 1)),
        ),
      );
      const current = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "message:14", occurrence: 1 },
      });
      assert.equal(current.totalMatches, 60);
      assert.equal(current.activeIndex, 28);
      assert.equal(current.navigation?.length, 17);
      assert.deepEqual(
        current.navigation?.map((entry) => entry.entryId),
        Array.from({ length: 17 }, (_, i) => `message:${i + 6}`),
      );
      assert.deepEqual(
        current.navigation?.find((entry) => entry.entryId === "message:14"),
        {
          entryId: "message:14",
          runId,
          startIndex: 27,
          count: 3,
        },
      );
      const first = yield* projection.searchThread({ threadId, query: "needle" });
      assert.equal(first.navigation?.length, 17);
      assert.include(first.navigation?.map((entry) => entry.entryId) ?? [], "message:29");
      const empty = yield* projection.searchThread({ threadId, query: "absent" });
      assert.deepEqual(empty.navigation, []);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps navigation compact for a message with thousands of occurrences", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([item("many", 1, "needle ".repeat(5000))]);
      const result = yield* projection.searchThread({ threadId, query: "needle", index: 2000 });
      assert.equal(result.totalMatches, 5000);
      assert.equal(result.match?.occurrence, 2000);
      assert.deepEqual(result.navigation, [{ entryId: "many", runId, startIndex: 0, count: 5000 }]);
      assert.isBelow(JSON.stringify(result).length, 500);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("cycles relative to the current match when new matches are inserted", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([
        item("first", 10, "needle"),
        item("current", 20, "needle"),
        item("last", 30, "needle"),
      ]);
      const initial = yield* projection.searchThread({ threadId, query: "needle", index: 1 });
      assert.equal(initial.match?.entryId, "current");
      yield* putItems([
        item("new-before", 15, "needle"),
        item("new-after", 25, "needle"),
        item("new-last", 40, "needle"),
      ]);
      const start = { entryId: "current", occurrence: 0 };
      const refreshed = yield* projection.searchThread({ threadId, query: "needle", start });
      assert.equal(refreshed.totalMatches, 6);
      assert.equal(refreshed.activeIndex, 2);
      assert.equal(refreshed.match?.entryId, "current");
      const next = yield* projection.searchThread({ threadId, query: "needle", start, offset: 1 });
      assert.equal(next.match?.entryId, "new-after");
      const previous = yield* projection.searchThread({
        threadId,
        query: "needle",
        start,
        offset: -1,
      });
      assert.equal(previous.match?.entryId, "new-before");
      const end = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "last", occurrence: 0 },
        offset: 1,
      });
      assert.equal(end.match?.entryId, "new-last");
      const wrapped = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "new-last", occurrence: 0 },
        offset: 1,
      });
      assert.equal(wrapped.match?.entryId, "first");
      const backwards = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "first", occurrence: 0 },
        offset: -1,
      });
      assert.equal(backwards.match?.entryId, "new-last");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reuses parses of large messages across navigation, edits, and new queries", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const text = `${"large message ".repeat(2600)}needle`;
      yield* putItems(Array.from({ length: 8 }, (_, i) => item(`large:${i}`, i + 1, text)));
      const parse = vi.spyOn(ThreadFindText, "searchableMessageSegments");
      try {
        const first = yield* projection.searchThread({ threadId, query: "needle" });
        assert.equal(first.totalMatches, 8);
        // Identical bodies share one parse.
        assert.equal(parse.mock.calls.length, 1);
        parse.mockClear();
        const next = yield* projection.searchThread({ threadId, query: "needle", index: 4 });
        assert.equal(next.match?.entryId, "large:4");
        assert.equal(next.snapshotSequence, first.snapshotSequence);
        assert.equal(parse.mock.calls.length, 0);
        yield* putItems([item("large:4", 5, `${text} needle`)], "changed");
        const changed = yield* projection.searchThread({ threadId, query: "needle", index: 5 });
        assert.equal(changed.totalMatches, 9);
        assert.deepEqual(changed.match, { entryId: "large:4", runId, occurrence: 1 });
        // Only the edited message is parsed again.
        assert.equal(parse.mock.calls.length, 1);
        parse.mockClear();
        const retyped = yield* projection.searchThread({ threadId, query: "large message" });
        assert.equal(retyped.totalMatches, 8 * 2600);
        assert.equal(parse.mock.calls.length, 0);
      } finally {
        parse.mockRestore();
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("searches visible rendered messages and plans in canonical item order", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([
        item("user", 1, "Check **the build**", "user_message"),
        item("assistant", 2, "check the build twice: check the build"),
        item("plan-item", 3, "# Check the build\nShip it", "proposed_plan"),
        item("url", 4, "[documentation](https://hidden.example/needle)"),
      ]);
      const matches = [];
      for (let index = 0; index < 4; index++) {
        const result = yield* projection.searchThread({
          threadId,
          query: "CHECK THE BUILD",
          index,
        });
        assert.equal(result.totalMatches, 4);
        matches.push(result.match);
      }
      assert.deepEqual(matches, [
        { entryId: "user", runId, occurrence: 0 },
        { entryId: "assistant", runId, occurrence: 0 },
        { entryId: "assistant", runId, occurrence: 1 },
        { entryId: "plan-item", runId, occurrence: 0 },
      ]);
      assert.equal(
        (yield* projection.searchThread({ threadId, query: "hidden.example" })).totalMatches,
        0,
      );
      assert.equal(
        (yield* projection.searchThread({ threadId, query: "check", index: 99 })).activeIndex,
        3,
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps a search snapshot consistent while another thread commits", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const other = ThreadId.make("thread:busy");
      yield* commit([thread(other, projectId), run(other, RunId.make("run:busy"))]);
      yield* putItems(Array.from({ length: 260 }, (_, i) => item(`message:${i}`, i, "needle")));
      const before = yield* projection.searchThread({ threadId, query: "needle" });
      const [during] = yield* Effect.all(
        [
          projection.searchThread({ threadId, query: "needle", index: 259 }),
          putItems([item("busy", 1, "busy", "assistant_message", other)]),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(during.totalMatches, 260);
      assert.equal(during.match?.entryId, "message:259");
      assert.equal(during.snapshotSequence, before.snapshotSequence);
      assert.equal(
        (yield* projection.searchThread({ threadId, query: "needle" })).snapshotSequence,
        before.snapshotSequence,
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("searches displayed skill labels and invalidates parsed text when labels change", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([item("skill", 1, "Use $test-t3-app now")]);
      const input = {
        threadId,
        query: "T3 App Testing",
        skills: [{ name: "test-t3-app", displayName: "T3 App Testing" }],
      };
      assert.equal((yield* projection.searchThread(input)).totalMatches, 1);
      assert.equal((yield* projection.searchThread({ ...input, skills: [] })).totalMatches, 0);
      // Plans render `$skill` tokens literally, so they match as written, not by label.
      yield* putItems(
        [item("skill-plan", 2, "# Verify\nUse $test-t3-app now", "proposed_plan")],
        "plan",
      );
      assert.equal((yield* projection.searchThread(input)).totalMatches, 1);
      assert.equal(
        (yield* projection.searchThread({ ...input, query: "$test-t3-app" })).totalMatches,
        1,
      );
      // The message label "T3 App Testing" plus the plan's literal "$test-t3-app".
      assert.equal((yield* projection.searchThread({ ...input, query: "App" })).totalMatches, 2);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("never mixes message versions when the searched thread changes during a scan", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const items = Array.from({ length: 260 }, (_, i) => item(`message:${i}`, i, "needle"));
      yield* putItems(items);
      const updated = items.map((item) =>
        item.type === "assistant_message" ? { ...item, text: "needle needle" } : item,
      );
      const [during] = yield* Effect.all(
        [
          projection.searchThread({ threadId, query: "needle" }),
          sql.withTransaction(putItems(updated, "concurrent")),
        ],
        { concurrency: "unbounded" },
      );
      assert.include([260, 520], during.totalMatches);
      assert.equal(
        (yield* projection.searchThread({ threadId, query: "needle" })).totalMatches,
        520,
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("starts at the reading position and wraps when no later match exists", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      yield* putItems([
        item("first", 1, "needle"),
        item("reading", 2, "needle above, needle below"),
        item("between", 3, "nothing"),
        item("last", 4, "needle"),
        item("end", 5, "nothing"),
      ]);
      const from = (entryId: string, occurrence = 0) =>
        projection.searchThread({ threadId, query: "needle", start: { entryId, occurrence } });
      assert.equal((yield* from("reading")).activeIndex, 1);
      const below = yield* from("reading", 1);
      assert.equal(below.activeIndex, 2);
      assert.equal(below.match?.occurrence, 1);
      assert.equal((yield* from("between")).match?.entryId, "last");
      assert.equal((yield* from("reading", 2)).activeIndex, 3);
      assert.equal((yield* from("end")).match?.entryId, "first");
      assert.equal((yield* from("missing")).activeIndex, 0);
      const explicit = yield* projection.searchThread({
        threadId,
        query: "needle",
        start: { entryId: "last", occurrence: 0 },
        index: 1,
      });
      assert.equal(explicit.match?.entryId, "reading");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("finds matches beyond the recent history window", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const items = Array.from({ length: 520 }, (_, i) =>
        item(`message:${i}`, i + 1, i === 8 || i === 510 ? "sentinel" : "other message"),
      );
      yield* putItems(items);
      const first = yield* projection.searchThread({ threadId, query: "sentinel" });
      const last = yield* projection.searchThread({ threadId, query: "sentinel", index: 1 });
      assert.equal(first.totalMatches, 2);
      assert.equal(first.match?.entryId, "message:8");
      assert.equal(last.match?.entryId, "message:510");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("invalidates cached counts when streamed text changes or a run rolls back", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const original = item("streaming", 1, "needle");
      yield* putItems([original]);
      assert.equal((yield* projection.searchThread({ threadId, query: "needle" })).totalMatches, 1);
      if (original.type !== "assistant_message") return;
      yield* putItems([{ ...original, text: "needle needle", streaming: true }], "streaming");
      assert.equal((yield* projection.searchThread({ threadId, query: "needle" })).totalMatches, 2);
      const updated = run(threadId, runId, 1, "rolled_back");
      yield* commit([{ ...updated, type: "run.updated" }]);
      assert.equal((yield* projection.searchThread({ threadId, query: "needle" })).totalMatches, 0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "does not search undispatched inputs, cancelled queue rows, or folded question answers",
    () =>
      Effect.gen(function* () {
        const projection = yield* setup;
        const queuedRunId = RunId.make("queued:cancelled");
        yield* commit([run(threadId, queuedRunId, 2, "cancelled")]);
        const queued = item("cancelled", 1, "needle", "user_message");
        if (queued.type !== "user_message") return;
        const answer = item("async-answer:question", 2, "needle", "user_message");
        const question: OrchestrationV2TurnItem = {
          ...item("question", 3, ""),
          type: "user_input_request",
          requestId: RuntimeRequestId.make("question"),
          questions: [],
          questionAnswer: { requestId: "question", answers: {}, attachmentsByQuestionId: {} },
        };
        yield* putItems([
          { ...queued, runId: queuedRunId, inputIntent: "queued_turn" },
          answer,
          question,
        ]);
        const event: OrchestrationV2DomainEvent = {
          id: EventId.make("undispatched"),
          threadId,
          occurredAt: at(2),
          type: "message.updated",
          payload: {
            id: MessageId.make("undispatched"),
            threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: "needle",
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: at(2),
            updatedAt: at(2),
          },
        };
        yield* commit([event]);
        const result = yield* projection.searchThread({ threadId, query: "needle" });
        assert.equal(result.totalMatches, 0);
        assert.isNull(result.match);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "searches inherited fork history through the fork boundary, using source item identities",
    () =>
      Effect.gen(function* () {
        const projection = yield* setup;
        const parent = ThreadId.make("thread:parent");
        const laterRun = RunId.make("run:later");
        const parentRun = RunId.make("run:parent");
        yield* commit([
          thread(parent, projectId),
          run(parent, parentRun),
          run(parent, laterRun, 2),
        ]);
        yield* putItems([
          { ...item("inherited", 1, "needle", "assistant_message", parent), runId: parentRun },
          { ...item("after-fork", 2, "needle", "assistant_message", parent), runId: laterRun },
        ]);
        const child = thread(threadId, projectId);
        if (child.type !== "thread.created") return;
        yield* commit([
          {
            ...child,
            id: EventId.make("child:fork"),
            type: "thread.metadata-updated",
            payload: {
              ...child.payload,
              forkedFrom: { type: "run", threadId: parent, runId: parentRun },
            },
          },
        ]);
        yield* putItems([item("local", 1, "needle")]);
        const inherited = yield* projection.searchThread({ threadId, query: "needle" });
        assert.equal(inherited.totalMatches, 2);
        assert.equal(inherited.match?.entryId, "inherited");
        assert.equal(
          (yield* projection.searchThread({ threadId, query: "needle", index: 1 })).match?.entryId,
          "local",
        );
        const snapshot = yield* projection.getThreadSnapshot(threadId);
        const history = yield* projection.getThreadHistoryPage(
          threadId,
          encodeThreadHistoryCursor({
            snapshotSequence: snapshot.snapshotSequence,
            sourceThreadId: threadId,
            sourceItemId: "local",
            position: 2,
          }),
        );
        assert.deepEqual(
          history.items,
          snapshot.projection.visibleTurnItems
            .slice(0, -1)
            .map((row) => ({ ...row, item: projectTurnItemForWire(row.item) })),
        );
        assert.equal(history.items[0]?.sourceThreadId, parent);
        assert.equal(history.items.at(-1)?.item.type, "fork");
        // Parent updates invalidate a child's cached inherited result too.
        yield* putItems(
          [{ ...item("inherited", 1, "gone", "assistant_message", parent), runId: parentRun }],
          "parent-update",
        );
        assert.equal(
          (yield* projection.searchThread({ threadId, query: "needle" })).totalMatches,
          1,
        );
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects deleted threads and keeps results scoped to their thread", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const other = ThreadId.make("thread:other");
      yield* commit([thread(other, projectId), run(other, RunId.make("run:other"))]);
      yield* putItems([
        item("shared-id", 1, "needle"),
        item("other-id", 1, "other text", "assistant_message", other),
      ]);
      assert.equal((yield* projection.searchThread({ threadId, query: "needle" })).totalMatches, 1);
      assert.equal(
        (yield* projection.searchThread({ threadId: other, query: "needle" })).totalMatches,
        0,
      );
      const deleted = thread(threadId, projectId, { deletedAt: at(3) });
      if (deleted.type !== "thread.created") return;
      yield* commit([{ ...deleted, id: EventId.make("deleted"), type: "thread.deleted" }]);
      const error = yield* Effect.flip(projection.searchThread({ threadId, query: "needle" }));
      assert.equal(error._tag, "ProjectionStoreThreadNotFoundError");
      const historyError = yield* Effect.flip(
        projection.getThreadHistoryPage(
          threadId,
          encodeThreadHistoryCursor({
            snapshotSequence: 0,
            sourceThreadId: threadId,
            sourceItemId: "shared-id",
            position: 0,
          }),
        ),
      );
      assert.equal(historyError._tag, "ProjectionStoreThreadNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("invalidates a cached fork search when its empty source gains its first message", () =>
    Effect.gen(function* () {
      const projection = yield* setup;
      const parent = ThreadId.make("thread:empty-parent");
      const parentRun = RunId.make("run:empty-parent");
      yield* commit([thread(parent, projectId), run(parent, parentRun)]);
      const child = thread(threadId, projectId);
      if (child.type !== "thread.created") return;
      yield* commit([
        {
          ...child,
          id: EventId.make("child:empty-fork"),
          type: "thread.metadata-updated",
          payload: {
            ...child.payload,
            forkedFrom: { type: "run", threadId: parent, runId: parentRun },
          },
        },
      ]);
      yield* putItems([item("local", 1, "needle")]);
      assert.equal((yield* projection.searchThread({ threadId, query: "needle" })).totalMatches, 1);
      yield* putItems([
        { ...item("inherited", 1, "needle", "assistant_message", parent), runId: parentRun },
      ]);
      const updated = yield* projection.searchThread({ threadId, query: "needle" });
      assert.equal(updated.totalMatches, 2);
      assert.equal(updated.match?.entryId, "inherited");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("memory store resolves worktree file labels and rejects deleted threads", () =>
    Effect.gen(function* () {
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const created = thread(threadId, projectId);
      if (created.type !== "thread.created") return;
      const withWorktree = {
        ...created,
        payload: { ...created.payload, worktreePath: "/work/tree" },
      };
      const message = item("file", 1, "See `docs/notes.md:12`.");
      yield* Effect.forEach(
        [
          withWorktree,
          run(),
          {
            id: EventId.make("file"),
            threadId,
            occurredAt: at(1),
            type: "turn-item.updated",
            payload: message,
          },
        ] satisfies OrchestrationV2DomainEvent[],
        projection.apply,
        { discard: true },
      );
      assert.equal(
        (yield* projection.searchThread({ threadId, query: "notes.md · L12" })).totalMatches,
        1,
      );
      const deleted = thread(threadId, projectId, { deletedAt: at(3) });
      if (deleted.type !== "thread.created") return;
      yield* projection.apply({ ...deleted, id: EventId.make("deleted"), type: "thread.deleted" });
      const error = yield* Effect.flip(projection.searchThread({ threadId, query: "notes" }));
      assert.equal(error._tag, "ProjectionStoreThreadNotFoundError");
    }).pipe(Effect.provide(ProjectionStore.layerMemory)),
  );
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

  it.effect("pages complete turns without duplicating or skipping messages", () =>
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
        assert.equal(page.items[0]?.item.type, "user_message");
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
