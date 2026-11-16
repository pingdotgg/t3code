import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { claudeFyiHooks } from "./ClaudeFyiHook.ts";
import { FYI_TOOL_BATCH_BUDGET_CHARS, waitingFyi } from "./Fyi.ts";
import * as FyiDelivery from "./FyiDelivery.ts";

const threadId = ThreadId.make("thread:fyi-delivery");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const runId = (key: string) => RunId.make(`run:fyi-delivery:${key}`);
const carrier = (key: string) => ({
  runId: runId(key),
  nodeId: NodeId.make(`node:${key}`),
  providerThreadId: ProviderThreadId.make("provider-thread:fyi-delivery"),
});

const layerStores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

/** Runs `before` once, ahead of the first FYI bind, as a write that lands between read and bind. */
const layerWithBeforeBind = (before: Ref.Ref<Effect.Effect<void>>) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const delegate = yield* EventSink.EventSinkV2;
      const once = Ref.getAndSet(before, Effect.void).pipe(Effect.flatten);
      return EventSink.EventSinkV2.of({
        ...delegate,
        write: (input) => once.pipe(Effect.andThen(delegate.write(input))),
        writeIfTurnItemUnchanged: (input) =>
          once.pipe(Effect.andThen(delegate.writeIfTurnItemUnchanged(input))),
      });
    }),
  );

const run = (key: string, ordinal: number, status: OrchestrationV2Run["status"]) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    return {
      id: EventId.make(`event:run:${key}`),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: {
        id: runId(key),
        threadId,
        ordinal,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${key}`),
        rootNodeId: NodeId.make(`node:${key}`),
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    } satisfies OrchestrationV2DomainEvent;
  });

/** A thread with one running run and these FYI messages waiting, oldest first. */
const seed = (texts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:fyi-delivery"),
            title: "FYI delivery",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        yield* run("live", 1, "running"),
        ...texts.flatMap((text, index) => {
          const { message, item } = waitingFyi({
            command: {
              type: "message.dispatch",
              commandId: CommandId.make(`command:fyi:${index}`),
              threadId,
              messageId: MessageId.make(`message:fyi:${index}`),
              senderThreadId: ThreadId.make("thread:chief"),
              text,
              attachments: [],
              dispatchMode: { type: "fyi" },
              createdBy: "agent",
              creationSource: "mcp",
            },
            itemId: TurnItemId.make(`item:fyi:${index}`),
            ordinal: index + 1,
            now: DateTime.add(now, { seconds: index }),
          });
          return [
            {
              id: EventId.make(`event:fyi-message:${index}`),
              type: "message.updated" as const,
              threadId,
              occurredAt: now,
              payload: message,
            },
            {
              id: EventId.make(`event:fyi-item:${index}`),
              type: "turn-item.updated" as const,
              threadId,
              occurredAt: now,
              payload: item,
            },
          ];
        }),
      ],
    });
  });

const fyiItems = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const { turnItems } = yield* store.getThreadRecords(threadId, ["turnItems"]);
  return turnItems.flatMap((item) =>
    item.type === "user_message" && item.fyi === true
      ? [{ text: item.text, runId: item.runId, status: item.status }]
      : [],
  );
});

/** Binds the FYI at `index` to another run, as a turn start would; it needs no services to run. */
const bindElsewhere = (index: number) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    return Effect.gen(function* () {
      const { turnItems } = yield* store.getThreadRecords(threadId, ["turnItems"]);
      const item = turnItems.find((candidate) => candidate.id === `item:fyi:${index}`)!;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:elsewhere:${index}`),
            type: "turn-item.updated",
            threadId,
            occurredAt: yield* DateTime.now,
            payload: { ...item, runId: runId("elsewhere"), status: "completed" },
          },
        ],
      });
    }).pipe(Effect.orDie);
  });

const toolBatch = (input: {
  readonly agentId?: string;
  readonly aborted?: true;
  readonly signal?: AbortSignal;
}) =>
  Effect.gen(function* () {
    const fyi = yield* FyiDelivery.FyiDelivery;
    const hooks = claudeFyiHooks({
      fyi,
      threadId,
      activeTurn: Effect.succeed({
        threadId,
        runId: runId("live"),
        rootNodeId: NodeId.make("node:live"),
        providerThread: { id: ProviderThreadId.make("provider-thread:fyi-delivery") },
      }),
      runPromise: Effect.runPromise,
    });
    const callback = hooks.PostToolBatch![0]!.hooks[0]!;
    return yield* Effect.promise(() =>
      callback(
        {
          hook_event_name: "PostToolBatch",
          tool_calls: [{ tool_name: "Bash", tool_input: {}, tool_use_id: "tool-1" }],
          session_id: "native-fyi",
          transcript_path: "/transcripts/native-fyi.jsonl",
          cwd: "/workspace",
          ...(input.agentId === undefined ? {} : { agent_id: input.agentId }),
        } satisfies HookInput,
        undefined,
        {
          signal:
            input.signal ?? (input.aborted ? AbortSignal.abort() : new AbortController().signal),
        },
      ),
    );
  });

/** Claude Code owns the hook's signal; a test aborts it as Stop would. */
const claudeCodeStop = () => new AbortController();

const HOOK_HEADER =
  "FYI messages arrived during your turn. No action is needed. Use them only if they change your current work.";

/** Each call gets its own database. */
const withDelivery = <A, E>(
  body: (
    before: Ref.Ref<Effect.Effect<void>>,
  ) => Effect.Effect<
    A,
    E,
    FyiDelivery.FyiDelivery | EventSink.EventSinkV2 | ProjectionStore.ProjectionStoreV2
  >,
) =>
  Effect.gen(function* () {
    const before = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const layerSink = layerWithBeforeBind(before).pipe(Layer.provide(EventSink.layer));
    return yield* body(before).pipe(
      Effect.provide(
        FyiDelivery.layer.pipe(Layer.provideMerge(layerSink), Layer.provideMerge(layerStores)),
      ),
    );
  });

it.effect(
  "a running Claude agent gets the waiting FYI messages that fit at its next tool call",
  () =>
    withDelivery(() =>
      Effect.gen(function* () {
        const big = "x".repeat(FYI_TOOL_BATCH_BUDGET_CHARS);
        yield* seed(["main moved", big, "CI is green"]);

        assert.deepStrictEqual(yield* toolBatch({ aborted: true }), {});
        assert.deepStrictEqual(yield* toolBatch({ agentId: "subagent-1" }), {});
        assert.isTrue(
          (yield* fyiItems).every((item) => item.runId === null),
          "an aborted hook or a subagent's tool call binds nothing",
        );

        const output = yield* toolBatch({});
        assert.deepStrictEqual(output, {
          hookSpecificOutput: {
            hookEventName: "PostToolBatch",
            additionalContext: `${HOOK_HEADER}\n\n<fyi from="thread thread:chief" sent="1970-01-01T00:00:00.000Z">\nmain moved\n</fyi>\n\n<fyi from="thread thread:chief" sent="1970-01-01T00:00:02.000Z">\nCI is green\n</fyi>`,
          },
        });
        assert.deepStrictEqual(yield* fyiItems, [
          { text: "main moved", runId: runId("live"), status: "completed" },
          { text: big, runId: null, status: "pending" },
          { text: "CI is green", runId: runId("live"), status: "completed" },
        ]);
      }),
    ),
);

it.effect("a tool call returns no FYI that a turn bound after it was read", () =>
  withDelivery((before) =>
    Effect.gen(function* () {
      yield* seed(["main moved"]);
      yield* Ref.set(before, yield* bindElsewhere(0));
      assert.deepStrictEqual(yield* toolBatch({}), {});
      assert.deepStrictEqual(yield* fyiItems, [
        { text: "main moved", runId: runId("elsewhere"), status: "completed" },
      ]);
    }),
  ),
);

it.effect("a turn start binds no FYI that changed after it was rendered, and logs it", () => {
  const logged: Array<unknown> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    logged.push(...(Array.isArray(message) ? message : [message]));
  });
  return withDelivery((before) =>
    Effect.gen(function* () {
      const fyi = yield* FyiDelivery.FyiDelivery;
      yield* seed(["main moved", "CI is green"]);
      const turn = yield* fyi.forTurn({
        threadId,
        message: {
          text: "Fix the flaky test",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        goalCommand: false,
        resumesNatively: false,
      });
      yield* Ref.set(before, yield* bindElsewhere(0));
      yield* turn.carry(carrier("live"));
      assert.deepStrictEqual(yield* fyiItems, [
        { text: "main moved", runId: runId("elsewhere"), status: "completed" },
        { text: "CI is green", runId: runId("live"), status: "completed" },
      ]);
      assert.include(logged, "An FYI message changed before its turn took it");
    }),
  ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it.effect("a tool call returns the FYI messages it bound when a later bind fails", () =>
  withDelivery((before) =>
    Effect.gen(function* () {
      yield* seed(["main moved", "CI is green"]);
      yield* Ref.set(before, Ref.set(before, Effect.die("database is down")));
      assert.deepStrictEqual(yield* toolBatch({}), {
        hookSpecificOutput: {
          hookEventName: "PostToolBatch",
          additionalContext: `${HOOK_HEADER}\n\n<fyi from="thread thread:chief" sent="1970-01-01T00:00:00.000Z">\nmain moved\n</fyi>`,
        },
      });
      assert.deepStrictEqual(yield* fyiItems, [
        { text: "main moved", runId: runId("live"), status: "completed" },
        { text: "CI is green", runId: null, status: "pending" },
      ]);
    }),
  ),
);

it.effect("an FYI a cancelled tool call bound waits again once its run ends interrupted", () =>
  withDelivery((before) =>
    Effect.gen(function* () {
      const fyi = yield* FyiDelivery.FyiDelivery;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* seed(["main moved"]);
      const binding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Ref.set(
        before,
        Deferred.succeed(binding, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const stop = claudeCodeStop();
      const hook = yield* toolBatch({ signal: stop.signal }).pipe(Effect.forkChild);
      yield* Deferred.await(binding);
      stop.abort();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(hook);
      assert.deepStrictEqual(
        yield* fyiItems,
        [{ text: "main moved", runId: runId("live"), status: "completed" }],
        "the bind committed before the abort reached it",
      );

      const { runs } = yield* store.getThreadRecords(threadId, ["runs"]);
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:run:live:interrupted"),
            type: "run.updated",
            threadId,
            runId: runId("live"),
            occurredAt: yield* DateTime.now,
            payload: { ...runs[0]!, status: "interrupted", completedAt: yield* DateTime.now },
          },
        ],
      });
      const next = yield* fyi.forTurn({
        threadId,
        message: { text: "Go on", attachments: [], createdBy: "user", creationSource: "web" },
        goalCommand: false,
        resumesNatively: false,
      });
      assert.include(next.text, "main moved");
    }),
  ),
);
