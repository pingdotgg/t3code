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

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { MuseItem, MuseSubscriptionUsage } from "./protocol.ts";
import type { MuseSdkHost } from "./sdk.ts";
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
  let closeCount = 0;
  let closeGate: Promise<void> | undefined;
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
      await closeGate;
      closed.resolve();
      exited.resolve({ code: 0, signal: null });
    },
  };
  return {
    host,
    calls,
    closeCount: () => closeCount,
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
    createHost: async () => (hostCount++ === 0 ? fake.host : (replacement ?? fake).host),
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

  it.effect("resumes a quota stop at the reset the refusal names", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        reason: RELAYED_QUOTA_MESSAGE,
        error: { kind: "modelError", message: RELAYED_QUOTA_MESSAGE, retryable: true },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.failure?.class, "usage_limit");
      assert.strictEqual(terminal.failure?.resetAt, "2026-10-13T10:45:52.000Z");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("limits a stop Muse types as quota at the reset it reports", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        error: {
          kind: "modelError",
          message: "Model request refused.",
          quota: { limitKind: "tierLimit", resetsAtMs: SUBSCRIPTION_USAGE.window.resetsAtMs },
          retryable: true,
        },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.failure?.class, "usage_limit");
      assert.strictEqual(terminal.failure?.resetAt, "2026-10-08T13:19:17.000Z");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("skips an unreadable usage report without ending the session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* fake.emitHostWide("usage/changed", { window: "not usage" });
      yield* fake.emitHostWide("usage/changed", {
        ...SUBSCRIPTION_USAGE,
        window: { ...SUBSCRIPTION_USAGE.window, usedPercent: 103, resetsAtMs: 1e16 },
      });
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        error: { message: QUOTA_MESSAGE },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.failure?.class, "usage_limit");
      assert.isUndefined(terminal.failure?.resetAt);
      assert.strictEqual(fake.closeCount(), 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("moves a resumed session on another model back to the catalog default", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        "saved-session",
        undefined,
        undefined,
        runtimePolicy,
        {
          modelCatalog: Effect.succeed([
            {
              slug: "account-default",
              name: "Default",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
            { slug: MODEL, name: "Other", isCustom: false, isDefault: false, capabilities: null },
          ]),
        },
      );
      const input = yield* turnInput(harness.providerThread, 1);
      const selection = { ...input.modelSelection, model: MUSE_DEFAULT_MODEL };
      yield* harness.runtime.startTurn({
        ...input,
        modelSelection: selection,
        appThread: { ...input.appThread, modelSelection: selection },
      });
      const setModel = yield* fake.takeCall("session/setModel");
      assert.deepStrictEqual(setModel.params.model, {
        modelId: "account-default",
        providerId: "meta",
      });
      yield* fake.takeCall("turn/start");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("settles partial messages and pending approvals before a provider failure", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("item/started", {
        turnId: nativeId,
        item: {
          itemId: "partial",
          turnId: nativeId,
          kind: "agentMessage",
          status: "inProgress",
          revision: 1,
          text: "Partial answer",
        },
      });
      yield* fake.emit("approval/requested", approval(nativeId));
      yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        error: { message: "Provider rejected this turn" },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "reusable");
      assert.isNotNull(terminal.failure);
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "message.updated" &&
            !event.message.streaming &&
            event.message.text === "Partial answer",
        ),
      );
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
        ),
      );
      yield* startConversation(harness, fake, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "closes a newly opened host when native session registration returns another identity",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        fake.queueResponse("session/start", {
          session: { sessionId: "unexpected-session", modelId: MODEL, activeTurnId: null },
          history: { items: [] },
        });
        const result = yield* makeHarness(fake).pipe(Effect.exit);
        assert.strictEqual(result._tag, "Failure");
        yield* Effect.promise(() => fake.host.exited);
        assert.strictEqual(fake.closeCount(), 1);
        assert.strictEqual(fake.calls.filter((call) => call.method === "turn/start").length, 0);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("settles an active turn once when both the connection and host exit unexpectedly", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const first = yield* startConversation(harness, fake);
      yield* fake.emit("item/started", {
        turnId: first.nativeId,
        item: {
          itemId: "background-child",
          kind: "subagent",
          revision: 1,
          status: "inProgress",
          turnId: first.nativeId,
          subagentId: "subagent-1",
          controlStatus: "running",
          childSessionId: "child-session-1",
          objective: "Finish in the background",
        },
      });
      const child = yield* harness.takeEvent("app_thread.created");
      yield* fake.emit("turn/completed", { turnId: first.nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      const { nativeId } = yield* startConversation(harness, fake, 2);
      yield* fake.emit("approval/requested", approval(nativeId));
      yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      yield* fake.disconnect();
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "broken");
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
        ),
      );
      const streamExit = yield* Deferred.await(harness.eventsEnded);
      assert.strictEqual(streamExit._tag, "Failure");
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.childThreadId === child.appThread.id &&
            event.subagent.status === "failed",
        ),
      );
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "node.updated" &&
            event.node.threadId === child.appThread.id &&
            event.node.kind === "root_turn" &&
            event.node.status === "failed",
        ),
      );
      const result = yield* harness.runtime
        .startTurn(yield* turnInput(harness.providerThread, 3))
        .pipe(Effect.exit);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(
        harness.allEvents.filter(
          (event) => event.type === "turn.terminal" && event.runOrdinal === 2,
        ).length,
        1,
      );
      assert.strictEqual(fake.calls.filter((call) => call.method === "turn/start").length, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("turns a delivery gap into a broken terminal and rejects subsequent work", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* startConversation(harness, fake);
      yield* fake.emit("view/gap", {});
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "broken");
      yield* Effect.promise(() => fake.host.exited);
      assert.strictEqual(fake.closeCount(), 1);
      yield* Deferred.await(harness.eventsEnded);
      const result = yield* harness.runtime
        .startTurn(yield* turnInput(harness.providerThread, 2))
        .pipe(Effect.exit);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(fake.calls.filter((call) => call.method === "turn/start").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("uses the latest native approval requirement and waits for its resolution event", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("approval/requested", approval(nativeId));
      const first = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      yield* fake.emit("approval/updated", {
        ...approval(nativeId),
        currentRequirementId: { approvalId: "approval-1", sourceIndex: 1 },
      });
      const refreshed = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      assert.strictEqual(refreshed.runtimeRequest.id, first.runtimeRequest.id);
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: first.runtimeRequest.id,
        decision: "accept",
      });
      const decision = yield* fake.takeCall("approval/decide");
      assert.deepStrictEqual(decision.params.requirementId, {
        approvalId: "approval-1",
        sourceIndex: 1,
      });
      assert.strictEqual(decision.params.choiceId, "once");
      assert.isFalse(
        harness.allEvents.some(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "resolved",
        ),
      );
      yield* fake.emit("approval/resolved", { approvalId: "approval-1", turnId: nativeId });
      const resolved = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "resolved",
      );
      assert.strictEqual(resolved.runtimeRequest.id, first.runtimeRequest.id);
      const repeated = yield* harness.runtime
        .respondToRuntimeRequest({ requestId: first.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.exit);
      assert.strictEqual(repeated._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the user's decision when Muse settles before acknowledging it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("approval/requested", approval(nativeId));
      const pending = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      const acknowledgement = pendingPromise<Record<string, unknown>>();
      fake.queueResponse("approval/decide", acknowledgement.promise);
      const responding = yield* harness.runtime
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "decline" })
        .pipe(Effect.forkScoped);
      yield* fake.takeCall("approval/decide");
      yield* fake.emit("approval/resolved", {
        approvalId: "approval-1",
        turnId: nativeId,
        decision: "abort",
      });
      const resolved = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "resolved",
      );
      assert.strictEqual(resolved.runtimeRequest.decision, "decline");
      acknowledgement.resolve({});
      yield* Fiber.join(responding);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("lets a user turn take a held Muse report turn, approvals included", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        runtimePolicy,
        { continuationRequests: { offer: (request) => Effect.sync(() => offers.push(request)) } },
      );
      yield* fake.emit("turn/started", { turnId: "report-1" });
      yield* Effect.yieldNow;
      assert.lengthOf(offers, 1);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("approval/requested", approval("report-1"));
      const asked = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "pending",
      );
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: asked.runtimeRequest.id,
        decision: "accept",
      });
      yield* fake.takeCall("approval/decide");
      yield* fake.emit("approval/resolved", { approvalId: "approval-1", turnId: "report-1" });
      yield* fake.emit("turn/completed", { turnId: "report-1", terminal: "completed" });
      yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "completed");
      const dispatched = yield* offers[0]!.dispatchIfCurrent!(Effect.succeed("run"));
      assert.isTrue(Option.isNone(dispatched));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each([
    { when: "after its turn ended", turnEnded: true },
    { when: "while its turn runs", turnEnded: false },
  ] as const)(
    "hides a workflow child's automatic approval $when and retains completed history",
    ({ turnEnded }) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const harness = yield* makeHarness(fake);
        const { nativeId } = yield* startConversation(harness, fake);
        if (turnEnded) {
          yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
          yield* harness.takeEvent("turn.terminal");
        }
        const acknowledgement = pendingPromise<Record<string, unknown>>();
        fake.queueResponse("approval/decide", acknowledgement.promise);
        const child = { ...approval("child-run-1"), subagentOrigin: { subagentId: "a7" } };
        const before = harness.allEvents.length;
        yield* fake.emit("approval/requested", child);
        const decision = yield* fake.takeCall("approval/decide");
        assert.strictEqual(decision.params.choiceId, "once");
        const snapshot = yield* harness.runtime.readThreadSnapshot!({
          providerThread: harness.providerThread,
        });
        assert.deepStrictEqual(snapshot.runtimeRequests, []);
        assert.deepStrictEqual(harness.allEvents.slice(before), []);
        if (!turnEnded) {
          const parent = {
            ...approval(nativeId),
            approvalId: "parent-approval",
            currentRequirementId: { approvalId: "parent-approval", sourceIndex: 0 },
          };
          yield* fake.emit("approval/requested", parent);
          const shown = yield* harness.takeEvent("runtime_request.updated");
          assert.strictEqual(shown.runtimeRequest.status, "pending");
          yield* harness.takeEvent("provider_session.updated");
          yield* fake.emit("approval/resolved", parent);
          // The child remains unacknowledged when the visible request stops blocking the turn.
          const session = yield* harness.takeEvent("provider_session.updated");
          assert.strictEqual(session.providerSession.status, "running");
        }
        yield* fake.emit("approval/resolved", child);
        const resolved = yield* harness.takeEvent("runtime_request.updated");
        assert.strictEqual(resolved.runtimeRequest.status, "resolved");
        assert.strictEqual(resolved.runtimeRequest.decision, "accept");
        assert.isNull(resolved.runtimeRequest.providerTurnId);
        const node = yield* harness.takeEvent("node.updated");
        const item = yield* harness.takeEvent("turn_item.updated");
        assert.strictEqual(node.node.status, "completed");
        assert.strictEqual(item.turnItem.status, "completed");
        acknowledgement.resolve({});
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reveals only the current failed child approval and sends the user's decline", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* startConversation(harness, fake);
      const outdated = pendingPromise<Record<string, unknown>>();
      const current = pendingPromise<Record<string, unknown>>();
      fake.queueResponse("approval/decide", outdated.promise);
      fake.queueResponse("approval/decide", current.promise);
      const child = {
        ...approval("child-run-1"),
        subagentOrigin: {
          subagentId: "a7",
          childRunId: "child-run-1",
          childSessionId: "child-session",
        },
      };
      yield* fake.emit("approval/requested", child);
      yield* fake.takeCall("approval/decide");
      yield* fake.emit("approval/updated", {
        approvalId: child.approvalId,
        availableChoices: child.availableChoices,
        subject: child.subject,
        subagentOrigin: child.subagentOrigin,
        currentRequirementId: { approvalId: "approval-1", sourceIndex: 1 },
      });
      const second = yield* fake.takeCall("approval/decide");
      assert.deepStrictEqual(second.params.requirementId, {
        approvalId: "approval-1",
        sourceIndex: 1,
      });
      outdated.reject(
        new MspError({
          code: -32053,
          message: "Stale requirement",
          data: { kind: "approvalRequirementStale" },
        }),
      );
      current.reject(
        new MspError({
          code: -32052,
          message: "Choice rejected",
          data: { kind: "approvalChoiceInvalid" },
        }),
      );
      const asked = yield* harness.takeEvent("runtime_request.updated");
      assert.strictEqual(asked.runtimeRequest.status, "pending");
      const waiting = yield* harness.takeEvent("provider_session.updated");
      assert.strictEqual(waiting.providerSession.status, "waiting");
      const snapshot = yield* harness.runtime.readThreadSnapshot!({
        providerThread: harness.providerThread,
      });
      assert.deepStrictEqual(snapshot.runtimeRequests, [asked.runtimeRequest]);
      assert.lengthOf(
        harness.allEvents.filter((event) => event.type === "runtime_request.updated"),
        1,
      );
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: asked.runtimeRequest.id,
        decision: "decline",
      });
      const decline = yield* fake.takeCall("approval/decide");
      assert.strictEqual(decline.params.choiceId, "deny");
      assert.deepStrictEqual(decline.params.requirementId, second.params.requirementId);
      yield* fake.emit("approval/resolved", child);
      const resolved = yield* harness.takeEvent("runtime_request.updated");
      assert.strictEqual(resolved.runtimeRequest.decision, "decline");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not resurrect a settled child approval when its automatic answer fails", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* startConversation(harness, fake);
      const acknowledgement = pendingPromise<Record<string, unknown>>();
      fake.queueResponse("approval/decide", acknowledgement.promise);
      const child = { ...approval("child-run-1"), subagentOrigin: { subagentId: "a7" } };
      yield* fake.emit("approval/requested", child);
      yield* fake.takeCall("approval/decide");
      yield* fake.emit("approval/resolved", child);
      const resolved = yield* harness.takeEvent("runtime_request.updated");
      assert.strictEqual(resolved.runtimeRequest.status, "resolved");
      acknowledgement.reject(
        new MspError({
          code: -32051,
          message: "Already resolved",
          data: { kind: "approvalAlreadyResolved" },
        }),
      );
      // A later rejected answer provides an observable milestone after the stale rejection.
      fake.queueResponse("approval/decide", new Error("Choice rejected"));
      yield* fake.emit("approval/requested", {
        ...child,
        approvalId: "approval-2",
        currentRequirementId: { approvalId: "approval-2", sourceIndex: 0 },
      });
      const asked = yield* harness.takeEvent("runtime_request.updated");
      assert.strictEqual(asked.runtimeRequest.nativeRequestRef?.nativeId, "approval-2");
      assert.deepStrictEqual(
        harness.allEvents.flatMap((event) =>
          event.type === "runtime_request.updated" ? [event.runtimeRequest.status] : [],
        ),
        ["resolved", "pending"],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a workflow child's approval pending for the user past the turn's end", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        ...runtimePolicy,
        runtimeMode: "approval-required",
      });
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        undefined,
        undefined,
        undefined,
        policy,
      );
      const { nativeId } = yield* startConversation(harness, fake);
      const childApproval = { ...approval("child-run-1"), subagentOrigin: { subagentId: "a7" } };
      yield* fake.emit("approval/requested", childApproval);
      const asked = yield* harness.takeEvent("runtime_request.updated");
      assert.isNull(asked.runtimeRequest.providerTurnId);
      yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      assert.isFalse(
        harness.allEvents.some(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status !== "pending",
        ),
      );
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: asked.runtimeRequest.id,
        decision: "decline",
      });
      const decision = yield* fake.takeCall("approval/decide");
      assert.strictEqual(decision.params.choiceId, "deny");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("validates structured answers and preserves selected labels with a custom note", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("userInput/requested", {
        userInputId: "question-1",
        turnId: nativeId,
        questions: [
          {
            id: "approach",
            header: "Approach",
            question: "Which approach?",
            options: [{ label: "Small" }, { label: "Large" }],
            selection: { mode: "single" },
          },
        ],
      });
      const pending = yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.kind === "user_input",
      );
      const invalid = yield* harness.runtime
        .respondToRuntimeRequest({
          requestId: pending.runtimeRequest.id,
          answers: { approach: ["Small", "Large"] },
        })
        .pipe(Effect.exit);
      assert.strictEqual(invalid._tag, "Failure");
      assert.isFalse(fake.calls.some((call) => call.method === "userInput/answer"));
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        answers: { approach: ["Small", "Keep tests focused"] },
      });
      const response = yield* fake.takeCall("userInput/answer");
      assert.deepStrictEqual(response.params.answers, [
        { questionId: "approach", selectedLabel: "Small", note: "Keep tests focused" },
      ]);
      yield* fake.emit("userInput/settled", {
        userInputId: "question-1",
        turnId: nativeId,
        answers: response.params.answers,
      });
      yield* harness.takeEvent(
        "runtime_request.updated",
        (event) => event.runtimeRequest.status === "resolved",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("steers only the active native turn and waits for confirmed interruption", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const turn = yield* startConversation(harness, fake);
      const input = yield* turnInput(harness.providerThread);
      const invalid = yield* harness.runtime.steerTurn!({
        threadId: THREAD_ID,
        runId: input.runId,
        providerThread: harness.providerThread,
        providerTurnId: ProviderTurnId.make("unrelated-turn"),
        message: input.message,
      }).pipe(Effect.exit);
      assert.strictEqual(invalid._tag, "Failure");
      assert.isFalse(fake.calls.some((call) => call.method === "turn/steer"));
      yield* harness.runtime.steerTurn!({
        threadId: THREAD_ID,
        runId: input.runId,
        providerThread: harness.providerThread,
        providerTurnId: turn.providerTurn.id,
        message: { ...input.message, text: "Focus on the parser" },
      });
      assert.strictEqual((yield* fake.takeCall("turn/steer")).params.expectedTurnId, turn.nativeId);
      const interrupt = yield* harness.runtime
        .interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: turn.providerTurn.id,
        })
        .pipe(Effect.forkScoped);
      assert.strictEqual((yield* fake.takeCall("turn/interrupt")).params.turnId, turn.nativeId);
      yield* fake.emit("turn/completed", { turnId: turn.nativeId, terminal: "cancelled" });
      yield* Fiber.join(interrupt);
      assert.strictEqual((yield* harness.takeEvent("turn.terminal")).status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resumes the requested native session and reads the same session snapshot", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const nativeItem: MuseItem = {
        itemId: "prior-message",
        turnId: "prior-turn",
        kind: "agentMessage",
        status: "completed",
        revision: 1,
        text: "Previous answer",
      };
      fake.setHistory([nativeItem]);
      const harness = yield* makeHarness(fake, INSTANCE_ID, "saved-session");
      const resumed = yield* fake.takeCall("session/resume");
      assert.strictEqual(resumed.params.sessionId, "saved-session");
      assert.strictEqual(resumed.params.excludeItems, true);
      assert.isFalse(fake.calls.some((call) => call.method === "session/start"));
      assert.strictEqual(harness.providerThread.nativeThreadRef?.nativeId, "saved-session");
      const snapshot = yield* harness.runtime.readThreadSnapshot!({
        providerThread: harness.providerThread,
      });
      assert.strictEqual(snapshot.providerThread.nativeThreadRef?.nativeId, "saved-session");
      assert.deepStrictEqual(snapshot.providerPayload, [nativeItem]);
      assert.strictEqual(snapshot.messages[0]?.text, "Previous answer");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each([
    { resume: true, label: "resumes the saved session" },
    { resume: false, label: "starts a fresh session" },
  ])("completes a turn after an idle host dies and $label", ({ resume }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse("first");
      const recovery = yield* makeFakeMuse("second");
      const harness = yield* makeHarness(fake, INSTANCE_ID, "saved-session", recovery);
      yield* fake.disconnect();
      yield* harness.takeEvent(
        "provider_session.updated",
        (event) => event.providerSession.status === "error",
      );

      const reEnsured = yield* harness.runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
        existingProviderThread: resume
          ? harness.providerThread
          : { ...harness.providerThread, nativeThreadRef: null },
      });
      const registered = yield* recovery.takeCall(resume ? "session/resume" : "session/start");
      assert.strictEqual(registered.params.sessionId, reEnsured.nativeThreadRef?.nativeId);
      assert.strictEqual(reEnsured.id, harness.providerThread.id);
      assert.strictEqual(reEnsured.nativeThreadRef?.nativeId === "saved-session", resume);

      yield* harness.runtime.startTurn(yield* turnInput(reEnsured));
      const started = yield* recovery.takeCall("turn/start");
      yield* recovery.emit("turn/completed", {
        turnId: started.commandId,
        terminal: "completed",
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "completed");
      assert.strictEqual(terminal.providerThreadId, reEnsured.id);
      assert.strictEqual(terminal.threadDisposition, "reusable");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("discards a dead host's pending continuation before relaunching", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse("first");
      const recovery = yield* makeFakeMuse("second");
      const offered =
        yield* Deferred.make<ProviderContinuationRequests.ProviderContinuationRequest>();
      const harness = yield* makeHarness(
        fake,
        INSTANCE_ID,
        "saved-session",
        recovery,
        undefined,
        runtimePolicy,
        { continuationRequests: { offer: (request) => Deferred.succeed(offered, request) } },
      );
      yield* fake.emit("turn/started", { turnId: "dead-host-report" });
      const continuation = yield* Deferred.await(offered);
      assert.isTrue(yield* harness.runtime.hasPendingBackgroundWork!);
      yield* fake.disconnect();
      yield* harness.takeEvent(
        "provider_session.updated",
        (event) => event.providerSession.status === "error",
      );
      assert.isFalse(yield* harness.runtime.hasPendingBackgroundWork!);
      const dispatched = yield* continuation.dispatchIfCurrent!(
        Effect.die("Stale continuation dispatched"),
      );
      assert.isTrue(Option.isNone(dispatched));

      const reEnsured = yield* harness.runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy,
        existingProviderThread: harness.providerThread,
      });
      const input = yield* turnInput(reEnsured);
      yield* harness.runtime.startTurn({
        ...input,
        message: { ...input.message, createdBy: "agent", creationSource: "provider" },
      });
      const running = yield* harness.takeEvent("provider_turn.updated");
      assert.notStrictEqual(running.providerTurn.nativeTurnRef?.nativeId, "dead-host-report");
      assert.strictEqual((yield* harness.takeEvent("turn.terminal")).status, "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("serializes interruption behind pending turn admission without losing the target", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const admission = pendingPromise<Record<string, unknown>>();
      fake.queueResponse("turn/start", admission.promise);
      const starting = yield* harness.runtime
        .startTurn(yield* turnInput(harness.providerThread))
        .pipe(Effect.forkScoped);
      const call = yield* fake.takeCall("turn/start");
      const running = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.status === "running",
      );
      const stopping = yield* harness.runtime
        .interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: running.providerTurn.id,
        })
        .pipe(Effect.forkScoped);
      admission.resolve({ turnId: call.commandId });
      yield* Fiber.join(starting);
      assert.strictEqual((yield* fake.takeCall("turn/interrupt")).params.turnId, call.commandId);
      yield* fake.emit("turn/completed", { turnId: call.commandId, terminal: "cancelled" });
      yield* Fiber.join(stopping);
      assert.strictEqual((yield* harness.takeEvent("turn.terminal")).status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps an intentionally interrupted compaction closed on ensureThread", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const recovery = yield* makeFakeMuse("replacement");
      const harness = yield* makeHarness(fake, INSTANCE_ID, undefined, recovery);
      yield* harness.runtime.compactThread!(yield* turnInput(harness.providerThread));
      const running = yield* harness.takeEvent("provider_turn.updated");
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: running.providerTurn.id,
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "interrupted");
      assert.strictEqual(terminal.threadDisposition, "broken");
      assert.strictEqual((yield* Deferred.await(harness.eventsEnded))._tag, "Success");

      const result = yield* harness.runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection(),
          runtimePolicy,
          existingProviderThread: harness.providerThread,
        })
        .pipe(Effect.exit);
      assert.strictEqual(result._tag, "Failure");
      assert.deepStrictEqual(recovery.calls, []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reports a no-op compaction as a visible failure and permits another turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      fake.queueResponse("session/compact", { status: "noop", reason: "no_compactable_history" });
      yield* harness.runtime.compactThread!(yield* turnInput(harness.providerThread));
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "reusable");
      yield* startConversation(harness, fake, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("projects native todos with stable identity and removes cancelled steps", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("item/completed", {
        turnId: nativeId,
        item: {
          itemId: "todo-tool",
          turnId: nativeId,
          kind: "toolCall",
          tool: "write_todos",
          revision: 1,
          status: "completed",
        },
      });
      yield* fake.emit("item/started", {
        turnId: nativeId,
        item: {
          itemId: "reminder",
          turnId: nativeId,
          kind: "reminderChild",
          revision: 1,
          status: "inProgress",
          fallbackText: "Reminder child session",
        },
      });
      yield* fake.emit("session/todoListChanged", {
        items: [
          { text: " Investigate ", status: "completed" },
          { text: "Fix", status: "inProgress" },
          { text: "Discarded", status: "cancelled" },
          { text: "  ", status: "pending" },
        ],
      });
      const first = yield* harness.takeEvent(
        "turn_item.updated",
        (event) => event.turnItem.type === "todo_list",
      );
      assert.strictEqual(first.turnItem.type, "todo_list");
      if (first.turnItem.type !== "todo_list") return;
      assert.deepStrictEqual(
        first.turnItem.steps.map(({ text, status }) => ({ text, status })),
        [
          { text: "Investigate", status: "completed" },
          { text: "Fix", status: "running" },
        ],
      );
      const planId = first.turnItem.planId;
      yield* fake.emit("session/todoListChanged", {
        items: [
          { text: "Investigate", status: "completed" },
          { text: "Fix", status: "completed" },
        ],
      });
      const next = yield* harness.takeEvent(
        "turn_item.updated",
        (event) => event.turnItem.type === "todo_list",
      );
      assert.strictEqual(next.turnItem.id, first.turnItem.id);
      assert.strictEqual(next.turnItem.nodeId, first.turnItem.nodeId);
      if (next.turnItem.type !== "todo_list") return;
      assert.strictEqual(next.turnItem.planId, first.turnItem.planId);
      assert.isTrue(
        harness.allEvents.some(
          (event) =>
            event.type === "plan.updated" &&
            event.plan.id === planId &&
            event.plan.status === "completed",
        ),
      );
      assert.isFalse(
        harness.allEvents.some(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
        ),
      );
      assert.isTrue((yield* harness.adapter.getCapabilities()).planning.emitsPlanUpdated);
      assert.isTrue((yield* harness.adapter.getCapabilities()).planning.emitsTodoList);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("opens a prompt-and-result child thread for a native subagent", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("item/started", {
        turnId: nativeId,
        item: {
          itemId: "sub-1",
          kind: "subagent",
          revision: 1,
          status: "inProgress",
          turnId: nativeId,
          subagentId: "subagent-1",
          controlStatus: "running",
          childSessionId: "child-session-1",
          objective: "Check the thing",
          role: "general-purpose",
        },
      });
      const created = yield* harness.takeEvent("app_thread.created");
      const childThreadId = created.appThread.id;
      yield* fake.emit("item/updated", {
        turnId: nativeId,
        item: {
          itemId: "sub-1",
          kind: "subagent",
          revision: 2,
          status: "inProgress",
          turnId: nativeId,
          subagentId: "subagent-1",
          controlStatus: "resultReady",
          childSessionId: "child-session-1",
          objective: "Check the thing",
          result: { summary: "All done" },
        },
      });
      const completed = yield* harness.takeEvent(
        "subagent.updated",
        (event) => event.subagent.status === "completed",
      );
      assert.strictEqual(completed.subagent.title, created.appThread.title);
      const result = yield* harness.takeEvent(
        "message.updated",
        (event) => event.message.threadId === childThreadId && event.message.role === "assistant",
      );
      assert.strictEqual(result.message.text, "All done");
      yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a workflow child's first label after later revisions drop it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      const workflowItem = (revision: number, children: unknown) => ({
        itemId: "wf-1",
        kind: "workflow",
        revision,
        status: "inProgress",
        turnId: nativeId,
        entryId: "Probe workflow",
        children,
      });
      yield* fake.emit("item/started", {
        turnId: nativeId,
        item: workflowItem(1, [{ childId: "c1", attempt: 1, status: "scheduled", label: "ping" }]),
      });
      const scheduled = yield* harness.takeEvent("subagent.updated");
      assert.strictEqual(scheduled.subagent.title, "ping");
      yield* fake.emit("item/updated", {
        turnId: nativeId,
        item: workflowItem(2, [{ childId: "c1", attempt: 1, status: "started" }]),
      });
      const started = yield* harness.takeEvent(
        "subagent.updated",
        (event) => event.subagent.status === "running",
      );
      assert.strictEqual(started.subagent.title, "ping");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows a workflow child that completed with a failure kind as failed", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("item/started", {
        turnId: nativeId,
        item: {
          itemId: "wf-1",
          kind: "workflow",
          revision: 1,
          status: "inProgress",
          turnId: nativeId,
          children: [
            {
              childId: "c1",
              attempt: 1,
              status: "finished",
              terminal: "completed",
              failureKind: "budget_exhausted",
            },
          ],
        },
      });
      const child = yield* harness.takeEvent("subagent.updated");
      assert.strictEqual(child.subagent.status, "failed");
      assert.strictEqual(child.subagent.result, "budget_exhausted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
