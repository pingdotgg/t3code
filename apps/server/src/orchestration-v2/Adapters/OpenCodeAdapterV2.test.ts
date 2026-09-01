import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  NodeId,
  OpenCodeSettings,
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
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { EventNdjsonLogger } from "../../provider/Layers/EventNdjsonLogger.ts";
import type { OpenCodeRuntimeShape } from "../../provider/opencodeRuntime.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";

import {
  advanceOpenCodePromptAdmission,
  cancelOpenCodePromptAdmission,
  openCodeBoundaryAfterProviderTurn,
  openCodeChildPermissionRules,
  openCodePermissionRules,
  openCodePermissionRequestKind,
  openCodeToolProjectionKind,
  makeOpenCodeProtocolLogger,
  makeOpenCodeAdapterV2,
  OPENCODE_PROVIDER,
  OpenCodeProviderCapabilitiesV2,
  reconcileOpenCodePromptAdmissionStatus,
} from "./OpenCodeAdapterV2.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
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
  return {
    close() {
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

const OPENCODE_TEST_SETTINGS = Schema.decodeUnknownSync(OpenCodeSettings)({});

function runtimePolicy(
  runtimeMode: ProviderAdapterV2RuntimePolicy["runtimeMode"],
  override: Partial<ProviderAdapterV2RuntimePolicy> = {},
): ProviderAdapterV2RuntimePolicy {
  return ProviderAdapterV2RuntimePolicy.make({
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
) {
  const idAllocator = yield* IdAllocatorV2;
  const instanceId = ProviderInstanceId.make(`opencode-${suffix}`);
  const threadId = ThreadId.make(`thread-opencode-${suffix}`);
  const modelSelection = {
    instanceId,
    model: "anthropic/claude-sonnet",
    options: [],
  };
  const policy = runtimePolicy("full-access", { cwd: "/workspace" });
  const adapter = makeOpenCodeAdapterV2({
    instanceId,
    settings: OPEN_CODE_TEST_SETTINGS,
    environment: {},
    runtime: {
      connectToOpenCodeServer: () => Effect.succeed({ url: "http://test.invalid", external: true }),
      createOpenCodeSdkClient: () => client,
    } as unknown as OpenCodeRuntimeShape,
    idAllocator,
    serverConfig: {
      cwd: "/workspace",
      attachmentsDir: "/tmp/attachments",
    } as ServerConfig["Service"],
  });
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
  const startTurn = () =>
    runtime.startTurn({
      appThread: {
        id: threadId,
        projectId: ProjectId.make(`project-opencode-${suffix}`),
        title: suffix,
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
      runId: RunId.make(`run-opencode-${suffix}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`attempt-opencode-${suffix}`),
      rootNodeId: NodeId.make(`node-opencode-${suffix}`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-opencode-${suffix}`),
        text: "hello",
        attachments: [],
      },
      modelSelection,
      runtimePolicy: policy,
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
      const idAllocator = yield* IdAllocatorV2;
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
          abort: async () => {
            abortCalled.resolve();
            return { data: true };
          },
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const adapter = makeOpenCodeAdapterV2({
        instanceId: ProviderInstanceId.make("opencode-test"),
        settings: OPEN_CODE_TEST_SETTINGS,
        environment: {},
        runtime: {
          connectToOpenCodeServer: () =>
            Effect.succeed({ url: "http://test.invalid", external: true }),
          createOpenCodeSdkClient: () => client,
        } as unknown as OpenCodeRuntimeShape,
        idAllocator,
        serverConfig: {
          cwd: "/workspace",
          attachmentsDir: "/tmp/attachments",
        } as ServerConfig["Service"],
      });
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
    }).pipe(Effect.provide(idAllocatorLayer), Effect.scoped),
  );

  it.effect("interrupts an initial prompt while its SDK request is pending", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const nativeEvents = asyncEventStream();
      const promptStarted = promiseGate<void>();
      const abortCalled = promiseGate<void>();
      let abortCalls = 0;
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: "native-opencode-initial-stop", time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (_input: unknown, options?: { readonly signal?: AbortSignal }) => {
            promptStarted.resolve();
            await new Promise<void>((_resolve, reject) => {
              const signal = options?.signal;
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
            return { data: true };
          },
          status: async () => ({
            data: { "native-opencode-initial-stop": { type: "idle" as const } },
          }),
          messages: async () => ({ data: [] }),
          abort: async () => {
            abortCalls += 1;
            abortCalled.resolve();
            return { data: true };
          },
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const adapter = makeOpenCodeAdapterV2({
        instanceId: ProviderInstanceId.make("opencode-initial-stop-test"),
        settings: OPEN_CODE_TEST_SETTINGS,
        environment: {},
        runtime: {
          connectToOpenCodeServer: () =>
            Effect.succeed({ url: "http://test.invalid", external: true }),
          createOpenCodeSdkClient: () => client,
        } as unknown as OpenCodeRuntimeShape,
        idAllocator,
        serverConfig: {
          cwd: "/workspace",
          attachmentsDir: "/tmp/attachments",
        } as ServerConfig["Service"],
      });
      const threadId = ThreadId.make("thread-opencode-initial-stop");
      const providerSessionId = ProviderSessionId.make("session-opencode-initial-stop");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencode-initial-stop-test"),
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
      const terminalEvents = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const now = yield* DateTime.now;
      const start = yield* runtime
        .startTurn({
          appThread: {
            id: threadId,
            projectId: ProjectId.make("project-opencode-initial-stop"),
            title: "initial stop",
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
          runId: RunId.make("run-opencode-initial-stop"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-opencode-initial-stop"),
          rootNodeId: NodeId.make("node-opencode-initial-stop"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-opencode-initial-stop"),
            text: "hello",
            attachments: [],
          },
          modelSelection,
          runtimePolicy: policy,
        })
        .pipe(Effect.forkScoped);

      yield* Effect.promise(() => promptStarted.promise);
      const running = yield* runtime.readThreadSnapshot({ providerThread });
      const activeTurn = running.providerTurns.at(-1)!;
      const interrupt = yield* runtime
        .interruptTurn({ providerThread, providerTurnId: activeTurn.id })
        .pipe(Effect.forkScoped);

      yield* Effect.promise(() => abortCalled.promise);
      yield* Fiber.join(start);
      yield* Fiber.join(interrupt);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: {
            sessionID: "native-opencode-initial-stop",
            status: { type: "idle" },
          },
        }),
      );

      const events = Array.from(yield* Fiber.join(terminalEvents));
      const terminals = events.filter((event) => event.type === "turn.terminal");
      assert.equal(abortCalls, 1);
      assert.lengthOf(terminals, 1);
      assert.equal(terminals[0]?.status, "interrupted");
      assert.isNull(terminals[0]?.failure ?? null);
      assert.isFalse(
        events.some(
          (event) =>
            (event.type === "turn.terminal" && event.status === "failed") ||
            (event.type === "provider_session.updated" && event.providerSession.status === "error"),
        ),
      );
    }).pipe(Effect.provide(idAllocatorLayer), Effect.scoped),
  );

  it("holds stale idle through prompt admission until the new user message is observed", () => {
    const admission = {
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: false,
    };

    assert.equal(advanceOpenCodePromptAdmission(admission, "idle"), "hold");
    assert.equal(advanceOpenCodePromptAdmission(admission, "accepted"), "hold");
    assert.isTrue(admission.admissionPending);
    assert.equal(advanceOpenCodePromptAdmission(admission, "user-message"), "reconcile-idle");
    assert.isTrue(admission.admissionPending);
  });

  it("releases admission only after prompt acceptance and new-turn evidence", () => {
    const admission = {
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: false,
    };

    assert.equal(advanceOpenCodePromptAdmission(admission, "busy"), "hold");
    assert.equal(advanceOpenCodePromptAdmission(admission, "accepted"), "release");
    assert.isFalse(admission.admissionPending);
  });

  it("releases admission when an assistant completes under a provider-assigned message id", () => {
    const admission = {
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: true,
    };

    assert.equal(advanceOpenCodePromptAdmission(admission, "assistant-completed"), "release");
    assert.isTrue(admission.admissionAccepted);
    assert.isTrue(admission.admissionMessageObserved);
    assert.isFalse(admission.admissionPending);
  });

  it("invalidates pending admission before aborting a turn", () => {
    const admission = {
      admissionGeneration: 4,
      admissionPending: true,
      admissionAccepted: false,
      admissionMessageObserved: false,
      idleDuringAdmission: false,
    };

    cancelOpenCodePromptAdmission(admission, 5);

    assert.equal(admission.admissionGeneration, 5);
    assert.isFalse(admission.admissionPending);
    assert.equal(advanceOpenCodePromptAdmission(admission, "accepted"), "release");
  });

  it.effect("reconciles current idle and busy status replies after prompt admission", () =>
    Effect.gen(function* () {
      for (const expected of ["idle", "busy"] as const) {
        const admission = { admissionGeneration: 4, admissionPending: true };
        const status = yield* Deferred.make<"idle" | "busy" | "unknown">();
        const fiber = yield* reconcileOpenCodePromptAdmissionStatus(
          admission,
          4,
          Deferred.await(status),
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.succeed(status, expected);

        assert.equal(yield* Fiber.join(fiber), expected);
        assert.isFalse(admission.admissionPending);
      }
    }),
  );

  it.effect("keeps admission pending after a transient status failure", () =>
    Effect.gen(function* () {
      const admission = { admissionGeneration: 4, admissionPending: true };
      assert.equal(
        yield* reconcileOpenCodePromptAdmissionStatus(admission, 4, Effect.succeed("unknown")),
        "unknown",
      );
      assert.isTrue(admission.admissionPending);
      assert.equal(
        yield* reconcileOpenCodePromptAdmissionStatus(admission, 4, Effect.succeed("idle")),
        "idle",
      );
      assert.isFalse(admission.admissionPending);
    }),
  );

  it.effect("retries a transient status failure without another idle event", () =>
    Effect.gen(function* () {
      const nativeSessionId = "native-opencode-status-retry";
      const nativeEvents = asyncEventStream();
      const promptRelease = promiseGate<void>();
      const promptCalls = yield* Queue.unbounded<string>();
      const statusCalls = yield* Queue.unbounded<number>();
      let statusCallCount = 0;
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (input: { readonly messageID?: string }) => {
            Queue.offerUnsafe(promptCalls, input.messageID!);
            await promptRelease.promise;
            return { data: true };
          },
          status: async () => {
            statusCallCount += 1;
            Queue.offerUnsafe(statusCalls, statusCallCount);
            if (statusCallCount === 1) throw new Error("transient status failure");
            return { data: { [nativeSessionId]: { type: "idle" as const } } };
          },
          messages: async () => ({ data: [] }),
          abort: async () => ({ data: true }),
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const harness = yield* makeOpenCodeRuntimeHarness("status-retry", nativeSessionId, client);
      const terminalEvents = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const start = yield* harness.startTurn().pipe(Effect.forkScoped);
      const admissionMessageId = yield* Queue.take(promptCalls);

      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: nativeSessionId, status: { type: "idle" } },
        }),
      );
      promptRelease.resolve();
      yield* Fiber.join(start);
      const userMessage = {
        type: "message.updated",
        properties: {
          sessionID: nativeSessionId,
          info: {
            id: admissionMessageId,
            sessionID: nativeSessionId,
            role: "user",
            time: { created: DateTime.toEpochMillis(harness.now) },
          },
        },
      };
      yield* Effect.promise(() => nativeEvents.push(userMessage));
      assert.equal(yield* Queue.take(statusCalls), 1);

      yield* Effect.promise(() => nativeEvents.push(userMessage));
      assert.equal(statusCallCount, 1, "duplicate events must share the generation's retry worker");
      yield* TestClock.adjust("250 millis");
      assert.equal(yield* Queue.take(statusCalls), 2);

      const events = Array.from(yield* Fiber.join(terminalEvents));
      const terminals = events.filter((event) => event.type === "turn.terminal");
      assert.equal(statusCallCount, 2);
      assert.lengthOf(terminals, 1);
      assert.equal(terminals[0]?.status, "completed");
      assert.isNull(terminals[0]?.failure ?? null);
    }).pipe(Effect.provide(idAllocatorLayer), Effect.scoped),
  );

  it.effect("does not let a queued status retry adopt a newer steer generation", () =>
    Effect.gen(function* () {
      const nativeSessionId = "native-opencode-stale-status-retry";
      const nativeEvents = asyncEventStream();
      const firstPromptRelease = promiseGate<void>();
      const promptCalls = yield* Queue.unbounded<string>();
      const statusCalls = yield* Queue.unbounded<number>();
      let promptCallCount = 0;
      let statusCallCount = 0;
      const client = {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async (input: { readonly messageID?: string }) => {
            promptCallCount += 1;
            Queue.offerUnsafe(promptCalls, input.messageID!);
            if (promptCallCount === 1) {
              await firstPromptRelease.promise;
            }
            return { data: true };
          },
          status: async () => {
            statusCallCount += 1;
            Queue.offerUnsafe(statusCalls, statusCallCount);
            if (statusCallCount === 1) throw new Error("transient status failure");
            return { data: { [nativeSessionId]: { type: "idle" as const } } };
          },
          messages: async () => ({ data: [] }),
          abort: async () => ({ data: true }),
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const harness = yield* makeOpenCodeRuntimeHarness(
        "stale-status-retry",
        nativeSessionId,
        client,
      );
      const start = yield* harness.startTurn().pipe(Effect.forkScoped);
      const firstAdmissionMessageId = yield* Queue.take(promptCalls);

      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.status",
          properties: { sessionID: nativeSessionId, status: { type: "idle" } },
        }),
      );
      firstPromptRelease.resolve();
      yield* Fiber.join(start);
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: nativeSessionId,
            info: {
              id: firstAdmissionMessageId,
              sessionID: nativeSessionId,
              role: "user",
              time: { created: DateTime.toEpochMillis(harness.now) },
            },
          },
        }),
      );
      assert.equal(yield* Queue.take(statusCalls), 1);

      const running = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      const activeTurn = running.providerTurns.at(-1)!;
      yield* harness.runtime.steerTurn({
        threadId: harness.threadId,
        runId: harness.runId,
        providerThread: harness.providerThread,
        providerTurnId: activeTurn.id,
        message: {
          messageId: MessageId.make("message-opencode-stale-status-retry-steer"),
          text: "new generation",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* Queue.take(promptCalls);
      yield* TestClock.adjust("250 millis");

      const afterRetry = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      assert.equal(statusCallCount, 1);
      assert.equal(afterRetry.providerTurns.at(-1)?.status, "running");
    }).pipe(Effect.provide(idAllocatorLayer), Effect.scoped),
  );

  it.effect("ignores a delayed status reply after steering starts a newer admission", () =>
    Effect.gen(function* () {
      const admission = { admissionGeneration: 4, admissionPending: true };
      const status = yield* Deferred.make<"idle" | "busy" | "unknown">();
      const fiber = yield* reconcileOpenCodePromptAdmissionStatus(
        admission,
        4,
        Deferred.await(status),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      admission.admissionGeneration = 5;
      admission.admissionPending = true;
      yield* Deferred.succeed(status, "idle");

      assert.equal(yield* Fiber.join(fiber), "stale");
      assert.equal(admission.admissionGeneration, 5);
      assert.isTrue(admission.admissionPending);
    }),
  );

  it.effect("does not revive admission when abort wins a pending status lookup", () =>
    Effect.gen(function* () {
      const admission = { admissionGeneration: 4, admissionPending: true };
      const status = yield* Deferred.make<"idle" | "busy" | "unknown">();
      const fiber = yield* reconcileOpenCodePromptAdmissionStatus(
        admission,
        4,
        Deferred.await(status),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      cancelOpenCodePromptAdmission(admission, 5);
      yield* Deferred.succeed(status, "idle");

      assert.equal(yield* Fiber.join(fiber), "stale");
      assert.isFalse(admission.admissionPending);
    }),
  );

  it.effect("logs bounded structural protocol diagnostics without native payload values", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const records: Array<unknown> = [];
      const nativeEventLogger: EventNdjsonLogger = {
        filePath: "/tmp/provider-native.ndjson",
        write: (event) => Effect.sync(() => void records.push(event)),
        close: () => Effect.void,
      };
      const logProtocolEvent = makeOpenCodeProtocolLogger({
        nativeEventLogger,
        idAllocator,
        providerInstanceId: ProviderInstanceId.make("opencode-test"),
        providerSessionId: ProviderSessionId.make("provider-session-opencode-test"),
        threadId: ThreadId.make("thread-opencode-test"),
      });
      const secret = "secret-opencode-prompt";

      yield* logProtocolEvent({
        direction: "outgoing",
        messageKind: "request",
        method: "session.prompt",
        payload: { prompt: secret, nested: { token: secret } },
      });

      const serialized = encodeUnknownJson(records);
      assert.notInclude(serialized, secret);
      assert.include(serialized, '"protocol":"opencode-sdk.sse"');
      assert.include(serialized, '"method":"session.prompt"');
      assert.include(serialized, '"fieldCount":2');
    }).pipe(Effect.provide(idAllocatorLayer)),
  );

  it.effect("adopts the handed-over provider thread identity on session create", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const serverConfig = yield* ServerConfig;
      let createCount = 0;
      const fakeClient = {
        event: {
          subscribe: async (_input?: unknown, options?: { readonly signal?: AbortSignal }) => ({
            // Emits nothing and ends when the pump's abort signal fires.
            stream: {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<never>>((resolve) => {
                    const done = () => resolve({ done: true, value: undefined });
                    if (options?.signal?.aborted) return done();
                    options?.signal?.addEventListener("abort", done, { once: true });
                  }),
              }),
            },
          }),
        },
        session: {
          create: async () => {
            createCount += 1;
            return { data: { id: `ses_native_${createCount}`, time: { created: 1, updated: 1 } } };
          },
        },
      } as unknown as OpencodeClient;
      const unused = (operation: string) => () => Effect.die(`${operation} is not used`);
      const runtime: OpenCodeRuntimeShape = {
        startOpenCodeServerProcess: unused("startOpenCodeServerProcess"),
        connectToOpenCodeServer: () =>
          Effect.succeed({
            url: "test://opencode",
            version: "test",
            exitCode: null,
            external: true,
          }),
        runOpenCodeCommand: unused("runOpenCodeCommand"),
        createOpenCodeSdkClient: () => fakeClient,
        loadOpenCodeInventory: unused("loadOpenCodeInventory"),
        loadInventoryFromCli: unused("loadInventoryFromCli"),
      };
      const instanceId = ProviderInstanceId.make("opencode");
      const threadId = ThreadId.make("thread-opencode-adopt");
      const modelSelection = { instanceId, model: "default" };
      const adapter = makeOpenCodeAdapterV2({
        instanceId,
        settings: OPENCODE_TEST_SETTINGS,
        environment: {},
        runtime,
        idAllocator,
        serverConfig,
      });
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-opencode-adopt"),
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
      });
      const now = yield* DateTime.now;
      // The placeholder row the orchestrator creates for a first run: no
      // native identity yet. The adapter must bind the created session to
      // this row instead of minting a second session-keyed row.
      const placeholder: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("thread:provider:opencode:native-thread:pending:run:adopt:1"),
        driver: OPENCODE_PROVIDER,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const adopted = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
        existingProviderThread: placeholder,
      });
      assert.equal(adopted.id, placeholder.id);
      assert.equal(adopted.nativeThreadRef?.nativeId, "ses_native_1");
      // Without a handed-over row the adapter still derives its own id.
      const minted = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: runtimePolicy("full-access"),
      });
      assert.notEqual(minted.id, placeholder.id);
      assert.equal(minted.nativeThreadRef?.nativeId, "ses_native_2");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          idAllocatorLayer,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-opencode-v2-adapter-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );

  it("advertises the identity strengths exposed by the SDK boundary", () => {
    assert.equal(OpenCodeProviderCapabilitiesV2.identity.nativeThreadIds, "strong");
    assert.equal(OpenCodeProviderCapabilitiesV2.identity.nativeTurnIds, "weak");
    assert.equal(OpenCodeProviderCapabilitiesV2.identity.nativeItemIds, "strong");
    assert.equal(OpenCodeProviderCapabilitiesV2.identity.nativeRequestIds, "strong");
    assert.isTrue(OpenCodeProviderCapabilitiesV2.threads.canForkFromTurn);
    assert.isTrue(OpenCodeProviderCapabilitiesV2.turns.supportsActiveSteering);
    assert.equal(OpenCodeProviderCapabilitiesV2.turns.terminalStatusQuality, "strong");
    assert.isFalse(OpenCodeProviderCapabilitiesV2.subagents.canCloseSubagents);
  });

  it("maps native permission families to orchestration request kinds", () => {
    assert.equal(openCodePermissionRequestKind("bash"), "command");
    assert.equal(openCodePermissionRequestKind("read"), "file-read");
    assert.equal(openCodePermissionRequestKind("grep"), "file-read");
    assert.equal(openCodePermissionRequestKind("external_directory"), "file-read");
    assert.equal(openCodePermissionRequestKind("external_directory", "edit"), "file-change");
    assert.equal(openCodePermissionRequestKind("edit"), "file-change");
    assert.equal(openCodePermissionRequestKind("apply_patch"), "file-change");
    assert.equal(openCodePermissionRequestKind("todowrite"), "command");
    assert.equal(openCodePermissionRequestKind("custom", "todowrite"), "command");
  });

  it("maps OpenCode tools to semantic turn-item families", () => {
    assert.equal(openCodeToolProjectionKind("bash"), "command_execution");
    assert.equal(openCodeToolProjectionKind("edit"), "file_change");
    assert.equal(openCodeToolProjectionKind("read"), "file_search");
    assert.equal(openCodeToolProjectionKind("lsp"), "file_search");
    assert.equal(openCodeToolProjectionKind("websearch"), "web_search");
    assert.equal(openCodeToolProjectionKind("codesearch"), "web_search");
    assert.equal(openCodeToolProjectionKind("todowrite"), "dynamic_tool");
    assert.equal(openCodeToolProjectionKind("custom_tool"), "dynamic_tool");
  });

  it("maps runtime modes to safe OpenCode permission rules", () => {
    const approvalRequired = openCodePermissionRules(runtimePolicy("approval-required"));
    assert.equal(permissionAction(approvalRequired, "read"), "allow");
    assert.equal(permissionAction(approvalRequired, "edit"), "ask");
    assert.equal(permissionAction(approvalRequired, "bash"), "ask");
    assert.equal(permissionAction(approvalRequired, "doom_loop"), "ask");
    assert.equal(permissionAction(approvalRequired, "unknown_plugin_tool"), "ask");
    assert.equal(permissionAction(approvalRequired, "question"), "allow");

    const autoAcceptEdits = openCodePermissionRules(runtimePolicy("auto-accept-edits"));
    assert.equal(permissionAction(autoAcceptEdits, "edit"), "allow");
    assert.equal(permissionAction(autoAcceptEdits, "bash"), "ask");

    const fullAccess = openCodePermissionRules(runtimePolicy("full-access"));
    assert.equal(permissionAction(fullAccess, "bash"), "allow");
    assert.equal(permissionAction(fullAccess, "edit"), "allow");

    const granularApproval = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: { granular: { request_permissions: true } },
      }),
    );
    assert.equal(permissionAction(granularApproval, "bash"), "ask");
    assert.equal(permissionAction(granularApproval, "read"), "allow");

    const approvalRequiredWorkspaceWrite = openCodePermissionRules(
      runtimePolicy("approval-required", {
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/opencode-workspace"],
          networkAccess: false,
        },
      }),
    );
    assert.equal(permissionAction(approvalRequiredWorkspaceWrite, "edit"), "ask");
  });

  it("enforces non-interactive sandbox policy through OpenCode permissions", () => {
    const readOnly = openCodePermissionRules(
      runtimePolicy("full-access", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );
    assert.equal(permissionAction(readOnly, "read"), "allow");
    assert.equal(permissionAction(readOnly, "edit"), "deny");
    assert.equal(permissionAction(readOnly, "bash"), "deny");
    assert.equal(permissionAction(readOnly, "webfetch"), "deny");
    assert.equal(permissionAction(readOnly, "doom_loop"), "deny");
    assert.equal(permissionAction(readOnly, "unknown_plugin_tool"), "deny");
    assert.equal(permissionAction(readOnly, "external_directory"), "allow");

    const workspaceWrite = openCodePermissionRules(
      runtimePolicy("auto-accept-edits", {
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/tmp/opencode-workspace"],
          networkAccess: true,
        },
      }),
    );
    assert.equal(permissionAction(workspaceWrite, "edit"), "allow");
    assert.equal(permissionAction(workspaceWrite, "bash"), "deny");
    assert.equal(permissionAction(workspaceWrite, "webfetch"), "allow");
    assert.deepInclude(workspaceWrite, {
      permission: "external_directory",
      pattern: "/tmp/opencode-workspace/*",
      action: "allow",
    });
  });

  it("preserves OpenCode's recursion guard on task-created child sessions", () => {
    const childRules = openCodeChildPermissionRules(runtimePolicy("full-access"), [
      { permission: "task", pattern: "*", action: "deny" },
    ]);

    assert.equal(permissionAction(childRules, "read"), "allow");
    assert.equal(permissionAction(childRules, "bash"), "allow");
    assert.equal(permissionAction(childRules, "task"), "deny");

    const approvalRequiredPolicy = runtimePolicy("approval-required");
    const parentRules = openCodePermissionRules(approvalRequiredPolicy);
    const childApprovalRules = openCodeChildPermissionRules(approvalRequiredPolicy, [
      ...parentRules.filter((rule) => rule.action === "deny"),
      { permission: "task", pattern: "*", action: "deny" },
    ]);
    assert.equal(permissionAction(childApprovalRules, "bash"), "ask");
    assert.equal(permissionAction(childApprovalRules, "task"), "deny");
  });

  it("uses the next native user message as the exclusive fork and revert boundary", () => {
    const first = providerTurn({ id: "turn:first", ordinal: 1, nativeId: "msg-user-1" });
    const synthetic = providerTurn({ id: "turn:synthetic", ordinal: 2, nativeId: null });
    const third = providerTurn({ id: "turn:third", ordinal: 3, nativeId: "msg-user-3" });

    assert.equal(
      openCodeBoundaryAfterProviderTurn([third, first, synthetic], first.id),
      "msg-user-3",
    );
    assert.isUndefined(openCodeBoundaryAfterProviderTurn([first, synthetic, third], third.id));
  });
});
