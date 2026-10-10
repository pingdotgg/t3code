/**
 * Drives the real Grok adapter through the background-shell sequence recorded
 * from Grok 1.0.50. The shell's tool id is `call-<uuid>-N`, its start ACK is
 * `BackgroundTaskStarted`, and `task_completed` arrives on
 * `_x.ai/session/update` before `session/prompt` returns.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import { GrokSettings } from "../settings.ts";
import { makeGrokAdapterV2, type GrokAdapterV2Options } from "./adapter.ts";

const SHELL_ID = "call-3e89cd85-00b8-4678-acaf-d4d13afe3289-36";
const POLL_ID = "call-30daec66-87a5-4d19-b0f1-9698694ea7ba-2";
const SESSION_ID = "root-session";

const layerTest = layerTestProviderHost({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("The scripted Grok runtime must not spawn a process"),
);

const grokSettings = Schema.decodeSync(GrokSettings)({});

type ExtHandler = (params: unknown) => Effect.Effect<void>;

function makeScriptedRuntime(
  script: (emit: {
    readonly sessionUpdate: (
      notification: EffectAcpSchema.SessionNotification,
    ) => Effect.Effect<void>;
    readonly taskCompleted: (update: {
      readonly sessionUpdate: "task_completed";
      readonly will_wake: false;
      readonly task_snapshot: {
        readonly task_id: string;
        readonly output: string;
        readonly exit_code: number;
        readonly kind: "bash";
      };
    }) => Effect.Effect<void>;
  }) => Effect.Effect<void>,
): NonNullable<GrokAdapterV2Options["makeRuntime"]> {
  return () =>
    Effect.sync(() => {
      let onSessionUpdate: (
        notification: EffectAcpSchema.SessionNotification,
      ) => Effect.Effect<void> = () => Effect.void;
      const extHandlers = new Map<string, Array<ExtHandler>>();
      const rememberExt = (method: string, handler: ExtHandler) => {
        const handlers = extHandlers.get(method) ?? [];
        handlers.push(handler);
        extHandlers.set(method, handlers);
      };
      const runtime = {
        start: () =>
          Effect.succeed({
            sessionId: SESSION_ID,
            initializeResult: { protocolVersion: 1 },
            sessionSetupResult: {},
            modelConfigId: undefined,
          }),
        getEvents: () => Stream.empty,
        getConfigOptions: Effect.succeed([]),
        getModeState: Effect.succeed(undefined),
        drainEvents: Effect.void,
        cancel: Effect.void,
        setSessionModel: () => Effect.succeed({}),
        setModel: () => Effect.void,
        setConfigOption: () => Effect.succeed([]),
        setMode: () => Effect.void,
        handleSessionUpdate: (
          handler: (notification: EffectAcpSchema.SessionNotification) => Effect.Effect<void>,
        ) =>
          Effect.sync(() => {
            onSessionUpdate = handler;
          }),
        handleExtNotification: (method: string, _schema: unknown, handler: ExtHandler) =>
          Effect.sync(() => {
            rememberExt(method, handler);
          }),
        handleExtRequest: () => Effect.void,
        handleRequestPermission: () => Effect.void,
        handleElicitation: () => Effect.void,
        prompt: () =>
          script({
            sessionUpdate: (notification) => onSessionUpdate(notification),
            taskCompleted: (update) =>
              Effect.gen(function* () {
                const handlers = extHandlers.get("_x.ai/session/update") ?? [];
                for (const handler of handlers) {
                  yield* handler({ sessionId: SESSION_ID, update });
                }
              }),
          }).pipe(Effect.as({ stopReason: "end_turn" as const })),
      };
      return runtime as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
    });
}

function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly instanceId: ProviderInstanceId;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly now: DateTime.Utc;
}): ProviderAdapterV2TurnInput {
  const suffix = `${input.threadId}:1`;
  const modelSelection = {
    instanceId: input.instanceId,
    model: "default",
  } as const satisfies ModelSelection;
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "Grok background shell",
      providerInstanceId: input.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: input.threadId,
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: "run the schema tests",
      attachments: [],
    },
    modelSelection,
    runtimePolicy: input.runtimePolicy,
  };
}

const shellStart = {
  sessionId: SESSION_ID,
  update: {
    sessionUpdate: "tool_call_update" as const,
    toolCallId: SHELL_ID,
    status: "completed" as const,
    title: "cargo test -p forward --lib",
    kind: "execute" as const,
    rawOutput: {
      type: "BackgroundTaskStarted",
      task_id: SHELL_ID,
      task_type: "bash",
    },
  },
} as EffectAcpSchema.SessionNotification;

const shellReplay = shellStart;

const taskOutput = {
  sessionId: SESSION_ID,
  update: {
    sessionUpdate: "tool_call_update" as const,
    toolCallId: POLL_ID,
    status: "completed" as const,
    title: "get_command_or_subagent_output",
    kind: "other" as const,
    rawOutput: {
      type: "TaskOutput",
      Result: {
        task_id: SHELL_ID,
        status: "failed",
        exit_code: 101,
        output: "error: could not compile `forward`\n",
      },
    },
  },
} as EffectAcpSchema.SessionNotification;

function shellStatuses(events: ReadonlyArray<ProviderAdapterV2Event>): Array<string> {
  return events.flatMap((event) =>
    event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === SHELL_ID
      ? [event.turnItem.status]
      : [],
  );
}

const runScriptedTurn = (input: {
  readonly label: string;
  readonly script: Parameters<typeof makeScriptedRuntime>[0];
}) =>
  Effect.gen(function* () {
    let heldAfterSettle = false;
    const hostPlatform = yield* HostProcessPlatform;
    const instanceId = ProviderInstanceId.make(`grok-bg-${input.label}`);
    const threadId = ThreadId.make(`thread-${input.label}`);
    const continuationOffers: Array<unknown> = [];
    const adapter = yield* makeGrokAdapterV2({
      instanceId,
      settings: grokSettings,
      environment: process.env,
      hostPlatform,
      selfInvocation: yield* resolveSelfInvocation(),
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationOffers.push(request);
          }),
      },
      makeRuntime: makeScriptedRuntime(input.script),
      testHooks: {
        afterPromptSettledWithBackgroundWork: () =>
          Effect.sync(() => {
            heldAfterSettle = true;
          }),
      },
    });
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${input.label}`),
      modelSelection: { instanceId, model: "default" },
      runtimePolicy,
    });
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const seen = yield* Ref.make<Array<ProviderAdapterV2Event>>([]);
    yield* session.events.pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    const waiter = yield* Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(events);
        yield* Ref.update(seen, (current) => [...current, event]);
        if (event.type === "turn.terminal") return event;
      }
    }).pipe(Effect.forkChild);
    const providerThread = yield* session.ensureThread({
      threadId,
      modelSelection: { instanceId, model: "default" },
      runtimePolicy,
    });
    const now = yield* DateTime.now;
    yield* session.startTurn(
      makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now }),
    );
    let finished = yield* Effect.sync(() => waiter.pollUnsafe());
    for (let step = 0; finished === undefined && step < 30; step++) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      finished = yield* Effect.sync(() => waiter.pollUnsafe());
    }
    const collected = yield* Ref.get(seen);
    if (finished === undefined) {
      yield* Fiber.interrupt(waiter);
      return yield* Effect.die(
        `${input.label} did not finish. held=${heldAfterSettle} shell=${shellStatuses(collected).join(",")} types=${collected.map((event) => event.type).join(",")}`,
      );
    }
    const terminal = yield* Fiber.join(waiter);
    expect(terminal.status).toBe("completed");
    expect(shellStatuses(collected).at(-1)).toBe("failed");
    expect(heldAfterSettle).toBe(false);
    const pendingBackgroundWork = yield* session.hasPendingBackgroundWork ?? Effect.succeed(true);
    expect(pendingBackgroundWork).toBe(false);
    expect(continuationOffers).toEqual([]);
  }).pipe(
    Effect.provide(layerTest),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
    Effect.scoped,
  );

it.effect("closes the turn when a Grok 1.0.50 TaskOutput finishes the call-id shell", () =>
  runScriptedTurn({
    label: "task-output",
    script: (emit) =>
      Effect.gen(function* () {
        yield* emit.sessionUpdate(shellStart);
        yield* emit.sessionUpdate(taskOutput);
        // A later copy of the start ACK must not put the finished shell back
        // to in progress. That is what kept deferred finalize holding the turn.
        yield* emit.sessionUpdate(shellReplay);
      }),
  }),
);

it.effect("closes the turn when task_completed arrives before the prompt returns", () =>
  runScriptedTurn({
    label: "task-completed",
    script: (emit) =>
      Effect.gen(function* () {
        yield* emit.sessionUpdate(shellStart);
        yield* emit.taskCompleted({
          sessionUpdate: "task_completed",
          will_wake: false,
          task_snapshot: {
            task_id: SHELL_ID,
            output: "error: could not compile `forward`\n",
            exit_code: 101,
            kind: "bash",
          },
        });
      }),
  }),
);
