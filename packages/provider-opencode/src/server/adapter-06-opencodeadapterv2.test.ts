// @effect-diagnostics-next-line nodeBuiltinImport:off - Exercise HTTP authentication with the real SDK.
import * as NodeHttp from "node:http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient, ToolPart } from "@opencode-ai/sdk/v2";
import {
  CheckpointId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  MessageId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { OpenCodeSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import {
  advanceOpenCodePromptAdmission,
  cancelOpenCodePromptAdmission,
  openCodeBoundaryAfterProviderTurn,
  openCodeChildPermissionRules,
  openCodePermissionRules,
  makeOpenCodeProtocolLogger,
  makeOpenCodeAdapterV2,
  OPENCODE_PROVIDER,
  reconcileOpenCodePromptAdmissionStatus,
} from "./adapter.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeOpenCodeSettings = Schema.decodeEffect(OpenCodeSettings);
const OPEN_CODE_TEST_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  serverUrl: "http://test.invalid",
});

function promiseGate<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function asyncEventStream() {
  const values: Array<{ value: unknown; handled: ReturnType<typeof promiseGate<void>> }> = [];
  const waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  let previousHandled: ReturnType<typeof promiseGate<void>> | undefined;
  let closed = false;
  return {
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
    push(value: unknown) {
      const handled = promiseGate<void>();
      const waiter = waiters.shift();
      if (waiter) {
        previousHandled = handled;
        waiter({ done: false, value });
      } else values.push({ value, handled });
      return handled.promise;
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            previousHandled?.resolve();
            if (closed) return Promise.resolve({ done: true as const, value: undefined });
            const entry = values.shift();
            if (entry !== undefined) {
              previousHandled = entry.handled;
              return Promise.resolve({ done: false as const, value: entry.value });
            }
            return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

const OPENCODE_TEST_SETTINGS = Schema.decodeSync(OpenCodeSettings)({});

function runtimePolicy(
  runtimeMode: ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"],
  override: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy> = {},
): ProviderAdapter.ProviderAdapterV2RuntimePolicy {
  return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
    ...override,
  });
}

function permissionAction(rules: ReturnType<typeof openCodePermissionRules>, permission: string) {
  return rules.findLast((rule) => rule.permission === "*" || rule.permission === permission)
    ?.action;
}

function providerTurn(input: {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId: string | null;
}): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make(input.id),
    providerThreadId: ProviderThreadId.make("provider-thread:opencode-test"),
    nodeId: NodeId.make(`node:${input.id}`),
    runAttemptId: null,
    nativeTurnRef:
      input.nativeId === null
        ? null
        : { driver: OPENCODE_PROVIDER, nativeId: input.nativeId, strength: "weak" },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: null,
    completedAt: null,
  };
}

const makeOpenCodeRuntimeHarness = Effect.fn("makeOpenCodeRuntimeHarness")(function* (
  suffix: string,
  nativeSessionId: string,
  client: object,
  host: Partial<ProviderHost.ProviderHost["Service"]> = {},
  turnSettings: {
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
    readonly interactionMode?: ProviderAdapter.ProviderAdapterV2RuntimePolicy["interactionMode"];
  } = {},
) {
  const instanceId = ProviderInstanceId.make(`opencode-${suffix}`);
  const threadId = ThreadId.make(`thread-opencode-${suffix}`);
  const modelSelection = {
    instanceId,
    model: "anthropic/claude-sonnet",
    options: turnSettings.options ?? [],
  };
  const policy = runtimePolicy("full-access", {
    cwd: "/workspace",
    interactionMode: turnSettings.interactionMode ?? "default",
  });
  const adapter = yield* makeOpenCodeAdapterV2({
    instanceId,
    settings: OPEN_CODE_TEST_SETTINGS,
    environment: {},
  }).pipe(
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
      connectToOpenCodeServer: () => Effect.succeed({ url: "http://test.invalid", external: true }),
      createOpenCodeSdkClient: () => client,
    } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
    Effect.provideService(ProviderHost.ProviderHost, {
      paths: { cwd: "/workspace" },
      resolveAttachmentPath: () => null,
      ...host,
    } as unknown as ProviderHost.ProviderHost["Service"]),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`session-opencode-${suffix}`),
    modelSelection,
    runtimePolicy: policy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy: policy,
  });
  const now = yield* DateTime.now;
  const startTurn = (
    text = "hello",
    startProviderThread: OrchestrationV2ProviderThread = providerThread,
    turnPolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy = policy,
  ) =>
    runtime.startTurn({
      appThread: {
        id: threadId,
        projectId: ProjectId.make(`project-opencode-${suffix}`),
        title: suffix,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: policy.interactionMode,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-opencode-${suffix}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt-opencode-${suffix}`),
      rootNodeId: NodeId.make(`node-opencode-${suffix}`),
      providerThread: startProviderThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-opencode-${suffix}`),
        text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy: turnPolicy,
    });
  return {
    nativeSessionId,
    now,
    policy,
    providerThread,
    runId: RunId.make(`run-opencode-${suffix}`),
    runtime,
    startTurn,
    threadId,
  };
});





describe("OpenCodeAdapterV2", () => {
  it.effect("keeps a newly admitted prompt alive across stale idle and delayed busy evidence", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const prompt = promiseGate<void>();
      const promptStarted = promiseGate<void>();
      const steerPrompt = promiseGate<void>();
      const steerPromptStarted = promiseGate<void>();
      const stopPromptStarted = promiseGate<void>();
      const statusCalled = promiseGate<void>();
      const steerStatusCalled = promiseGate<void>();
      const abortCalled = promiseGate<void>();
      let status: "idle" | "busy" = "busy";
      let promptCalls = 0;
      let statusCalls = 0;
      const promptInputs: Array<{ readonly messageID?: string }> = [];
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: "native-opencode-race", time: { created: 1, updated: 1 } },
          }),
          get: async () => ({
            data: { id: "native-opencode-race", time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (
            input: { readonly messageID?: string },
            options?: { readonly signal?: AbortSignal },
          ) => {
            promptInputs.push(input);
            promptCalls += 1;
            if (promptCalls === 1) {
              promptStarted.resolve();
              await prompt.promise;
            } else if (promptCalls === 2) {
              steerPromptStarted.resolve();
              await steerPrompt.promise;
            } else {
              stopPromptStarted.resolve();
              await new Promise<void>((_resolve, reject) =>
                options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
                  once: true,
                }),
              );
            }
            return { data: true };
          },
          status: async () => ({
            data: (() => {
              statusCalls += 1;
              if (statusCalls === 1) statusCalled.resolve();
              else steerStatusCalled.resolve();
              return { "native-opencode-race": { type: status } };
            })(),
          }),
          messages: async () => ({ data: [] }),
          children: async () => ({ data: [] }),
          abort: async () => {
            abortCalled.resolve();
            return { data: true };
          },
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const adapter = yield* makeOpenCodeAdapterV2({
        instanceId: ProviderInstanceId.make("opencode-test"),
        settings: OPEN_CODE_TEST_SETTINGS,
        environment: {},
      }).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
          connectToOpenCodeServer: () =>
            Effect.succeed({ url: "http://test.invalid", external: true }),
          createOpenCodeSdkClient: () => client,
        } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
        Effect.provideService(ProviderHost.ProviderHost, {
          paths: { cwd: "/workspace" },
          resolveAttachmentPath: () => null,
        } as unknown as ProviderHost.ProviderHost["Service"]),
      );
      const threadId = ThreadId.make("thread-opencode-admission-race");
      const providerSessionId = ProviderSessionId.make("session-opencode-admission-race");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencode-test"),
        model: "anthropic/claude-sonnet",
        options: [],
      };
      const policy = runtimePolicy("full-access", { cwd: "/workspace" });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const now = yield* DateTime.now;
      const attemptId = RunAttemptId.make("attempt-opencode-admission-race");
      const runId = RunId.make("run-opencode-admission-race");
      const start = yield* runtime
        .startTurn({
          appThread: {
            id: threadId,
            projectId: ProjectId.make("project-opencode-admission-race"),
            title: "race",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId,
          rootNodeId: NodeId.make("node-opencode-admission-race"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-opencode-admission-race"),
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy: policy,
        })
        .pipe(Effect.forkScoped);

      yield* Effect.promise(() => promptStarted.promise);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      prompt.resolve();
      yield* Fiber.join(start);
      assert.match(promptInputs[0]?.messageID ?? "", /^msg_[0-9a-f]{12}[0-9A-Za-z]{28}$/);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "busy" } },
        }),
      );
      status = "busy";
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: "stale-user-message",
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );
      assert.equal(statusCalls, 0, "an unrelated user message must not release prompt admission");
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: promptInputs[0]!.messageID!,
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );

      yield* Effect.promise(() => statusCalled.promise);

      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(snapshot.providerTurns.at(-1)?.status, "running");
      const activeTurn = snapshot.providerTurns.at(-1)!;
      const steer = yield* runtime
        .steerTurn({
          threadId,
          runId,
          providerThread,
          providerTurnId: activeTurn.id,
          message: {
            messageId: MessageId.make("message-opencode-steer-race"),
            text: "follow up",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => steerPromptStarted.promise);
      assert.notEqual(promptInputs[1]?.messageID, promptInputs[0]?.messageID);
      steerPrompt.resolve();
      yield* Fiber.join(steer);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "busy" } },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: promptInputs[0]!.messageID!,
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: "native-opencode-race",
            info: {
              id: promptInputs[1]!.messageID!,
              sessionID: "native-opencode-race",
              role: "user",
              time: { created: DateTime.toEpochMillis(now) },
            },
          },
        }),
      );
      yield* Effect.promise(() => steerStatusCalled.promise);
      const pendingSteer = yield* runtime
        .steerTurn({
          threadId,
          runId,
          providerThread,
          providerTurnId: activeTurn.id,
          message: {
            messageId: MessageId.make("message-opencode-stop-pending"),
            text: "pending when stopped",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.promise(() => stopPromptStarted.promise);
      const interrupt = yield* runtime
        .interruptTurn({ providerThread, providerTurnId: activeTurn.id })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => abortCalled.promise);
      yield* Fiber.join(interrupt);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(pendingSteer)));
      const promptWhileStopping = yield* Effect.exit(
        runtime.steerTurn({
          threadId,
          runId,
          providerThread,
          providerTurnId: activeTurn.id,
          message: {
            messageId: MessageId.make("message-opencode-after-stop"),
            text: "must not pass the pending stop",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        }),
      );
      assert.isTrue(Exit.isFailure(promptWhileStopping));
      assert.equal(promptCalls, 3);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: "native-opencode-race", status: { type: "idle" } },
        }),
      );
      const interrupted = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(interrupted.providerTurns.at(-1)?.status, "interrupted");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
});

