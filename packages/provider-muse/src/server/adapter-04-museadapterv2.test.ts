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
});

