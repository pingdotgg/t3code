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
});

