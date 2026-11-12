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
        error: { message: "Provider rejected this turn: api_key=abc123" },
      });
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "failed");
      assert.strictEqual(terminal.threadDisposition, "reusable");
      assert.strictEqual(
        terminal.failure?.message,
        "Provider rejected this turn: api_key=[REDACTED]",
      );
      assert.strictEqual(
        harness.allEvents.findLast((event) => event.type === "provider_session.updated")
          ?.providerSession.lastError,
        terminal.failure?.message,
      );
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
  it.effect.each(["normal", "inherited pipe"] as const)(
    "closes its SDK host exactly once on session teardown with %s shutdown",
    (shutdown) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const pipeClosed = pendingPromise<void>();
        if (shutdown === "inherited pipe") fake.holdClose(pipeClosed.promise);
        let hostExited = false;
        void fake.host.exited.then(() => {
          hostExited = true;
        });
        const stopped: Array<{ unit: string; hostExited: boolean }> = [];
        const release = makeHarness(fake).pipe(
          Effect.scoped,
          Effect.provideService(AgentScope, {
            ...AgentScope.defaultValue(),
            wrap: ({ command, args }) =>
              Effect.succeed({ command, args, unit: "t3code-muse-test.scope" }),
            stop: (unit) =>
              Effect.sync(() => {
                stopped.push({ unit, hostExited });
                pipeClosed.resolve();
              }),
          }),
        );
        if (shutdown === "inherited pipe") {
          yield* Effect.gen(function* () {
            const releasing = yield* release.pipe(Effect.forkChild({ startImmediately: true }));
            yield* Effect.promise(() => fake.closing);
            yield* TestClock.adjust("12999 millis");
            assert.strictEqual(fake.closeCount(), 1);
            assert.deepStrictEqual(stopped, []);
            yield* TestClock.adjust("1 millis");
            assert.deepStrictEqual(
              [...stopped],
              [{ unit: "t3code-muse-test.scope", hostExited: false }],
            );
            yield* Fiber.join(releasing);
          }).pipe(Effect.ensuring(Effect.sync(() => pipeClosed.resolve())));
        } else {
          yield* release;
        }
        assert.strictEqual(fake.closeCount(), 1);
        assert.deepStrictEqual(stopped, [
          { unit: "t3code-muse-test.scope", hostExited: shutdown === "normal" },
        ]);
        yield* Effect.promise(() => fake.host.exited);
        assert.isTrue(hostExited);
      }).pipe(Effect.provide(testLayer)),
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
});

