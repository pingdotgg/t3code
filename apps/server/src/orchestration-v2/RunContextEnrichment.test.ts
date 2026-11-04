import { describe, expect, it } from "@effect/vitest";
import {
  isPluginContextTurnItem,
  MessageId,
  NodeId,
  OrchestrationV2Actor,
  type OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
  PLUGIN_ENRICH_LIMITS,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import type * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { notificationTurnItem } from "@t3tools/provider-core/server/notification";
import {
  enrichesRunTurn,
  prepareRunContext,
  type RunContextEnricherV2Shape,
  type RunContextOutcome,
  type RunContextSource,
  withPluginContext,
} from "./RunContextEnrichment.ts";
import { isThreadHistoryUserTurn } from "./threadHistoryPaging.ts";

const threadId = ThreadId.make("thread-run-context");
const runId = RunId.make("run-run-context");
const attemptId = RunAttemptId.make("attempt-run-context");

const source = (index: number): RunContextSource => ({
  installationId: `installation-${index}`,
  generation: 1,
  pluginId: `test.p${index}`,
  name: `Plugin ${index}`,
  timeoutSeconds: 5,
});

const added = (text: string): RunContextOutcome => ({
  _tag: "added",
  context: [{ title: "Notes", text }],
});

/**
 * An in-memory run and its timeline. `writeIfRunCurrent` commits only while
 * the run is still this attempt's `starting` run, like the real sink.
 */
const makeStore = () => {
  const items = new Map<string, OrchestrationV2TurnItem>();
  const run = { status: "starting" as string };
  const writes: Array<ReadonlyArray<OrchestrationV2TurnItem>> = [];
  const eventSink = {
    writeIfRunCurrent: (input: Parameters<EventSink.EventSinkV2Shape["writeIfRunCurrent"]>[0]) =>
      Effect.sync(() => {
        const committed =
          run.status === input.expectedStatus && input.activeAttemptId === attemptId;
        if (committed) {
          const payloads = input.events.flatMap((event) =>
            event.type === "turn-item.updated" ? [event.payload] : [],
          );
          for (const item of payloads) items.set(item.id, item);
          writes.push(payloads);
        }
        return { committed, storedEvents: [] };
      }),
  } as unknown as EventSink.EventSinkV2Shape;
  return { items, run, writes, eventSink };
};

const enricherOf = (
  sources: ReadonlyArray<RunContextSource>,
  enrich: RunContextEnricherV2Shape["enrich"],
) => {
  const calls: Array<string> = [];
  const enricher: RunContextEnricherV2Shape = {
    sources: Effect.succeed(sources),
    enrich: (called, input) =>
      Effect.suspend(() => {
        calls.push(called.pluginId);
        return enrich(called, input);
      }),
  };
  return { enricher, calls };
};

const prepare = Effect.fn("prepare")(function* (
  store: ReturnType<typeof makeStore>,
  enricher: RunContextEnricherV2Shape,
  withThreadLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = (effect) =>
    effect,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  return yield* prepareRunContext({
    enricher,
    withThreadLock,
    eventSink: store.eventSink,
    idAllocator,
    threadId,
    projectId: ProjectId.make("project-run-context"),
    runId,
    attemptId,
    rootNodeId: NodeId.make("node-run-context"),
    providerThreadId: ProviderThreadId.make("provider-thread-run-context"),
    providerInstanceId: ProviderInstanceId.make("claude-run-context"),
    turnItems: [...store.items.values()],
    userText: "What is the codename?",
    cwd: "/work/run-context",
  });
});

const contextItems = (store: ReturnType<typeof makeStore>) =>
  [...store.items.values()].filter(isPluginContextTurnItem);

describe("prepareRunContext", () => {
  it.effect("saves the call before it runs, then the answer, and reuses both on every retry", () =>
    Effect.gen(function* () {
      const store = makeStore();
      const first = enricherOf([source(1)], (_source, input) =>
        Effect.sync(() => {
          // The record that enrichment began is durable before plugin code runs.
          expect(contextItems(store).map((item) => item.status)).toEqual(["running"]);
          expect(input).toEqual({
            projectId: "project-run-context",
            threadId,
            runId,
            cwd: "/work/run-context",
            message: { text: "What is the codename?", truncated: false },
          });
          return added("The codename is PERIWINKLE-42.");
        }),
      );
      const prepared = yield* prepare(store, first.enricher);
      const entries = [
        { pluginId: "test.p1", item: { title: "Notes", text: "The codename is PERIWINKLE-42." } },
      ];
      expect(prepared).toEqual({ _tag: "ready", entries });
      expect(contextItems(store)).toMatchObject([
        {
          status: "completed",
          title: "Added context from Plugin 1",
          toolSource: { key: "plugin:test.p1", name: "Plugin 1", kind: "integration" },
          input: { plugin: { id: "test.p1", installationId: "installation-1", generation: 1 } },
          output: { context: entries.map((entry) => entry.item) },
        },
      ]);
      expect(store.writes.length).toBe(2);

      // A retried start (worker retry or replay) reads the record and calls nothing.
      const retry = enricherOf([source(1), source(2)], () => Effect.die("must not be called"));
      expect(yield* prepare(store, retry.enricher)).toEqual(prepared);
      expect(retry.calls).toEqual([]);
      expect(store.writes.length).toBe(2);

      expect(withPluginContext("What is the codename?", entries)).toBe(
        '<plugin-context plugin="test.p1" title="Notes">\nThe codename is PERIWINKLE-42.\n</plugin-context>\n\nWhat is the codename?',
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
  );

  it.effect("records a cut-off call as not added and never calls the plugin again", () =>
    Effect.gen(function* () {
      const store = makeStore();
      const called = yield* Deferred.make<void>();
      const hanging = enricherOf([source(1)], () =>
        Deferred.succeed(called, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const fiber = yield* prepare(store, hanging.enricher).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(called);
      // The worker or the process stops while the plugin is still answering.
      yield* Fiber.interrupt(fiber);
      expect(contextItems(store).map((item) => item.status)).toEqual(["running"]);

      const replay = enricherOf([source(1)], () => Effect.die("must not be called"));
      expect(yield* prepare(store, replay.enricher)).toEqual({ _tag: "ready", entries: [] });
      expect(replay.calls).toEqual([]);
      expect(contextItems(store)).toMatchObject([
        {
          status: "failed",
          title: "Context from Plugin 1 not added",
          output: { reason: "The call did not finish before the run's start was retried." },
        },
      ]);
    }).pipe(Effect.provide(IdAllocator.layer)),
  );

  it.effect("fails open: a skipped plugin adds nothing while the others still do", () =>
    Effect.gen(function* () {
      const store = makeStore();
      const { enricher, calls } = enricherOf([source(1), source(2), source(3)], (called) =>
        Effect.succeed(
          called.pluginId === "test.p1"
            ? { _tag: "skipped", reason: "Plugin 1 did not answer within 5 seconds." }
            : called.pluginId === "test.p2"
              ? { _tag: "added", context: [] }
              : added("kept"),
        ),
      );
      expect(yield* prepare(store, enricher)).toEqual({
        _tag: "ready",
        entries: [{ pluginId: "test.p3", item: { title: "Notes", text: "kept" } }],
      });
      expect(calls.toSorted()).toEqual(["test.p1", "test.p2", "test.p3"]);
      expect(
        contextItems(store).map((item) => [item.status, item.title, item.output] as const),
      ).toEqual([
        [
          "failed",
          "Context from Plugin 1 not added",
          { reason: "Plugin 1 did not answer within 5 seconds." },
        ],
        ["completed", "No context from Plugin 2", { context: [] }],
        [
          "completed",
          "Added context from Plugin 3",
          { context: [{ title: "Notes", text: "kept" }] },
        ],
      ]);
    }).pipe(Effect.provide(IdAllocator.layer)),
  );

  it.effect("keeps a constant number of records however many plugins are eligible", () =>
    Effect.gen(function* () {
      const store = makeStore();
      const sources = Array.from({ length: 1_000 }, (_, index) => source(index + 1));
      const { enricher, calls } = enricherOf(sources, () => Effect.succeed(added("x")));
      const prepared = yield* prepare(store, enricher);
      const cap = PLUGIN_ENRICH_LIMITS.maxPluginsPerRun;
      expect(prepared._tag === "ready" ? prepared.entries.length : -1).toBe(cap);
      // The first plugins in catalogue order are called; one record counts the rest.
      expect(calls.toSorted()).toEqual(sources.slice(0, cap).map((called) => called.pluginId));
      expect(store.writes.map((batch) => batch.length)).toEqual([cap + 1, cap]);
      expect(contextItems(store).length).toBe(cap + 1);
      expect(contextItems(store).at(-1)).toMatchObject({
        status: "failed",
        title: "Context from 996 more plugins not added",
        toolSource: { key: "plugins", name: "Plugins", kind: "integration" },
        input: { notCalled: 996 },
        output: {
          reason: "At most 4 plugins add context to one run; 996 more were not called.",
        },
      });

      // The same record shape for a much smaller overflow.
      const few = makeStore();
      yield* prepare(
        few,
        enricherOf(
          Array.from({ length: cap + 1 }, (_, index) => source(index + 1)),
          () => Effect.succeed(added("x")),
        ).enricher,
      );
      expect(contextItems(few).length).toBe(cap + 1);
      expect(contextItems(few).at(-1)).toMatchObject({
        title: "Context from 1 more plugin not added",
        output: { reason: "At most 4 plugins add context to one run; 1 more was not called." },
      });
    }).pipe(Effect.provide(IdAllocator.layer)),
  );

  it.effect("keeps answers in catalogue order until the run's context budget is spent", () =>
    Effect.gen(function* () {
      const store = makeStore();
      const text = (length: number) => "x".repeat(length);
      const { enricher } = enricherOf([source(1), source(2), source(3)], (called) =>
        Effect.succeed(called.pluginId === "test.p3" ? added("small") : added(text(4_500))),
      );
      const prepared = yield* prepare(store, enricher);
      expect(
        prepared._tag === "ready" ? prepared.entries.map((entry) => entry.pluginId) : [],
      ).toEqual(["test.p1", "test.p3"]);
      expect(contextItems(store)[1]).toMatchObject({
        status: "failed",
        title: "Context from Plugin 2 not added",
        output: { reason: "Its context would pass the 8 KiB one run keeps." },
      });
    }).pipe(Effect.provide(IdAllocator.layer)),
  );

  it.effect("counts the run's context budget in UTF-8 bytes, not characters", () =>
    Effect.gen(function* () {
      const store = makeStore();
      // 3,000 characters in all, but 9,000 bytes: the second answer passes the budget.
      const { enricher } = enricherOf([source(1), source(2), source(3)], (called) =>
        Effect.succeed(
          called.pluginId === "test.p1"
            ? added("字".repeat(2_000))
            : called.pluginId === "test.p2"
              ? added("字".repeat(1_000))
              : added("small"),
        ),
      );
      const prepared = yield* prepare(store, enricher);
      expect(
        prepared._tag === "ready" ? prepared.entries.map((entry) => entry.pluginId) : [],
      ).toEqual(["test.p1", "test.p3"]);
      expect(contextItems(store)[1]).toMatchObject({
        status: "failed",
        output: { reason: "Its context would pass the 8 KiB one run keeps." },
      });
    }).pipe(Effect.provide(IdAllocator.layer)),
  );

  it.effect("records nothing for a run that Stop ends while it reads the thread", () =>
    Effect.gen(function* () {
      const store = makeStore();
      const executor = yield* KeyedLock.make<string>();
      const withThreadLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        executor.withLock(threadId, effect);
      const read = yield* Deferred.make<ReadonlyArray<OrchestrationV2TurnItem>>();
      const commit = yield* Deferred.make<void>();
      const sourcesRead = yield* Deferred.make<void>();

      // Stop plans from the thread it read, then commits; the command holds the
      // thread lock from its read to its commit.
      const stop = yield* withThreadLock(
        Effect.gen(function* () {
          yield* Deferred.succeed(read, contextItems(store));
          yield* Deferred.await(commit);
          store.run.status = "interrupted";
          return (yield* Deferred.await(read)).filter((item) => item.status === "running");
        }),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      expect(yield* Deferred.await(read)).toEqual([]);

      const { enricher, calls } = enricherOf([source(1)], () => Effect.succeed(added("late")));
      const start = yield* prepare(
        store,
        {
          ...enricher,
          sources: Deferred.succeed(sourcesRead, undefined).pipe(Effect.as([source(1)])),
        },
        withThreadLock,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      // The start reaches its first write while Stop is between read and commit.
      yield* Deferred.await(sourcesRead);
      yield* Effect.yieldNow;
      expect(store.writes).toEqual([]);
      yield* Deferred.succeed(commit, undefined);

      // Stop saw no record to close, and the start may not leave one running.
      expect(yield* Fiber.join(stop)).toEqual([]);
      expect(yield* Fiber.join(start)).toEqual({ _tag: "stale" });
      expect(contextItems(store)).toEqual([]);
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(IdAllocator.layer)),
  );

  it.effect("stops without saving answers once the run is no longer starting", () =>
    Effect.gen(function* () {
      const store = makeStore();
      const { enricher } = enricherOf([source(1)], () =>
        Effect.sync(() => {
          store.run.status = "interrupted";
          return added("too late");
        }),
      );
      expect(yield* prepare(store, enricher)).toEqual({ _tag: "stale" });
      expect(contextItems(store).map((item) => item.status)).toEqual(["running"]);

      // A run that already moved on is never enriched.
      const moved = makeStore();
      moved.run.status = "running";
      const untouched = enricherOf([source(1)], () => Effect.die("must not be called"));
      expect(yield* prepare(moved, untouched.enricher)).toEqual({ _tag: "stale" });
      expect(untouched.calls).toEqual([]);

      // No plugins: nothing is written.
      const empty = makeStore();
      expect(yield* prepare(empty, enricherOf([], () => Effect.die("none")).enricher)).toEqual({
        _tag: "ready",
        entries: [],
      });
      expect(empty.writes).toEqual([]);
    }).pipe(Effect.provide(IdAllocator.layer)),
  );
});

describe("enrichesRunTurn", () => {
  it("admits exactly the turns the history pager counts, less commands typed with /", () => {
    const at = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
    const messages = OrchestrationV2UserMessageInputIntent.literals.flatMap((inputIntent) =>
      OrchestrationV2Actor.literals.flatMap((createdBy) =>
        ["What is the codename?", "/compact", "  /review"].map(
          (text, index): OrchestrationV2TurnItem => ({
            id: TurnItemId.make(`item-${inputIntent}-${createdBy}-${index}`),
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt: at,
            completedAt: at,
            updatedAt: at,
            type: "user_message",
            messageId: MessageId.make(`message-${inputIntent}-${createdBy}-${index}`),
            inputIntent,
            text,
            attachments: [],
            createdBy,
            creationSource: createdBy === "user" ? "web" : "server",
          }),
        ),
      ),
    );
    const wake = notificationTurnItem(
      messages[0]!,
      {
        notification: {
          source: { kind: "background_task" },
          outcome: "completed",
          summary: "Task finished",
        },
      },
      [],
    );

    // One predicate decides both, so enriched runs can never outnumber counted turns.
    for (const item of [...messages, wake]) {
      const command = item.type === "user_message" && item.text.trimStart().startsWith("/");
      expect(enrichesRunTurn(item)).toBe(isThreadHistoryUserTurn(item) && !command);
    }
    expect(
      messages
        .filter(enrichesRunTurn)
        .map((item) => item.type === "user_message" && [item.inputIntent, item.createdBy]),
    ).toEqual([
      ["turn_start", "user"],
      ["queued_turn", "user"],
    ]);
    expect(enrichesRunTurn(wake)).toBe(false);
    expect(enrichesRunTurn(undefined)).toBe(false);
  });
});
