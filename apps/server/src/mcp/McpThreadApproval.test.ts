import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { orAwaitingApproval } from "./awaitingApproval.ts";
import * as McpClientInput from "./McpClientInput.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpThreadApproval from "./McpThreadApproval.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const now = DateTime.makeUnsafe("2026-11-25T12:00:00.000Z");
const threadId = ThreadId.make("thread:thread-approval");
const sessionId = ProviderSessionId.make("session:thread-approval");
const providerThreadId = ProviderThreadId.make("provider-thread:thread-approval");
const runId = RunId.make("run:thread-approval");
const attemptId = RunAttemptId.make("attempt:thread-approval");
const rootNodeId = NodeId.make("node:thread-approval:root");

const QUESTION = /^Merge pull request #5 in org\/repo\? \(request [0-9a-f]{8}\)$/;

/**
 * A thread of `driver` in the middle of a turn, on the real orchestrator, and a tool that acts
 * outside it. The provider's adapter is never started: nothing here may need it.
 */
const withThread = <A, E>(
  driver: string,
  runtimeMode: RuntimeMode,
  body: (thread: {
    readonly ran: ReadonlyArray<string>;
    readonly call: (number?: number) => Effect.Effect<{
      readonly ran?: string;
      readonly code?: string;
      readonly message?: string;
      readonly status?: string;
      readonly next?: string;
    }>;
    readonly requests: Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly status: string;
        readonly decision?: string | undefined;
        readonly recordOnly: boolean;
      }>
    >;
    readonly cards: Effect.Effect<
      ReadonlyArray<{
        readonly status: string;
        readonly prompt?: string | undefined;
        readonly toolAction?: unknown;
        readonly options?: ReadonlyArray<{ readonly decision: string }> | undefined;
      }>
    >;
    readonly answer: (requestId: string, decision: "accept" | "decline") => Effect.Effect<void>;
    readonly archive: Effect.Effect<void>;
    /** What answering `requestId` left for the provider's adapter to deliver. */
    readonly deliveries: (requestId: string) => Effect.Effect<number>;
    /** The server loses what it kept in memory for the thread, as on a restart. */
    readonly forgetSession: Effect.Effect<void>;
    /** The ids the client was sent as elicitations, which it holds open. */
    readonly elicited: Effect.Effect<ReadonlyArray<unknown>>;
  }) => Effect.Effect<A, E, never>,
  /** Whether the thread's adapter holds what the server sends its client for a request. */
  held = true,
) => {
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "model" };
  const adapter = {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("The provider is never reached"),
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerTest = Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
    McpProviderSessions.layer,
    ProviderReplayHarness.layerWithRegistry(
      { name: `thread-approval-${driver}` },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  );

  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("thread-approval:create"),
      threadId,
      projectId: ProjectId.make("project:thread-approval"),
      title: "Thread approval",
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("thread-approval:session"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("thread-approval:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver: adapter.driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection,
      providerThreadId,
      userMessageId: MessageId.make("message:thread-approval"),
      rootNodeId,
      activeAttemptId: attemptId,
      status: "running" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* projections.apply({
      id: EventId.make("thread-approval:run"),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: run,
    });
    yield* projections.apply({
      id: EventId.make("thread-approval:attempt"),
      type: "run-attempt.created",
      threadId,
      occurredAt: now,
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });

    const ran: Array<string> = [];
    const OutsideToolkit = Toolkit.make(
      Tool.make("acts_outside", {
        parameters: Schema.Struct({ number: Schema.Number }),
        success: orAwaitingApproval(Schema.Struct({ ran: Schema.String })),
        failure: OrchestratorMcpFailure,
        failureMode: "return" as const,
        dependencies: [
          McpInvocationContext.McpInvocationContext,
          ThreadManagement.ThreadManagementService,
        ],
      }),
    );
    const toolkit = yield* OutsideToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(
          McpToolAccess.toLayer(OutsideToolkit, {
            acts_outside: McpToolAccess.actsOutsideThread("acts_outside", ({ number }) =>
              Effect.succeed({
                asks: {
                  action: "Merge",
                  target: `pull request #${number}`,
                  repository: "org/repo",
                },
                run: Effect.sync(() => {
                  ran.push(`merged #${number}`);
                  return { ran: `merged #${number}` };
                }),
              }),
            ),
          }),
        ),
      ),
    );
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: `provider:${threadId}`,
      thread: { threadId, providerSessionId: sessionId, providerInstanceId: instanceId },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    };
    // The thread's adapter holds what the server sends its client until the request ends.
    if (held) yield* sessions.holdsApprovalRequests(instanceId);
    const elicited = Ref.makeUnsafe<ReadonlyArray<unknown>>([]);
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      protocolVersion: "2025-06-18",
      clientCapabilities: {},
      clientInfo: { name: "thread-approval", version: "1" },
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "thread-approval", version: "1" },
      },
      getClient: Effect.succeed({
        listRoots: () => Effect.die("unused"),
        createMessage: () => Effect.die("unused"),
        elicit: (request) =>
          Ref.update(elicited, (current) => [...current, request._meta]).pipe(
            Effect.andThen(Effect.never),
          ),
      } as McpSchema.McpReverseClient),
    });
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        orchestrator.getThreadShell(id).pipe(
          Effect.map((stored) => ({
            ...liveThreadShell(id, { runtimeMode, activeRunId: runId }),
            providerInstanceId: instanceId,
            modelSelection,
            archivedAt: stored?.archivedAt ?? null,
          })),
        ),
      getThreadRecords: orchestrator.getThreadRecords,
      getThreadEventSequence: orchestrator.getThreadEventSequence,
      streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
      dispatch: orchestrator.dispatch,
    });
    const call = (number = 5) =>
      toolkit.handle("acts_outside", { number }).pipe(
        Stream.unwrap,
        Stream.run(Sink.last()),
        Effect.flatMap(Effect.fromOption),
        Effect.map(
          ({ result }) =>
            result as {
              readonly ran?: string;
              readonly code?: string;
              readonly message?: string;
              readonly status?: string;
              readonly next?: string;
            },
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpClientInput.McpClientInput, { sessions }),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.provideService(
          McpSchema.McpRequestContext,
          McpSchema.McpRequestContext.of({
            clientId: 1,
            protocolVersion: "2025-06-18",
            clientCapabilities: new McpSchema.ClientCapabilities({ elicitation: {} }),
          }),
        ),
        Effect.provide(threads),
        Effect.orDie,
      );
    const records = orchestrator
      .getThreadRecords(threadId, ["runtimeRequests", "turnItems"])
      .pipe(Effect.orDie);

    return yield* body({
      ran,
      call,
      requests: records.pipe(
        Effect.map(({ runtimeRequests }) =>
          runtimeRequests.map((request) => ({
            id: request.id,
            status: request.status,
            decision: request.decision,
            recordOnly:
              request.responseCapability.type === "live" &&
              request.responseCapability.recordOnly === true,
          })),
        ),
      ),
      cards: records.pipe(
        Effect.map(({ turnItems }) =>
          turnItems.flatMap((item) => (item.type === "approval_request" ? [item] : [])),
        ),
      ),
      // What a client sends when the person presses a button on the card.
      answer: (requestId, decision) =>
        orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(`thread-approval:answer:${requestId}`),
            threadId,
            requestId: requestId as never,
            decision,
          })
          .pipe(Effect.asVoid, Effect.orDie),
      archive: orchestrator
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("thread-approval:archive"),
          threadId,
        })
        .pipe(Effect.asVoid, Effect.orDie),
      deliveries: (requestId) =>
        outbox.listByCommandId(CommandId.make(`thread-approval:answer:${requestId}`)).pipe(
          Effect.map((effects) => effects.length),
          Effect.orDie,
        ),
      forgetSession: sessions.clear(threadId),
      elicited: Ref.get(elicited),
    });
  }).pipe(Effect.provide(layerTest), Effect.orDie);
};

/** Lets the fibers that follow a request read what just changed. */
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));

it.effect(
  "a thread below Full access is asked by a request the server raises, and one approval lets one call through",
  () =>
    withThread("codex", "approval-required", (thread) =>
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(thread.call());
        yield* settle;
        // The request is the server's own: answering it sends the provider nothing.
        const [request] = yield* thread.requests;
        assert.deepInclude(request, { status: "pending", recordOnly: true });
        const [card] = yield* thread.cards;
        assert.equal(card?.status, "waiting");
        assert.match(card?.prompt ?? "", QUESTION);
        assert.deepEqual(card?.toolAction, {
          tool: "acts_outside",
          action: "Merge",
          target: "pull request #5",
          repository: "org/repo",
        });
        assert.deepEqual(
          card?.options?.map((option) => option.decision),
          ["cancel", "decline", "accept"],
        );
        // The client is sent that request by its id, and holds it.
        assert.deepEqual(
          (yield* thread.elicited).map(
            (meta) =>
              `runtime-request:t3-tool:${(meta as Record<string, string>)["t3.codes/approval-request"]}`,
          ),
          [request!.id],
        );

        // Nothing is timed: hours later the call is still waiting, with nothing done.
        yield* TestClock.adjust("6 hours");
        yield* settle;
        assert.deepInclude((yield* thread.requests)[0], { status: "pending" });
        assert.deepEqual(thread.ran, []);

        yield* thread.answer(request!.id, "accept");
        assert.equal(yield* thread.deliveries(request!.id), 0);
        assert.deepEqual(yield* Fiber.join(first), { ran: "merged #5" });
        assert.deepEqual(thread.ran, ["merged #5"]);
        assert.equal((yield* thread.cards)[0]?.status, "completed");

        // That approval is spent: the same call asks again.
        const second = yield* Effect.forkChild(thread.call());
        yield* settle;
        const requests = yield* thread.requests;
        assert.equal(requests.length, 2);
        yield* thread.answer(requests[1]!.id, "decline");
        assert.deepInclude(yield* Fiber.join(second), {
          code: "capability_denied",
          message: 'Not done: the user declined "Merge pull request #5 in org/repo".',
        });
        assert.deepEqual(thread.ran, ["merged #5"]);
      }),
    ),
);

it.effect(
  "a call cut off while it waits leaves the request, and the same call finds its answer",
  () =>
    withThread("claudeAgent", "auto-accept-edits", (thread) =>
      Effect.gen(function* () {
        const cut = yield* Effect.forkChild(thread.call());
        yield* settle;
        yield* Fiber.interrupt(cut);
        const [request] = yield* thread.requests;
        assert.deepInclude(request, { status: "pending" });
        yield* thread.answer(request!.id, "accept");
        yield* settle;

        // Arguments that differ are another request, which the approval does not cover.
        const other = yield* Effect.forkChild(thread.call(6));
        yield* settle;
        assert.equal((yield* thread.requests).length, 2);
        assert.deepEqual(thread.ran, []);

        assert.deepEqual(yield* thread.call(), { ran: "merged #5" });
        yield* Fiber.interrupt(other);
      }),
    ),
);

it.effect("archiving the thread declines what it was asked", () =>
  withThread("codex", "approval-required", (thread) =>
    Effect.gen(function* () {
      const call = yield* Effect.forkChild(thread.call());
      yield* settle;
      yield* thread.archive;
      assert.deepInclude(yield* Fiber.join(call), {
        code: "capability_denied",
        message: 'Not done: the user declined "Merge pull request #5 in org/repo".',
      });
      assert.deepInclude((yield* thread.requests)[0], { status: "resolved", decision: "decline" });
      assert.deepEqual(thread.ran, []);
    }),
  ),
);

it.effect("an answer to a request the server no longer keeps lets nothing through", () =>
  withThread("codex", "approval-required", (thread) =>
    Effect.gen(function* () {
      const waiting = yield* Effect.forkChild(thread.call());
      yield* settle;
      // What a restart loses. The call that waited hears it was cancelled.
      yield* thread.forgetSession;
      assert.match(
        (yield* Fiber.join(waiting)).message ?? "",
        /^Cancelled, nothing was done: the request to approve "Merge pull request #5 in org\/repo" ended without the user's answer\./,
      );
      const [request] = yield* thread.requests;
      // Even if the old request is then approved, the same call is asked afresh.
      if (request!.status === "pending") yield* thread.answer(request!.id, "accept");
      const again = yield* Effect.forkChild(thread.call());
      yield* settle;
      assert.equal((yield* thread.requests).length, 2);
      assert.deepEqual(thread.ran, []);
      yield* Fiber.interrupt(again);
    }),
  ),
);

it.effect("a Full access thread runs unasked", () =>
  withThread("codex", "full-access", (thread) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* thread.call(), { ran: "merged #5" });
      assert.deepEqual(yield* thread.requests, []);
    }),
  ),
);

// One thread per provider family whose client holds nothing open for a request.
it.effect.each(["cursor", "opencode", "pi"] as const)(
  "a %s thread is asked by the same request, and its call is told the person has not answered yet",
  (driver) =>
    withThread(
      driver,
      "approval-required",
      (thread) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(thread.call());
          yield* settle;
          yield* TestClock.adjust(McpThreadApproval.UNHELD_WAIT);
          // That is an answer, not a failure: the call ended, and what it asks is still open.
          const waiting = yield* Fiber.join(first);
          assert.equal(waiting.code, undefined);
          assert.equal(waiting.status, "awaiting_approval");
          assert.match(
            waiting.next ?? "",
            /^Not done yet: T3 Code is asking the user to approve "Merge pull request #5 in org\/repo" in this thread, and they have not answered\. The request stays open until they answer or this turn ends\. Call again with the same arguments to wait for their answer\.$/,
          );
          assert.deepEqual(thread.ran, []);
          // Nothing is sent to a client that would show or answer it for itself.
          assert.deepEqual(yield* thread.elicited, []);
          const [request] = yield* thread.requests;
          assert.deepInclude(request, { status: "pending", recordOnly: true });

          // The same call again waits on that request, and shows no second one.
          const second = yield* Effect.forkChild(thread.call());
          yield* settle;
          assert.equal((yield* thread.requests).length, 1);

          // Hours later it is still theirs to answer, and their answer lets that one call through.
          yield* TestClock.adjust(McpThreadApproval.UNHELD_WAIT);
          assert.equal((yield* Fiber.join(second)).status, "awaiting_approval");
          yield* TestClock.adjust("4 hours");
          assert.deepInclude((yield* thread.requests)[0], { status: "pending" });
          yield* thread.answer(request!.id, "accept");
          yield* settle;
          assert.deepEqual(yield* thread.call(), { ran: "merged #5" });
          assert.deepEqual(thread.ran, ["merged #5"]);
          assert.equal((yield* thread.requests).length, 1);
        }),
      false,
    ),
);
