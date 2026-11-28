import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  TextGenerationError,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadRecap,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ThreadRecaps from "../persistence/ThreadRecaps.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadRecapService from "./ThreadRecapService.ts";

const now = DateTime.makeUnsafe("2026-11-28T12:00:00.000Z");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const nodeId = NodeId.make("node-1");
const baseThread = {
  id: threadId,
  projectId,
  title: "Auth refactor",
  worktreePath: null,
  deletedAt: null,
} as unknown as OrchestrationV2AppThread;
const completedRun = {
  id: RunId.make("run-1"),
  threadId,
  ordinal: 1,
  status: "completed",
} as unknown as OrchestrationV2Run;
const msg = (id: string, role: "user" | "assistant", text: string) =>
  ({
    id: MessageId.make(id),
    threadId,
    role,
    text,
    attachments: [],
    streaming: false,
    updatedAt: now,
  }) as unknown as OrchestrationV2ConversationMessage;

const makeHarness = (
  enabled: boolean,
  initialMessages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  generate: (
    input: TextGeneration.ThreadRecapGenerationInput,
  ) => Effect.Effect<TextGeneration.ThreadRecapGenerationResult, TextGenerationError>,
) =>
  Effect.gen(function* () {
    const sqlLayer = Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    );
    const messagesRef = yield* Ref.make(initialMessages);
    const settingsRef = yield* Ref.make<ServerSettingsValue>({
      ...DEFAULT_SERVER_SETTINGS,
      threadRecapEnabled: enabled,
    });
    const settingsPubSub = yield* PubSub.unbounded<ServerSettingsValue>();
    const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
    let recordReads = 0;

    const deps = Layer.mergeAll(
      ThreadRecaps.layer.pipe(Layer.provide(sqlLayer)),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.gen(function* () {
            recordReads += 1;
            return {
              thread: baseThread,
              messages: yield* Ref.get(messagesRef),
              runs: [completedRun],
              runtimeRequests: [],
              plans: [],
              checkpoints: [],
            } as never;
          }),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromPubSub(domainEvents),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () => Effect.succeedSome({ id: projectId, workspaceRoot: "/workspace/t3" } as never),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Ref.get(settingsRef),
        subscribeChanges: Effect.succeed(Stream.fromPubSub(settingsPubSub)),
      }),
      Layer.mock(TextGeneration.TextGeneration)({ generateThreadRecap: generate }),
      FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
    );

    const scope = yield* Scope.make();
    const ctx = yield* Layer.buildWithScope(
      ThreadRecapService.layerWithOptions({ initialIdleMs: 1_000, refreshIdleMs: 2_000 }).pipe(
        Layer.provide(deps),
      ),
      scope,
    );
    const service = ctx.mapUnsafe.get(
      ThreadRecapService.ThreadRecapService.key,
    ) as ThreadRecapService.ThreadRecapService["Service"];

    const subscribe = () =>
      Effect.gen(function* () {
        const subScope = yield* Scope.make();
        const received: Array<OrchestrationV2ThreadRecap> = [];
        const fiber = yield* service.subscribe(threadId).pipe(
          Stream.runForEach((value) => Effect.sync(() => received.push(value))),
          Effect.forkIn(subScope),
        );
        return {
          received,
          close: () => Scope.close(subScope, Exit.void).pipe(Effect.andThen(Fiber.await(fiber))),
        };
      });

    return {
      subscribe,
      messagesRef,
      reads: () => recordReads,
      emit: (type: OrchestrationV2DomainEvent["type"] = "thread.metadata-updated") =>
        PubSub.publish(domainEvents, {
          id: EventId.make("ev-1"),
          threadId,
          occurredAt: now,
          type,
          payload: type === "turn-item.updated" ? { nodeId } : baseThread,
        } as unknown as OrchestrationV2DomainEvent),
      setEnabled: (nextEnabled: boolean) =>
        Effect.gen(function* () {
          const next = { ...(yield* Ref.get(settingsRef)), threadRecapEnabled: nextEnabled };
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(settingsPubSub, next);
        }),
      close: () => Scope.close(scope, Exit.void),
    };
  });

describe("ThreadRecapService", () => {
  it.effect(
    "gates on Labs, ignores tool noise, persists, and reuses cached recap on re-subscribe",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const h = yield* makeHarness(
          false,
          [msg("m1", "user", "Refactor auth"), msg("m2", "assistant", "Moved auth middleware.")],
          () => {
            calls += 1;
            return Effect.succeed({ recap: "Auth refactor: moved middleware." });
          },
        );
        const sub = yield* h.subscribe();
        yield* TestClock.adjust(Duration.millis(5_000));
        assert.strictEqual(calls, 0);

        yield* h.setEnabled(true);
        yield* TestClock.adjust(Duration.millis(1_000));
        yield* Effect.yieldNow;
        assert.strictEqual(calls, 1);
        assert.strictEqual(sub.received.at(-1)?.text, "Auth refactor: moved middleware.");

        const beforeNoise = h.reads();
        yield* h.emit("turn-item.updated");
        yield* Effect.yieldNow;
        assert.strictEqual(h.reads(), beforeNoise);
        yield* sub.close();

        const resub = yield* h.subscribe();
        yield* TestClock.adjust(Duration.millis(5_000));
        assert.strictEqual(calls, 1);
        assert.strictEqual(resub.received[0]?.text, "Auth refactor: moved middleware.");
        yield* resub.close();
        yield* h.close();
      }),
  );

  it.effect("cancels pending generation when last subscriber unsubscribes before debounce", () =>
    Effect.gen(function* () {
      let calls = 0;
      const h = yield* makeHarness(true, [msg("m1", "user", "Build recap")], () => {
        calls += 1;
        return Effect.succeed({ recap: "Should not run." });
      });
      const sub = yield* h.subscribe();
      yield* TestClock.adjust(Duration.millis(500));
      yield* sub.close();
      yield* TestClock.adjust(Duration.millis(5_000));
      assert.strictEqual(calls, 0);
      yield* h.close();
    }),
  );

  it.effect("discards stale generation when a newer message arrives mid-flight", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const h = yield* makeHarness(true, [msg("m1", "user", "First")], () =>
        Effect.gen(function* () {
          calls += 1;
          if (calls === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { recap: "Stale recap." };
          }
          return { recap: "Fresh recap." };
        }),
      );
      const sub = yield* h.subscribe();
      yield* TestClock.adjust(Duration.millis(1_000));
      yield* Deferred.await(started);

      yield* Ref.set(h.messagesRef, [msg("m1", "user", "First"), msg("m2", "assistant", "Second")]);
      yield* h.emit();
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust(Duration.zero);
      yield* TestClock.adjust(Duration.millis(1_000));
      yield* TestClock.adjust(Duration.zero);

      assert.strictEqual(calls, 2);
      assert.isFalse(sub.received.some((entry) => entry.text === "Stale recap."));
      assert.strictEqual(sub.received.at(-1)?.text, "Fresh recap.");
      yield* sub.close();
      yield* h.close();
    }),
  );

  it.effect("backs off after failure for the same signature until new material arrives", () =>
    Effect.gen(function* () {
      let calls = 0;
      const h = yield* makeHarness(true, [msg("m1", "user", "Try recap")], () => {
        calls += 1;
        return calls === 1
          ? Effect.fail(
              new TextGenerationError({ operation: "generateThreadRecap", detail: "Down" }),
            )
          : Effect.succeed({ recap: "Recovered recap." });
      });
      const sub = yield* h.subscribe();
      yield* TestClock.adjust(Duration.millis(1_000));
      yield* Effect.yieldNow;
      assert.strictEqual(calls, 1);
      assert.strictEqual(sub.received.at(-1)?.status, "error");

      yield* h.emit();
      yield* TestClock.adjust(Duration.millis(5_000));
      assert.strictEqual(calls, 1);

      yield* Ref.set(h.messagesRef, [msg("m1", "user", "Try recap"), msg("m2", "assistant", "Ok")]);
      yield* h.emit();
      yield* TestClock.adjust(Duration.millis(1_000));
      yield* Effect.yieldNow;
      assert.strictEqual(calls, 2);
      assert.strictEqual(sub.received.at(-1)?.text, "Recovered recap.");
      yield* sub.close();
      yield* h.close();
    }),
  );
});
