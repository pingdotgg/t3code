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
  it.effect("rejects steering when stop wins the extracted-text lookup", () =>
    Effect.gen(function* () {
      const events = asyncEventStream();
      const lookup = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let prompts = 0;
      const harness = yield* makeOpenCodeRuntimeHarness(
        "extraction-stop",
        "root",
        {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => events.close(), { once: true });
              return { stream: events.stream };
            },
          },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            get: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            promptAsync: async () => {
              prompts++;
              return { data: true };
            },
            status: async () => ({ data: { root: { type: "busy" } } }),
            messages: async () => ({ data: [] }),
            children: async () => ({ data: [] }),
            abort: async () => ({ data: true }),
          },
          mcp: { add: async () => ({ data: true }) },
        },
        {
          resolveAttachmentPath: () => "/workspace/report.docx",
          resolveExtractedTextPath: () =>
            Deferred.succeed(lookup, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as("/workspace/report.docx.txt"),
            ),
        },
      );
      yield* harness.startTurn();
      const snapshot = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      const turn = snapshot.providerTurns.at(-1)!;
      const steer = yield* harness.runtime
        .steerTurn({
          threadId: harness.threadId,
          runId: harness.runId,
          providerThread: harness.providerThread,
          providerTurnId: turn.id,
          message: {
            messageId: MessageId.make("steer-extraction-stop"),
            text: "read this",
            createdBy: "user",
            creationSource: "web",
            attachments: [
              {
                type: "file",
                id: "report-docx",
                name: "report.docx",
                mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                sizeBytes: 1,
              },
            ],
          },
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(lookup);
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: turn.id,
      });
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(steer)));
      assert.equal(prompts, 1);
      yield* Effect.promise(() =>
        events.push({
          type: "session.status",
          properties: { sessionID: "root", status: { type: "idle" } },
        }),
      );
      const stopped = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      assert.equal(stopped.providerTurns.at(-1)?.status, "interrupted");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
  it.effect("interrupts an initial prompt while its SDK request is pending", () =>
    Effect.gen(function* () {
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
          get: async () => ({
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
          children: async () => ({ data: [] }),
          abort: async () => {
            abortCalls += 1;
            abortCalled.resolve();
            return { data: true };
          },
        },
        mcp: { add: async () => ({ data: true }) },
      };
      const adapter = yield* makeOpenCodeAdapterV2({
        instanceId: ProviderInstanceId.make("opencode-initial-stop-test"),
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
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
  it.effect("fails an active turn when the OpenCode event stream ends cleanly", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const harness = yield* makeOpenCodeRuntimeHarness(
        "clean-event-eof",
        "native-opencode-clean-event-eof",
        {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
              return { stream: nativeEvents.stream };
            },
          },
          session: {
            create: async () => ({
              data: { id: "native-opencode-clean-event-eof", time: { created: 1, updated: 1 } },
            }),
            promptAsync: async () => ({ data: true }),
          },
        },
      );
      yield* harness.startTurn();
      const terminalEvents = yield* harness.runtime.events.pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );

      nativeEvents.close();
      const received = Array.from(yield* Fiber.join(terminalEvents));
      assert.isTrue(
        received.some(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "error",
        ),
      );
      const terminal = received.find((event) => event.type === "turn.terminal");
      assert.equal(terminal?.status, "failed");
      assert.equal(terminal?.failure?.class, "transport_error");
      assert.equal(terminal?.threadDisposition, "broken");
      assert.equal((yield* Effect.exit(harness.startTurn()))._tag, "Failure");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
  it.effect("fails compaction when its response races stream termination", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const summarizeStarted = promiseGate<void>();
      const summarizeResult = promiseGate<{ data: boolean }>();
      const baseClock = yield* Clock.Clock;
      const eofClockRead = yield* Deferred.make<void>();
      const releaseEofClockRead = yield* Deferred.make<void>();
      let blockNextClockRead = false;
      const blockingClock: Clock.Clock = {
        ...baseClock,
        currentTimeMillis: Effect.suspend(() => {
          if (!blockNextClockRead) return baseClock.currentTimeMillis;
          blockNextClockRead = false;
          return Deferred.succeed(eofClockRead, undefined).pipe(
            Effect.andThen(Deferred.await(releaseEofClockRead)),
            Effect.andThen(baseClock.currentTimeMillis),
          );
        }),
      };
      const harness = yield* makeOpenCodeRuntimeHarness(
        "compaction-eof-race",
        "native-opencode-compaction-eof-race",
        {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({
              data: { id: "native-opencode-compaction-eof-race", time: { created: 1, updated: 1 } },
            }),
            summarize: () => {
              summarizeStarted.resolve();
              return summarizeResult.promise;
            },
          },
        },
      ).pipe(Effect.provideService(Clock.Clock, blockingClock));
      const events = yield* harness.runtime.events.pipe(Stream.runCollect, Effect.forkScoped);
      const start = yield* harness.startTurn("/compact").pipe(Effect.forkScoped);
      yield* Effect.promise(() => summarizeStarted.promise);
      blockNextClockRead = true;
      nativeEvents.close();
      yield* Deferred.await(eofClockRead);
      summarizeResult.resolve({ data: true });
      yield* Fiber.join(start);
      yield* Deferred.succeed(releaseEofClockRead, undefined);
      const received = Array.from(yield* Fiber.join(events));
      const terminals = received.filter((event) => event.type === "turn.terminal");
      assert.lengthOf(terminals, 1);
      assert.equal(terminals[0]?.status, "failed");
      assert.equal(terminals[0]?.failure?.class, "transport_error");
      assert.isFalse(
        received.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "compaction" &&
            event.turnItem.status === "completed",
        ),
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
});

