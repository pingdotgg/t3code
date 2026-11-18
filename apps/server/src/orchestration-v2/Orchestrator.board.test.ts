import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for the group board"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "board" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const projectId = ProjectId.make("project:board");

const harness = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  let commandCount = 0;
  const nextCommandId = (label: string) => CommandId.make(`board-${label}-${++commandCount}`);
  const threadId = (name: string) => ThreadId.make(`thread:board-${name}`);
  const create = (name: string) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: nextCommandId(`create-${name}`),
      threadId: threadId(name),
      projectId,
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  const attach = (name: string, parent: string) =>
    orchestrator.dispatch({
      type: "thread.group.attach",
      commandId: nextCommandId(`attach-${name}`),
      threadId: threadId(name),
      parentThreadId: threadId(parent),
    });
  const detach = (name: string) =>
    orchestrator.dispatch({
      type: "thread.group.detach",
      commandId: nextCommandId(`detach-${name}`),
      threadId: threadId(name),
    });
  const write = (name: string, title: string, text: string) =>
    orchestrator.dispatch({
      type: "thread.board.write",
      commandId: nextCommandId(`write-${name}`),
      threadId: threadId(name),
      title,
      text,
    });
  const remove = (name: string, topicId: string) =>
    orchestrator.dispatch({
      type: "thread.board.remove",
      commandId: nextCommandId(`remove-${name}`),
      threadId: threadId(name),
      topicId,
    });
  const claim = (name: string, topicId: string) =>
    orchestrator.dispatch({
      type: "thread.board.claim",
      commandId: nextCommandId(`claim-${name}`),
      threadId: threadId(name),
      topicId,
    });
  const visit = (name: string, viewedAt: string) =>
    orchestrator.dispatch({
      type: "thread.board.visit",
      commandId: nextCommandId(`visit-${name}`),
      threadId: threadId(name),
      viewedAt,
    });
  const board = (name: string) => orchestrator.getThreadBoard({ threadId: threadId(name) });
  const topics = (lead: string) => projections.listBoardTopics(threadId(lead));
  const shell = (name: string) =>
    projections
      .getThreadShell(threadId(name))
      .pipe(Effect.flatMap((found) => Effect.fromNullishOr(found)));
  const refusal = <A, E extends { readonly cause?: unknown }, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flip(effect).pipe(Effect.map((error) => error.cause));
  // A lead with two workers.
  const group = Effect.gen(function* () {
    yield* create("lead");
    yield* create("w");
    yield* create("x");
    yield* attach("w", "lead");
    yield* attach("x", "lead");
  });
  return {
    orchestrator,
    projections,
    eventSink,
    threadId,
    create,
    attach,
    detach,
    write,
    remove,
    claim,
    visit,
    board,
    topics,
    shell,
    refusal,
    group,
  };
});

it.effect("writing creates a topic and the author's next write with that title updates it", () =>
  Effect.gen(function* () {
    const { threadId, write, topics, group } = yield* harness;
    yield* group;
    yield* write("w", "API shape", "Use offsets.");
    yield* TestClock.adjust("1 minute");
    yield* write("w", " api SHAPE ", "Use cursor pagination.");
    const [topic, ...rest] = yield* topics("lead");
    assert.deepEqual(rest, []);
    assert.equal(topic?.leadThreadId, threadId("lead"));
    assert.equal(topic?.authorThreadId, threadId("w"));
    assert.equal(topic?.lastEditorThreadId, threadId("w"));
    assert.equal(topic?.text, "Use cursor pagination.");
    assert.equal(topic?.editCount, 2);
    assert.equal(topic?.createdAt, "1970-01-01T00:00:00.000Z");
    assert.equal(topic?.updatedAt, "1970-01-01T00:01:00.000Z");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("only a thread in a group writes, and another member cannot take a title", () =>
  Effect.gen(function* () {
    const { create, write, topics, refusal, group } = yield* harness;
    yield* create("alone");
    assert.equal(
      yield* refusal(write("alone", "Notes", "Nobody reads this.")),
      "Only a thread in a group can write to its board.",
    );
    yield* group;
    yield* write("w", "API shape", "Use cursor pagination.");
    for (const member of ["x", "lead"]) {
      assert.equal(
        yield* refusal(write(member, "api shape", "Use offsets.")),
        'Topic "API shape" belongs to w; send it a message instead.',
      );
    }
    assert.deepEqual(
      (yield* topics("lead")).map((topic) => [topic.title, topic.text, topic.editCount]),
      [["API shape", "Use cursor pagination.", 1]],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a detached worker's topic is frozen until the lead claims it", () =>
  Effect.gen(function* () {
    const { threadId, detach, write, claim, board, topics, refusal, group } = yield* harness;
    yield* group;
    yield* write("w", "API shape", "Use cursor pagination.");
    const [topic] = yield* topics("lead");
    assert.isDefined(topic);
    if (topic === undefined) return;
    assert.equal(
      yield* refusal(claim("lead", topic.id)),
      "Only the group lead can claim a topic whose author left the group.",
    );

    yield* detach("w");
    assert.equal(
      yield* refusal(write("w", "API shape", "Use offsets.")),
      "Only a thread in a group can write to its board.",
    );
    assert.deepEqual(
      (yield* board("x")).topics.map((entry) => [entry.id, entry.authorInGroup]),
      [[topic.id, false]],
    );
    assert.equal(
      yield* refusal(claim("x", topic.id)),
      "Only the group lead can claim a topic whose author left the group.",
    );
    assert.equal(
      yield* refusal(write("lead", "API shape", "Use offsets.")),
      'Topic "API shape" is frozen because its author left the group; claim it first.',
    );

    yield* claim("lead", topic.id);
    const [justClaimed] = yield* topics("lead");
    assert.equal(justClaimed?.lastEditorThreadId, threadId("lead"));
    assert.equal(justClaimed?.editCount, 1);
    yield* write("lead", "API shape", "Use offsets.");
    const [claimed] = (yield* board("lead")).topics;
    assert.equal(claimed?.authorThreadId, threadId("lead"));
    assert.equal(claimed?.lastEditorThreadId, threadId("lead"));
    assert.equal(claimed?.editCount, 2);
    assert.equal(claimed?.text, "Use offsets.");
    assert.isTrue(claimed?.authorInGroup);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the author removes its topic, and the lead removes a frozen one", () =>
  Effect.gen(function* () {
    const { detach, write, remove, topics, refusal, group } = yield* harness;
    yield* group;
    yield* write("w", "API shape", "Use cursor pagination.");
    yield* write("x", "Schema", "Add a column.");
    const [apiShape, schema] = yield* topics("lead");
    assert.isDefined(apiShape);
    assert.isDefined(schema);
    if (apiShape === undefined || schema === undefined) return;

    for (const member of ["x", "lead"]) {
      assert.equal(
        yield* refusal(remove(member, apiShape.id)),
        "Only the topic's author can remove it.",
      );
    }
    yield* remove("w", apiShape.id);
    assert.deepEqual(
      (yield* topics("lead")).map((topic) => topic.id),
      [schema.id],
    );

    yield* detach("x");
    assert.equal(yield* refusal(remove("w", schema.id)), "Only the topic's author can remove it.");
    yield* remove("lead", schema.id);
    assert.deepEqual(yield* topics("lead"), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("board visits only move the lead's watermark forward", () =>
  Effect.gen(function* () {
    const { eventSink, threadId, visit, board, group } = yield* harness;
    yield* group;
    const first = yield* visit("lead", "2026-11-18T10:05:00.000Z");
    assert.deepEqual(
      first.storedEvents.map((stored) => [stored.event.type, stored.event.threadId]),
      [["thread.board-visit-recorded", threadId("lead")]],
    );
    const older = yield* visit("lead", "2026-11-18T10:00:00.000Z");
    assert.deepEqual(older.storedEvents, []);
    assert.equal((yield* board("w")).viewedAt, "2026-11-18T10:05:00.000Z");
    // A worker reads the same board, so its visit moves the lead's watermark.
    yield* visit("w", "2026-11-18T10:10:00.000Z");
    assert.equal((yield* board("lead")).viewedAt, "2026-11-18T10:10:00.000Z");
    // Two members' visits can commit out of order; the older one never wins.
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:board-late-visit"),
          type: "thread.board-visit-recorded",
          threadId: threadId("lead"),
          occurredAt: DateTime.makeUnsafe("2026-11-18T10:11:00.000Z"),
          payload: { boardViewedAt: "2026-11-18T10:07:00.000Z" },
        },
      ],
    });
    assert.equal((yield* board("lead")).viewedAt, "2026-11-18T10:10:00.000Z");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the lead's shell carries the board counters without board events moving updatedAt", () =>
  Effect.gen(function* () {
    const { projections, eventSink, threadId, write, remove, visit, topics, shell, group } =
      yield* harness;
    yield* group;
    const updatedAt = (yield* shell("lead")).updatedAt;
    const leadBeforeWrites = yield* projections.getThread(threadId("lead"));

    yield* TestClock.adjust("1 minute");
    yield* write("w", "API shape", "Use cursor pagination.");
    yield* TestClock.adjust("1 minute");
    yield* write("x", "Schema", "Add a column.");
    yield* TestClock.adjust("1 minute");
    yield* write("x", "Rollout", "Behind a flag.");
    const [, , rollout] = yield* topics("lead");
    assert.isDefined(rollout);
    if (rollout === undefined) return;
    yield* TestClock.adjust("1 minute");
    yield* remove("x", rollout.id);
    yield* visit("lead", "2026-11-18T10:05:00.000Z");

    const lead = yield* shell("lead");
    assert.deepEqual(lead.updatedAt, updatedAt);
    assert.equal(lead.boardTopicCount, 2);
    assert.equal(lead.boardUpdatedAt, "1970-01-01T00:04:00.000Z");
    assert.equal(lead.boardViewedAt, "2026-11-18T10:05:00.000Z");
    const worker = yield* shell("w");
    assert.isUndefined(worker.boardTopicCount);
    assert.isUndefined(worker.boardUpdatedAt);
    assert.isUndefined(worker.boardViewedAt);

    // A lead event built from a read taken before the board writes keeps the counters.
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:board-stale-lead"),
          type: "thread.metadata-updated",
          threadId: leadBeforeWrites.id,
          occurredAt: leadBeforeWrites.updatedAt,
          payload: { ...leadBeforeWrites, title: "renamed lead" },
        },
      ],
    });
    const renamed = yield* shell("lead");
    assert.equal(renamed.title, "renamed lead");
    assert.equal(renamed.boardTopicCount, 2);
    assert.equal(renamed.boardUpdatedAt, "1970-01-01T00:04:00.000Z");
    assert.equal(renamed.boardViewedAt, "2026-11-18T10:05:00.000Z");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("deleting the lead removes its board", () =>
  Effect.gen(function* () {
    const { orchestrator, threadId, write, board, topics, group } = yield* harness;
    yield* group;
    yield* write("w", "API shape", "Use cursor pagination.");
    yield* write("lead", "Plan", "Ship the board.");
    assert.equal((yield* topics("lead")).length, 2);
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("board-delete-lead"),
      threadId: threadId("lead"),
    });
    assert.deepEqual(yield* topics("lead"), []);
    const empty = { leadThreadId: null, viewedAt: null, topics: [] };
    assert.deepEqual(yield* board("w"), empty);
    assert.deepEqual(yield* board("lead"), empty);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a lead that joins another group brings its board along", () =>
  Effect.gen(function* () {
    const { threadId, create, attach, write, board, topics, shell, group } = yield* harness;
    yield* group;
    yield* create("other");
    yield* create("y");
    yield* attach("y", "other");
    yield* write("w", "API shape", "Use cursor pagination.");
    yield* write("lead", "Plan", "Ship the board.");
    yield* write("y", "plan", "Ship the strip.");
    yield* write("y", "plan (LEAD)", "Taken too.");

    yield* attach("lead", "other");
    assert.deepEqual(yield* topics("lead"), []);
    assert.equal((yield* shell("lead")).boardTopicCount, 0);
    assert.deepEqual(
      (yield* board("w")).topics
        .map((topic) => `${topic.title} by ${topic.authorThreadId}`)
        .toSorted(),
      [
        `API shape by ${threadId("w")}`,
        `Plan (lead 2) by ${threadId("lead")}`,
        `plan (LEAD) by ${threadId("y")}`,
        `plan by ${threadId("y")}`,
      ],
    );
    assert.equal((yield* shell("other")).boardTopicCount, 4);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a board holds at most 50 topics", () =>
  Effect.gen(function* () {
    const { write, topics, refusal, group } = yield* harness;
    yield* group;
    for (let index = 0; index < 50; index += 1) {
      yield* write("w", `Topic ${index}`, "State.");
    }
    assert.equal(
      yield* refusal(write("x", "One more", "State.")),
      "The board already has 50 topics; update or remove one first.",
    );
    yield* write("w", "Topic 0", "Updated state.");
    assert.equal((yield* topics("lead")).length, 50);
  }).pipe(Effect.provide(layerTest)),
);
