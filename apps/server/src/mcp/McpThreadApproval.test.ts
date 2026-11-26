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
const WAITING =
  /^Not done yet: T3 Code is asking the user to approve "Merge pull request #5 in org\/repo" in this thread, and they have not answered\. Call again with the same arguments to wait for their answer\.$/;

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
    readonly endRun: Effect.Effect<void>;
    /** What answering `requestId` left for the provider's adapter to deliver. */
    readonly deliveries: (requestId: string) => Effect.Effect<number>;
    readonly asksByElicitation: Effect.Effect<void>;
    readonly elicited: Effect.Effect<McpSchema.InputRequired | undefined>;
  }) => Effect.Effect<A, E, never>,
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
    const elicited = Ref.makeUnsafe<McpSchema.InputRequired | undefined>(undefined);
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({
          ...liveThreadShell(id, { runtimeMode, activeRunId: runId }),
          providerInstanceId: instanceId,
          modelSelection,
        }),
      getThreadRecords: orchestrator.getThreadRecords,
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
        Effect.provideService(McpClientInput.McpClientInput, { request: elicited, sessions }),
        Effect.provideService(
          McpSchema.McpRequestContext,
          McpSchema.McpRequestContext.of({
            clientId: 1,
            protocolVersion: "2026-07-28",
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
      endRun: projections
        .apply({
          id: EventId.make("thread-approval:run-ended"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        })
        .pipe(Effect.orDie),
      deliveries: (requestId) =>
        outbox.listByCommandId(CommandId.make(`thread-approval:answer:${requestId}`)).pipe(
          Effect.map((effects) => effects.length),
          Effect.orDie,
        ),
      asksByElicitation: sessions.showsApprovalRequests(instanceId),
      elicited: Ref.get(elicited),
    });
  }).pipe(Effect.provide(layerTest), Effect.orDie);
};

// One thread per provider family that keeps no record of an answer given through its client.
it.effect.each(["acpRegistry", "cursor", "opencode", "pi"] as const)(
  "a %s thread below Full access is asked in the thread, and one approval lets one call through",
  (driver) =>
    withThread(driver, "approval-required", (thread) =>
      Effect.gen(function* () {
        // The call waits for the person, then says it is still waiting. Nothing has run.
        const first = yield* Effect.forkChild(thread.call());
        yield* TestClock.adjust(McpThreadApproval.ANSWER_WAIT);
        // That is an answer, not a failure: the call ended, and what it asks is still open.
        const waiting = yield* Fiber.join(first);
        assert.equal(waiting.code, undefined);
        assert.equal(waiting.status, "awaiting_approval");
        assert.match(waiting.next ?? "", WAITING);
        assert.deepEqual(thread.ran, []);

        // The request is the same card the Claude and Codex adapters raise for this question.
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

        // The same call again waits on that request, and shows no second one.
        const second = yield* Effect.forkChild(thread.call());
        yield* TestClock.adjust("2 seconds");
        assert.equal((yield* thread.requests).length, 1);
        assert.deepEqual(thread.ran, []);

        // The person approves in the app. The server records it and sends the provider nothing.
        yield* thread.answer(request!.id, "accept");
        assert.equal(yield* thread.deliveries(request!.id), 0);
        yield* TestClock.adjust("1 second");
        assert.deepEqual(yield* Fiber.join(second), { ran: "merged #5" });
        assert.deepEqual(thread.ran, ["merged #5"]);
        assert.equal((yield* thread.cards)[0]?.status, "completed");

        // That approval is spent: the same call asks again.
        const third = yield* Effect.forkChild(thread.call());
        yield* TestClock.adjust("1 second");
        const requests = yield* thread.requests;
        assert.equal(requests.length, 2);
        assert.deepInclude(requests[1], { status: "pending" });
        assert.deepEqual(thread.ran, ["merged #5"]);
        yield* thread.answer(requests[1]!.id, "decline");
        yield* TestClock.adjust("1 second");
        assert.deepInclude(yield* Fiber.join(third), {
          code: "capability_denied",
          message: 'Not done: the user declined "Merge pull request #5 in org/repo".',
        });
        assert.deepEqual(thread.ran, ["merged #5"]);
      }),
    ),
);

it.effect("an approval answered between two calls is found by the second", () =>
  withThread("cursor", "auto-accept-edits", (thread) =>
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(thread.call());
      yield* TestClock.adjust(McpThreadApproval.ANSWER_WAIT);
      assert.match((yield* Fiber.join(first)).next ?? "", WAITING);
      const [request] = yield* thread.requests;
      yield* thread.answer(request!.id, "accept");

      // Arguments that differ are another request, which the approval does not cover.
      const other = yield* Effect.forkChild(thread.call(6));
      yield* TestClock.adjust("1 second");
      assert.equal((yield* thread.requests).length, 2);
      assert.deepEqual(thread.ran, []);

      assert.deepEqual(yield* thread.call(), { ran: "merged #5" });
      yield* Fiber.interrupt(other);
    }),
  ),
);

it.effect("a request the agent stops asking about ends with its turn", () =>
  withThread("opencode", "approval-required", (thread) =>
    Effect.gen(function* () {
      const first = yield* Effect.forkChild(thread.call());
      yield* TestClock.adjust(McpThreadApproval.ANSWER_WAIT);
      yield* Fiber.join(first);
      assert.deepInclude((yield* thread.requests)[0], { status: "pending" });

      yield* thread.endRun;
      yield* TestClock.adjust("1 second");
      assert.deepInclude((yield* thread.requests)[0], { status: "resolved", decision: "cancel" });
      assert.equal((yield* thread.cards)[0]?.status, "cancelled");

      // With no turn to show a request in, the thread is told exactly that, and nothing runs.
      const refused = yield* thread.call();
      assert.equal(refused.code, "capability_denied");
      assert.equal(
        refused.message,
        'Not done: "Merge pull request #5 in org/repo" needs the user\'s approval below Full access, and T3 Code asks them in a turn of this thread, which has none running now. Call again during a turn.',
      );
      assert.equal((yield* thread.requests).length, 1);
      assert.deepEqual(thread.ran, []);
    }),
  ),
);

it.effect("a Full access thread of any provider runs unasked", () =>
  withThread("cursor", "full-access", (thread) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* thread.call(), { ran: "merged #5" });
      assert.deepEqual(yield* thread.requests, []);
    }),
  ),
);

it.effect(
  "a thread whose adapter passes on the person's answer is still asked by elicitation",
  () =>
    withThread("codex", "approval-required", (thread) =>
      Effect.gen(function* () {
        yield* thread.asksByElicitation;
        yield* thread.call();
        assert.match(
          (
            (yield* thread.elicited)?.inputRequests?.["outside-action"] as
              | { readonly params: { readonly message: string } }
              | undefined
          )?.params.message ?? "",
          QUESTION,
        );
        assert.deepEqual(yield* thread.requests, []);
        assert.deepEqual(thread.ran, []);
      }),
    ),
);
