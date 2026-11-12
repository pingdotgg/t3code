// @effect-diagnostics-next-line nodeBuiltinImport:off -- Mock native realpath to exercise macOS case correction on every platform.
import * as NodeFSP from "node:fs/promises";
import { vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MspError } from "@muse-code/sdk";
import {
  MUSE_DEFAULT_MODEL,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { MuseSettings } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { MuseItem, MuseSubscriptionUsage } from "./protocol.ts";
import type { MuseSdkHost, MuseSdkHostOptions } from "./sdk.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeMuseAdapterV2, type MuseAdapterV2Options } from "./adapter.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const MUSE_PROVIDER = ProviderDriverKind.make("muse");
const INSTANCE_ID = ProviderInstanceId.make("muse_work");
const THREAD_ID = ThreadId.make("thread-muse-test");
const MODEL = "muse-spark-1.3-contributor";
const museSettings = Schema.decodeSync(MuseSettings)({ enabled: true });
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});
const modelSelection = (instanceId = INSTANCE_ID) => ({
  instanceId,
  model: MODEL,
  options: [{ id: "reasoningEffort", value: "max" }],
});

interface NativeCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly commandId?: string;
}

function pendingPromise<A>() {
  let resolve!: (value: A) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<A>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Match the SDK: handler registration returns void.
const makeFakeMuse = Effect.fnUntraced(function* (idPrefix = "native") {
  const requests = yield* Queue.unbounded<NativeCall>();
  const calls: NativeCall[] = [];
  const closed = pendingPromise<void>();
  const exited = pendingPromise<Awaited<MuseSdkHost["exited"]>>();
  let notify: Parameters<MuseSdkHost["connection"]["onNotification"]>[0] = () => {};
  let sequence = 0;
  let sessionId = "";
  const closing = pendingPromise<void>();
  let closeCount = 0;
  let closeGate: Promise<void> | undefined;
  let onProcessExit: MuseSdkHostOptions["onProcessExit"];
  let history: MuseItem[] = [];
  const responses = new Map<
    string,
    Array<Promise<Record<string, unknown>> | Record<string, unknown> | Error>
  >();
  const respond = async (call: NativeCall): Promise<Record<string, unknown>> => {
    calls.push(call);
    Queue.offerUnsafe(requests, call);
    if (["session/start", "session/resume", "session/read"].includes(call.method)) {
      sessionId = String(call.params.sessionId);
    }
    const queued = responses.get(call.method)?.shift();
    if (queued instanceof Error) throw queued;
    if (queued) return queued;
    switch (call.method) {
      case "session/start":
      case "session/resume":
      case "session/read":
        sessionId = String(call.params.sessionId);
        return {
          session: { sessionId, modelId: MODEL, activeTurnId: null },
          history: { items: history },
        };
      case "turn/start":
        return { turnId: call.commandId };
      case "turn/steer":
        return { turnId: call.params.expectedTurnId };
      case "session/compact":
        return { status: "accepted" };
      default:
        return {};
    }
  };
  const host: MuseSdkHost = {
    connection: {
      mintCommandId: () => `${idPrefix}-${++sequence}`,
      command: (method, params, options) =>
        respond({
          method,
          params,
          ...(options?.commandId ? { commandId: options.commandId } : {}),
        }),
      request: (method, params = {}) => respond({ method, params }),
      onNotification: (handler) => {
        notify = handler;
      },
      onProtocolError: () => {},
      onServerRequest: () => {},
      closed: closed.promise,
    },
    initializeResult: { grantedCapabilities: [] },
    exited: exited.promise,
    close: async () => {
      closeCount += 1;
      closing.resolve();
      await closeGate;
      closed.resolve();
      exited.resolve({ code: 0, signal: null });
    },
  };
  return {
    host,
    calls,
    closeCount: () => closeCount,
    closing: closing.promise,
    observeProcessExit: (callback: MuseSdkHostOptions["onProcessExit"]) => {
      onProcessExit = callback;
    },
    exitProcess: () => Effect.sync(() => onProcessExit?.({ code: 1, signal: null })),
    holdClose: (gate: Promise<void>) => {
      closeGate = gate;
    },
    disconnect: () =>
      Effect.sync(() => {
        closed.resolve();
        exited.resolve({ code: 1, signal: null });
      }),
    setHistory: (items: MuseItem[]) => {
      history = items;
    },
    queueResponse: (
      method: string,
      result: Record<string, unknown> | Promise<Record<string, unknown>> | Error,
    ) => {
      responses.set(method, [...(responses.get(method) ?? []), result]);
    },
    emit: (method: string, params: Record<string, unknown>) =>
      Effect.sync(() => {
        notify({ jsonrpc: "2.0", method, params: { sessionId, ...params } });
      }),
    emitHostWide: (method: string, params: Record<string, unknown>) =>
      Effect.sync(() => {
        notify({ jsonrpc: "2.0", method, params });
      }),
    takeCall: Effect.fnUntraced(function* (method: string) {
      while (true) {
        const call = yield* Queue.take(requests);
        if (call.method === method) return call;
      }
    }),
  };
});

const makeHarness = Effect.fnUntraced(function* (
  fake: Effect.Success<ReturnType<typeof makeFakeMuse>>,
  instanceId = INSTANCE_ID,
  initialNativeThreadId?: string,
  replacement?: Effect.Success<ReturnType<typeof makeFakeMuse>>,
  existingProviderThread?: OrchestrationV2ProviderThread,
  policy = runtimePolicy,
  overrides: Pick<
    MuseAdapterV2Options,
    "createHost" | "nativeEventLogger" | "modelCatalog" | "continuationRequests"
  > = {},
) {
  let hostCount = 0;
  const adapter = yield* makeMuseAdapterV2({
    instanceId,
    settings: museSettings,
    environment: { PATH: "/fake/bin" },
    createHost: async (options) => {
      const selected = hostCount++ === 0 ? fake : (replacement ?? fake);
      selected.observeProcessExit(options.onProcessExit);
      return selected.host;
    },
    ...overrides,
  });
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: ProviderSessionId.make(`session-${instanceId}`),
    modelSelection: modelSelection(instanceId),
    runtimePolicy: policy,
    ...(initialNativeThreadId ? { initialNativeThreadId } : {}),
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const allEvents: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const eventsEnded = yield* Deferred.make<Exit.Exit<void, Stream.Error<typeof runtime.events>>>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        allEvents.push(event);
        yield* Queue.offer(emitted, event);
      }),
    ),
    Effect.exit,
    Effect.flatMap((exit) => Deferred.succeed(eventsEnded, exit)),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: modelSelection(instanceId),
    runtimePolicy: policy,
    ...(existingProviderThread ? { existingProviderThread } : {}),
  });
  const takeEvent = Effect.fnUntraced(function* <
    T extends ProviderAdapter.ProviderAdapterV2Event["type"],
  >(
    type: T,
    predicate: (
      event: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>,
    ) => boolean = () => true,
  ) {
    while (true) {
      const event = yield* Queue.take(emitted);
      if (
        event.type === type &&
        predicate(event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>)
      ) {
        return event as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>;
      }
    }
  });
  return { adapter, runtime, providerThread, takeEvent, allEvents, policy, eventsEnded };
});

const preallocatedProviderThread = Effect.fnUntraced(function* () {
  const now = yield* DateTime.now;
  return {
    id: ProviderThreadId.make("preallocated-muse-thread"),
    driver: MUSE_PROVIDER,
    providerInstanceId: INSTANCE_ID,
    providerSessionId: ProviderSessionId.make(`session-${INSTANCE_ID}`),
    appThreadId: THREAD_ID,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  } satisfies OrchestrationV2ProviderThread;
});

const turnInput = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
  runOrdinal = 1,
  policy = runtimePolicy,
): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2TurnInput> {
  const now = yield* DateTime.now;
  const threadId = providerThread.appThreadId ?? THREAD_ID;
  const selection = modelSelection(providerThread.providerInstanceId);
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project-muse-test"),
    title: "Muse test",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: providerThread.providerInstanceId,
    modelSelection: selection,
    runtimeMode: policy.runtimeMode,
    interactionMode: policy.interactionMode,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    appThread,
    threadId,
    runId: RunId.make(`run-${runOrdinal}`),
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`attempt-${runOrdinal}`),
    rootNodeId: NodeId.make(`root-${runOrdinal}`),
    providerThread,
    message: {
      messageId: MessageId.make(`message-${runOrdinal}`),
      text: "Hello Muse",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection,
    runtimePolicy: policy,
  };
});

const startConversation = Effect.fnUntraced(function* (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  fake: Effect.Success<ReturnType<typeof makeFakeMuse>>,
  ordinal = 1,
) {
  yield* harness.runtime.startTurn(
    yield* turnInput(harness.providerThread, ordinal, harness.policy),
  );
  const call = yield* fake.takeCall("turn/start");
  const event = yield* harness.takeEvent(
    "provider_turn.updated",
    (event) => event.providerTurn.status === "running",
  );
  return { nativeId: call.commandId!, providerTurn: event.providerTurn };
});

const SUBSCRIPTION_USAGE = {
  window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: 1791465557000 },
  weekly: { usedPercent: 5, resetsAtMs: 1791763200000 },
  tier: "tier-1",
  observedAtMs: 1791447762610,
} satisfies MuseSubscriptionUsage;
const QUOTA_MESSAGE =
  "API error 429: Subscription quota exhausted. Your usage window resets soon. (rate_limit_error)";
const RELAYED_QUOTA_MESSAGE =
  "API error 429: All credentials for model muse-wonder-1.0-contributor are cooling down (last error: rate_limit_exceeded: Subscription quota exhausted. Your usage window resets at 2026-10-13T10:45:52Z.) (after 10 provider attempts)";

const approval = (turnId: string) => ({
  approvalId: "approval-1",
  turnId,
  currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
  availableChoices: [
    { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
    { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
  ],
  subject: { kind: "shell", command: "touch result.txt" },
});

vi.mock("node:fs/promises", { spy: true });



describe("MuseAdapterV2", () => {
  it.effect("connects the thread's MCP credential on native start and resume", () =>
    Effect.gen(function* () {
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("test-environment"),
        threadId: THREAD_ID,
        providerSessionId: "test-session",
        providerInstanceId: INSTANCE_ID,
        endpoint: "http://127.0.0.1:43210/mcp",
        authorizationHeader: "Bearer thread-scoped-test-token",
        browserToolsAvailable: true,
      });
      for (const nativeId of [undefined, "saved-native-session"]) {
        const fake = yield* makeFakeMuse();
        fake.host.initializeResult.grantedCapabilities.push("sessionMcp");
        yield* makeHarness(fake, INSTANCE_ID, nativeId);
        const call = yield* fake.takeCall(nativeId ? "session/resume" : "session/start");
        assert.deepStrictEqual(call.params.config, {
          mcpServers: {
            "t3-code": {
              transport: "streamableHttp",
              mode: "optional",
              url: "http://127.0.0.1:43210/mcp",
              headers: { Authorization: "Bearer thread-scoped-test-token" },
            },
          },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("selects the runtime mode's permission profile on native start and resume", () =>
    Effect.gen(function* () {
      for (const [runtimeMode, profile, approvalMode] of [
        ["approval-required", ":ask-me", "promptUnmatched"],
        ["full-access", ":unrestricted", "allowAll"],
      ] as const) {
        const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...runtimePolicy,
          runtimeMode,
        });
        const fresh = yield* makeFakeMuse();
        yield* makeHarness(fresh, INSTANCE_ID, undefined, undefined, undefined, policy);
        const started = yield* fresh.takeCall("session/start");
        assert.strictEqual(started.params.permissionProfile, profile);
        assert.strictEqual(started.params.approvalMode, approvalMode);

        const saved = yield* makeFakeMuse();
        yield* makeHarness(saved, INSTANCE_ID, "saved-session", undefined, undefined, policy);
        const resumed = yield* saved.takeCall("session/resume");
        assert.strictEqual(resumed.params.permissionProfile, profile);
        const mode = yield* saved.takeCall("session/setApprovalMode");
        assert.strictEqual(mode.params.mode, approvalMode);
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("rejects a host without session MCP support before opening a native session", () =>
    Effect.gen(function* () {
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("test-environment"),
        threadId: THREAD_ID,
        providerSessionId: "test-session",
        providerInstanceId: INSTANCE_ID,
        endpoint: "http://127.0.0.1:43210/mcp",
        authorizationHeader: "Bearer thread-scoped-test-token",
        browserToolsAvailable: false,
      });
      const fake = yield* makeFakeMuse();
      const outcome = yield* makeHarness(fake).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      assert.isFalse(fake.calls.some((call) => call.method === "session/start"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("retries a missing native session with a cleared ref on the same healthy host", () =>
    Effect.gen(function* () {
      for (const kind of ["sessionNotFound", "notFound"] as const) {
        const fake = yield* makeFakeMuse();
        const allocated = yield* preallocatedProviderThread();
        const adapter = yield* makeMuseAdapterV2({
          instanceId: INSTANCE_ID,
          settings: museSettings,
          environment: { PATH: "/fake/bin" },
          createHost: async () => fake.host,
        });
        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make(`missing-${kind}`),
          modelSelection: modelSelection(),
          runtimePolicy,
          initialNativeThreadId: "missing-session",
        });
        fake.queueResponse(
          "session/resume",
          new MspError({ code: -32000, message: "Saved session is absent", data: { kind } }),
        );
        const failed = yield* runtime
          .ensureThread({
            threadId: THREAD_ID,
            modelSelection: modelSelection(),
            runtimePolicy,
            existingProviderThread: {
              ...allocated,
              nativeThreadRef: {
                driver: MUSE_PROVIDER,
                nativeId: "missing-session",
                strength: "strong",
              },
            },
          })
          .pipe(Effect.exit);
        assert.strictEqual(failed._tag, "Failure");
        assert.strictEqual(fake.closeCount(), 0);
        const fresh = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
          existingProviderThread: allocated,
        });
        assert.strictEqual(fresh.id, allocated.id);
        assert.notStrictEqual(fresh.nativeThreadRef?.nativeId, "missing-session");
        assert.strictEqual(fake.closeCount(), 0);
        yield* runtime.startTurn(yield* turnInput(fresh));
        const admitted = yield* fake.takeCall("turn/start");
        assert.strictEqual(admitted.params.reasoningEffort, "max");
        yield* fake.emit("turn/completed", { turnId: admitted.commandId, terminal: "completed" });
        yield* Stream.runDrain(
          runtime.events.pipe(Stream.takeUntil((event) => event.type === "turn.terminal")),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("rejects cross-instance ensure requests without closing the current valid host", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const rejected = yield* harness.runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
          existingProviderThread: {
            ...harness.providerThread,
            providerInstanceId: ProviderInstanceId.make("other-account"),
          },
        })
        .pipe(Effect.exit);
      assert.strictEqual(rejected._tag, "Failure");
      assert.strictEqual(fake.closeCount(), 0);
      yield* startConversation(harness, fake);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("pins Windows turns to Muse's verbatim root and starts Muse in the plain path", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      let hostCwd: string | undefined;
      const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        ...runtimePolicy,
        cwd: "C:\\work\\repo",
      });
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        policy,
        {
          createHost: async (options) => {
            hostCwd = options.cwd;
            return fake.host;
          },
        },
      );
      yield* startConversation(harness, fake);
      const turnStart = fake.calls.find((call) => call.method === "turn/start");
      // Muse 1.4.3 accepts only verbatim canonical roots.
      assert.deepStrictEqual(turnStart?.params.workspaceRoots, ["\\\\?\\C:\\work\\repo"]);
      // The muse.cmd launcher runs under cmd.exe, which cannot start in a verbatim directory.
      assert.strictEqual(hostCwd, "C:\\work\\repo");
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.scoped,
      Effect.provide(testLayer),
    ),
  );
  it.effect("pins sessions and turns to native canonical case", () =>
    Effect.gen(function* () {
      using _realpath = vi.spyOn(NodeFSP, "realpath").mockResolvedValue("/workspace/eevee");
      const fake = yield* makeFakeMuse();
      const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        ...runtimePolicy,
        cwd: "/workspace/EEVEE",
      });
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        policy,
      );
      yield* startConversation(harness, fake);
      const sessionStart = fake.calls.find((call) => call.method === "session/start");
      const turnStart = fake.calls.find((call) => call.method === "turn/start");
      assert.strictEqual(sessionStart?.params.workspaceRoot, "/workspace/eevee");
      assert.deepStrictEqual(turnStart?.params.workspaceRoots, [
        sessionStart?.params.workspaceRoot,
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(testLayer),
      Effect.provideService(HostProcess.Platform, "darwin"),
    ),
  );
  it.effect("stops at a Meta usage limit until every exhausted window resets", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* fake.emitHostWide("usage/changed", {
        ...SUBSCRIPTION_USAGE,
        window: { ...SUBSCRIPTION_USAGE.window, usedPercent: 103 },
      });
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        reason: QUOTA_MESSAGE,
        error: { kind: "modelError", message: QUOTA_MESSAGE, retryable: false },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "reusable");
      assert.strictEqual(terminal.failure?.class, "usage_limit");
      assert.strictEqual(terminal.failure?.resetAt, "2026-10-08T13:19:17.000Z");
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.title === "Usage limit reached",
        ),
      );

      const next = yield* startConversation(harness, fake, 2);
      yield* fake.emit("turn/completed", {
        turnId: next.nativeId,
        terminal: "failed",
        error: { message: "API error 429: Rate limit exceeded. (rate_limit_error)" },
      });
      const throttled = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(throttled.failure?.class, "provider_error");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

