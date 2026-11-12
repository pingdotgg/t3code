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
  it.effect(
    "settles an active turn and reaps its scope on raw exit before inherited stdio closes",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const pipeClosed = pendingPromise<void>();
        fake.holdClose(pipeClosed.promise);
        const stopped = yield* Deferred.make<void>();
        const units: string[] = [];
        let hostExited = false;
        let connectionClosed = false;
        void fake.host.exited.then(() => {
          hostExited = true;
        });
        void fake.host.connection.closed.then(() => {
          connectionClosed = true;
        });
        yield* Effect.gen(function* () {
          const harness = yield* makeHarness(fake);
          const { nativeId } = yield* startConversation(harness, fake);
          yield* fake.emit("approval/requested", approval(nativeId));
          yield* harness.takeEvent(
            "runtime_request.updated",
            (event) => event.runtimeRequest.status === "pending",
          );
          yield* fake.exitProcess();
          yield* Deferred.await(stopped);
          assert.deepStrictEqual(units, ["t3code-muse-exit.scope"]);
          const terminal = yield* harness.takeEvent("turn.terminal");
          assert.strictEqual(terminal.status, "failed");
          assert.strictEqual(terminal.threadDisposition, "broken");
          assert.isFalse(hostExited);
          assert.isFalse(connectionClosed);
          assert.isTrue(
            harness.allEvents.some(
              (event) =>
                event.type === "runtime_request.updated" &&
                event.runtimeRequest.status === "cancelled",
            ),
          );
          pipeClosed.resolve();
          yield* fake.disconnect();
          yield* Deferred.await(harness.eventsEnded);
          const result = yield* harness.runtime
            .startTurn(yield* turnInput(harness.providerThread, 2))
            .pipe(Effect.exit);
          assert.strictEqual(result._tag, "Failure");
          assert.strictEqual(
            harness.allEvents.filter((event) => event.type === "turn.terminal").length,
            1,
          );
          assert.strictEqual(fake.calls.filter((call) => call.method === "turn/start").length, 1);
        }).pipe(
          Effect.ensuring(Effect.sync(() => pipeClosed.resolve())),
          Effect.scoped,
          Effect.provideService(AgentScope, {
            ...AgentScope.defaultValue(),
            wrap: ({ command, args }) =>
              Effect.succeed({ command, args, unit: "t3code-muse-exit.scope" }),
            stop: (unit) =>
              Effect.gen(function* () {
                units.push(unit);
                yield* Deferred.succeed(stopped, undefined);
              }),
          }),
        );
        assert.deepStrictEqual(units, ["t3code-muse-exit.scope"]);
      }).pipe(Effect.provide(testLayer)),
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
});

