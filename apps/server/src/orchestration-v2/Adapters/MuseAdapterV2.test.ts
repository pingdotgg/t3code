import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  MessageId,
  MuseSettings,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import type { MuseItem } from "../../provider/museProtocol.ts";
import type { MuseSdkHost } from "../../provider/museSdk.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { makeMuseAdapterV2, MUSE_PROVIDER } from "./MuseAdapterV2.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-muse-v2-adapter-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const INSTANCE_ID = ProviderInstanceId.make("muse_work");
const THREAD_ID = ThreadId.make("thread-muse-test");
const MODEL = "muse-spark-1.3-contributor";
const museSettings = Schema.decodeSync(MuseSettings)({ enabled: true });
const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
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
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** SDK-shaped transport fake: registration deliberately returns void, as the SDK does. */
const makeFakeMuse = Effect.fnUntraced(function* (idPrefix = "native") {
  const requests = yield* Queue.unbounded<NativeCall>();
  const calls: NativeCall[] = [];
  const closed = pendingPromise<void>();
  const exited = pendingPromise<Awaited<MuseSdkHost["exited"]>>();
  let notify: Parameters<MuseSdkHost["connection"]["onNotification"]>[0] = () => {};
  let sequence = 0;
  let sessionId = "";
  let closeCount = 0;
  let history: MuseItem[] = [];
  const responses = new Map<
    string,
    Array<Promise<Record<string, unknown>> | Record<string, unknown>>
  >();
  const respond = async (call: NativeCall): Promise<Record<string, unknown>> => {
    calls.push(call);
    Queue.offerUnsafe(requests, call);
    if (["session/start", "session/resume", "session/read"].includes(call.method)) {
      sessionId = String(call.params.sessionId);
    }
    const queued = responses.get(call.method)?.shift();
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
      case "view/page":
        return { events: [], nextCursor: null };
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
    initializeResult: {
      experimentalApi: false,
      grantedCapabilities: [],
      museHome: "/fake/muse",
      platformFamily: "unix",
      platformOs: "linux",
      schema: { version: 1, fingerprint: "test" },
      serverInfo: { name: "muse", version: "test" },
      userAgent: "test",
    },
    exited: exited.promise,
    close: async () => {
      closeCount += 1;
      closed.resolve();
      exited.resolve({ code: 0, signal: null });
    },
  };
  return {
    host,
    calls,
    closeCount: () => closeCount,
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
      result: Record<string, unknown> | Promise<Record<string, unknown>>,
    ) => {
      responses.set(method, [...(responses.get(method) ?? []), result]);
    },
    emit: (method: string, params: Record<string, unknown>) =>
      Effect.sync(() => {
        notify({ jsonrpc: "2.0", method, params: { sessionId, ...params } });
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
) {
  let hostCount = 0;
  const adapter = makeMuseAdapterV2({
    instanceId,
    settings: museSettings,
    environment: { PATH: "/fake/bin" },
    idAllocator: yield* IdAllocatorV2,
    serverConfig: yield* ServerConfig,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    createHost: async () => (hostCount++ === 0 ? fake.host : (replacement ?? fake).host),
  });
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: ProviderSessionId.make(`session-${instanceId}`),
    modelSelection: modelSelection(instanceId),
    runtimePolicy: policy,
    ...(initialNativeThreadId ? { initialNativeThreadId } : {}),
  });
  const emitted = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const allEvents: ProviderAdapterV2Event[] = [];
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        allEvents.push(event);
        yield* Queue.offer(emitted, event);
      }),
    ),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: modelSelection(instanceId),
    runtimePolicy: policy,
    ...(existingProviderThread ? { existingProviderThread } : {}),
  });
  const takeEvent = Effect.fnUntraced(function* <T extends ProviderAdapterV2Event["type"]>(
    type: T,
    predicate: (event: Extract<ProviderAdapterV2Event, { type: T }>) => boolean = () => true,
  ) {
    while (true) {
      const event = yield* Queue.take(emitted);
      if (event.type === type && predicate(event as Extract<ProviderAdapterV2Event, { type: T }>)) {
        return event as Extract<ProviderAdapterV2Event, { type: T }>;
      }
    }
  });
  return { adapter, runtime, providerThread, takeEvent, allEvents, policy };
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
): Effect.fn.Return<ProviderAdapterV2TurnInput> {
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
  it.effect("attaches a native session to the orchestrator's preallocated provider thread", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const allocated = yield* preallocatedProviderThread();
      const harness = yield* makeHarness(fake, INSTANCE_ID, undefined, undefined, allocated);
      const started = yield* fake.takeCall("session/start");
      assert.strictEqual(harness.providerThread.id, allocated.id);
      assert.strictEqual(
        harness.providerThread.nativeThreadRef?.nativeId,
        started.params.sessionId,
      );
      assert.strictEqual(harness.providerThread.nativeThreadRef?.strength, "strong");
      const turn = yield* startConversation(harness, fake);
      assert.strictEqual(turn.providerTurn.providerThreadId, allocated.id);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "starts fresh after recovery clears a native ref instead of reusing the startup hint",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const cleared = yield* preallocatedProviderThread();
        const harness = yield* makeHarness(
          fake,
          INSTANCE_ID,
          "failed-old-session",
          undefined,
          cleared,
        );
        const started = yield* fake.takeCall("session/start");
        assert.isFalse(fake.calls.some((call) => call.method === "session/resume"));
        assert.notStrictEqual(started.params.sessionId, "failed-old-session");
        assert.strictEqual(harness.providerThread.id, cleared.id);
        yield* startConversation(harness, fake);
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

  it.effect("streams one conversation with stable message identity and a terminal outcome", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* harness.runtime.startTurn(yield* turnInput(harness.providerThread));
      const start = yield* fake.takeCall("turn/start");
      assert.strictEqual(start.params.reasoningEffort, "max");
      const turnId = start.commandId!;
      const item = {
        itemId: "assistant-1",
        turnId,
        kind: "agentMessage",
        revision: 1,
        status: "inProgress",
        text: "Hello",
      };
      yield* fake.emit("item/started", { turnId, item });
      const first = yield* harness.takeEvent("message.updated");
      assert.strictEqual(first.message.streaming, true);
      yield* fake.emit("item/delta", { turnId, itemId: item.itemId, delta: " world" });
      yield* fake.emit("item/completed", {
        turnId,
        item: { ...item, revision: 2, status: "completed", text: "Hello world" },
      });
      yield* fake.emit("turn/completed", { turnId, terminal: "completed" });
      const final = yield* harness.takeEvent(
        "message.updated",
        (event) => !event.message.streaming,
      );
      assert.strictEqual(final.message.id, first.message.id);
      assert.strictEqual(final.message.text, "Hello world");
      const terminal = yield* harness.takeEvent("turn.terminal");
      assert.strictEqual(terminal.status, "completed");
      assert.strictEqual(terminal.failure, null);
      assert.strictEqual(terminal.threadDisposition, "reusable");
      assert.strictEqual(terminal.driver, MUSE_PROVIDER);
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

  it.effect("preserves a native child's neutral activity through completion after its parent", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      const child = {
        itemId: "native-child",
        kind: "subagent",
        turnId: nativeId,
        subagentId: "reviewer",
        childSessionId: "child-session",
        objective: "Review patch",
        revision: 1,
        status: "inProgress",
      };
      yield* fake.emit("item/started", { item: child });
      const started = yield* harness.takeEvent(
        "turn_item.updated",
        (event) => event.turnItem.nativeItemRef?.nativeId === child.itemId,
      );
      assert.strictEqual(started.turnItem.type, "dynamic_tool");
      assert.strictEqual(started.turnItem.status, "running");
      assert.strictEqual(started.turnItem.ordinal, 101);
      yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      const parentTerminalIndex = harness.allEvents.length;
      yield* fake.emit("item/completed", {
        item: {
          ...child,
          revision: 2,
          status: "completed",
          result: { summary: "No issues found" },
        },
      });
      const completed = yield* harness.takeEvent(
        "turn_item.updated",
        (event) =>
          event.turnItem.nativeItemRef?.nativeId === child.itemId &&
          event.turnItem.status === "completed",
      );
      assert.strictEqual(completed.turnItem.id, started.turnItem.id);
      assert.strictEqual(completed.turnItem.nodeId, started.turnItem.nodeId);
      assert.strictEqual(completed.turnItem.ordinal, started.turnItem.ordinal);
      assert.strictEqual(completed.turnItem.type, "dynamic_tool");
      if (completed.turnItem.type !== "dynamic_tool") return;
      assert.strictEqual(completed.turnItem.output, "No issues found");
      assert.isFalse(harness.allEvents.some((event) => event.type === "subagent.updated"));
      assert.isFalse(
        harness.allEvents
          .slice(parentTerminalIndex)
          .some(
            (event) => event.type === "provider_turn.updated" || event.type === "turn.terminal",
          ),
      );
      assert.strictEqual(fake.calls.filter((call) => call.method === "turn/start").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("closes its SDK host exactly once when its session scope ends", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      yield* makeHarness(fake).pipe(Effect.scoped);
      assert.strictEqual(fake.closeCount(), 1);
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
        assert.strictEqual(fake.closeCount(), 1);
        assert.strictEqual(fake.calls.filter((call) => call.method === "turn/start").length, 0);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("settles an active turn once when both the connection and host exit unexpectedly", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
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
      const result = yield* harness.runtime
        .startTurn(yield* turnInput(harness.providerThread, 2))
        .pipe(Effect.exit);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(
        harness.allEvents.filter((event) => event.type === "turn.terminal").length,
        1,
      );
      assert.strictEqual(fake.calls.filter((call) => call.method === "turn/start").length, 1);
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
      assert.strictEqual(fake.closeCount(), 1);
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

  it.effect("does not reopen settled requests or introduce approvals from late updates", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      const nativeApproval = approval(nativeId);
      const question = {
        userInputId: "settled-question",
        turnId: nativeId,
        questions: [
          {
            id: "answer",
            header: "Answer",
            question: "Continue?",
            options: [{ label: "Yes" }],
            selection: { mode: "single" },
          },
        ],
      };
      yield* fake.emit("approval/requested", nativeApproval);
      yield* fake.emit("approval/resolved", {
        approvalId: nativeApproval.approvalId,
        turnId: nativeId,
      });
      yield* fake.emit("userInput/requested", question);
      yield* fake.emit("userInput/settled", {
        userInputId: question.userInputId,
        turnId: nativeId,
        answers: [{ questionId: "answer", selectedLabel: "Yes" }],
      });
      yield* fake.emit("approval/updated", nativeApproval);
      yield* fake.emit("approval/requested", nativeApproval);
      yield* fake.emit("userInput/requested", question);
      yield* fake.emit("approval/updated", {
        ...nativeApproval,
        approvalId: "never-requested",
        currentRequirementId: { approvalId: "never-requested", sourceIndex: 0 },
      });
      yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      const requests = harness.allEvents.filter(
        (event) => event.type === "runtime_request.updated",
      );
      assert.strictEqual(
        requests.filter((event) => event.runtimeRequest.status === "pending").length,
        2,
      );
      assert.strictEqual(
        requests.filter((event) => event.runtimeRequest.status === "resolved").length,
        2,
      );
      assert.isFalse(requests.some((event) => event.runtimeRequest.status === "cancelled"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "automatically accepts only unprotected in-workspace edits in the edit permission mode",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const policy = ProviderAdapterV2RuntimePolicy.make({
          ...runtimePolicy,
          runtimeMode: "auto-accept-edits",
          cwd: "/workspace",
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
        const edit = {
          ...approval(nativeId),
          protectedWrite: false,
          judgeEscalated: false,
          subject: { kind: "fileAccess", access: "write", path: "src/result.ts" },
        };
        yield* fake.emit("approval/requested", edit);
        const accepted = yield* fake.takeCall("approval/decide");
        assert.strictEqual(accepted.params.choiceId, "once");
        yield* fake.emit("approval/resolved", { approvalId: edit.approvalId, turnId: nativeId });
        yield* fake.emit("approval/updated", edit);
        for (const [approvalId, detail] of [
          ["protected", { protectedWrite: true }],
          ["outside", { subject: { kind: "fileAccess", access: "write", path: "../outside.ts" } }],
          ["escalated", { judgeEscalated: true }],
        ] as const) {
          yield* fake.emit("approval/requested", {
            ...edit,
            ...detail,
            approvalId,
            currentRequirementId: { approvalId, sourceIndex: 0 },
          });
          const pending = yield* harness.takeEvent(
            "runtime_request.updated",
            (event) => event.runtimeRequest.status === "pending",
          );
          assert.strictEqual(pending.runtimeRequest.nativeRequestRef?.nativeId, approvalId);
        }
        assert.strictEqual(
          fake.calls.filter((call) => call.method === "approval/decide").length,
          1,
        );
        assert.strictEqual(
          harness.allEvents.filter(
            (event) =>
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.nativeRequestRef?.nativeId === edit.approvalId,
          ).length,
          0,
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

  it.effect("keeps native identities distinct across configured instances", () =>
    Effect.gen(function* () {
      const firstFake = yield* makeFakeMuse();
      const secondFake = yield* makeFakeMuse();
      const first = yield* makeHarness(firstFake, ProviderInstanceId.make("muse_first"));
      const second = yield* makeHarness(secondFake, ProviderInstanceId.make("muse_second"));
      const a = yield* startConversation(first, firstFake);
      const b = yield* startConversation(second, secondFake);
      assert.strictEqual(a.nativeId, b.nativeId);
      assert.notStrictEqual(first.providerThread.id, second.providerThread.id);
      assert.notStrictEqual(a.providerTurn.id, b.providerTurn.id);
      for (const fake of [firstFake, secondFake]) {
        yield* fake.emit("item/completed", {
          turnId: a.nativeId,
          item: {
            itemId: "shared-native-item",
            turnId: a.nativeId,
            kind: "agentMessage",
            status: "completed",
            revision: 1,
            text: "Instance-owned answer",
          },
        });
      }
      const firstMessage = yield* first.takeEvent("message.updated");
      const secondMessage = yield* second.takeEvent("message.updated");
      assert.notStrictEqual(firstMessage.message.id, secondMessage.message.id);
      const crossInstance = yield* first.runtime.readThreadSnapshot!({
        providerThread: second.providerThread,
      }).pipe(Effect.exit);
      assert.strictEqual(crossInstance._tag, "Failure");
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
      assert.strictEqual(
        (yield* fake.takeCall("session/resume")).params.sessionId,
        "saved-session",
      );
      assert.isFalse(fake.calls.some((call) => call.method === "session/start"));
      assert.strictEqual(harness.providerThread.nativeThreadRef?.nativeId, "saved-session");
      const snapshot = yield* harness.runtime.readThreadSnapshot!({
        providerThread: harness.providerThread,
      });
      assert.strictEqual(snapshot.providerThread.nativeThreadRef?.nativeId, "saved-session");
      assert.deepStrictEqual(snapshot.providerPayload, [nativeItem]);
      assert.strictEqual(snapshot.messages[0]?.text, "Previous answer");
      assert.strictEqual(snapshot.providerTurns[0]?.nativeTurnRef?.nativeId, "prior-turn");
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

  it.effect(
    "waits for the native compaction item instead of treating admission as completion",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const harness = yield* makeHarness(fake);
        yield* harness.runtime.compactThread!(yield* turnInput(harness.providerThread));
        yield* fake.takeCall("session/compact");
        assert.isFalse(fake.calls.some((call) => call.method === "turn/start"));
        assert.isFalse(harness.allEvents.some((event) => event.type === "turn.terminal"));
        yield* fake.emit("item/completed", {
          item: {
            itemId: "compaction-1",
            kind: "compaction",
            revision: 1,
            status: "completed",
            outcome: "compacted",
            text: "Preserved the parser decisions",
          },
        });
        const item = yield* harness.takeEvent(
          "turn_item.updated",
          (event) => event.turnItem.type === "compaction",
        );
        assert.strictEqual(item.turnItem.type, "compaction");
        assert.strictEqual((yield* harness.takeEvent("turn.terminal")).status, "completed");
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

  it.effect("keeps context window usage authoritative after turn completion and resume", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake, INSTANCE_ID, "saved-session");
      yield* fake.emit("session/contextUsage", { usedTokens: 1200, windowTokens: 32000 });
      const resumed = yield* harness.takeEvent(
        "provider_thread.updated",
        (event) => event.providerThread.contextUsage?.usedTokens === 1200,
      );
      assert.strictEqual(resumed.providerThread.contextUsage?.maxTokens, 32000);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("session/tokenUsage", {
        turnId: nativeId,
        promptTokens: 900,
        usage: { inputTokens: 800, outputTokens: 100, cachedTokens: 0, reasoningTokens: 0 },
      });
      yield* fake.emit("session/contextUsage", { usedTokens: 1400, windowTokens: 32000 });
      yield* fake.emit("turn/completed", { turnId: nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      yield* fake.emit("session/contextUsage", { usedTokens: 600, windowTokens: 32000 });
      const reduced = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.tokenUsage?.usedTokens === 600,
      );
      assert.strictEqual(reduced.providerTurn.tokenUsage?.maxTokens, 32000);
      assert.strictEqual(reduced.providerTurn.turnTokenUsage?.inputTokens, 900);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not use counted prompt tokens as an invented context window measurement", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      yield* fake.emit("session/tokenUsage", {
        turnId: nativeId,
        promptTokens: 900,
        usage: { inputTokens: 800, outputTokens: 100, cachedTokens: 20, reasoningTokens: 10 },
      });
      const counted = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.turnTokenUsage !== undefined,
      );
      assert.isUndefined(counted.providerTurn.tokenUsage);
      assert.strictEqual(counted.providerTurn.turnTokenUsage?.inputTokens, 900);
      assert.strictEqual(counted.providerTurn.turnTokenUsage?.cachedInputTokens, 20);
      assert.strictEqual(counted.providerTurn.turnTokenUsage?.reasoningTokens, 10);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "accumulates partial counted usage and applies native final totals without inventing context",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const harness = yield* makeHarness(fake);
        const { nativeId } = yield* startConversation(harness, fake);
        yield* fake.emit("session/tokenUsage", {
          turnId: nativeId,
          promptTokens: 150,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cachedTokens: 50,
            cacheReadTokens: 30,
            cacheWriteTokens: 20,
            reasoningTokens: 10,
          },
        });
        yield* fake.emit("session/tokenUsage", {
          turnId: nativeId,
          promptTokens: 250,
          usage: { inputTokens: 200, outputTokens: 30, cachedTokens: 50, reasoningTokens: 5 },
        });
        const partial = yield* harness.takeEvent(
          "provider_turn.updated",
          (event) => event.providerTurn.turnTokenUsage?.inputTokens === 400,
        );
        assert.deepStrictEqual(partial.providerTurn.turnTokenUsage, {
          usageScope: "main_agent",
          usageStatus: "partial",
          hasSubagents: false,
          inputTokens: 400,
          outputTokens: 50,
          cachedInputTokens: 80,
          cacheCreationTokens: 20,
          reasoningTokens: 15,
        });
        assert.isUndefined(partial.providerTurn.tokenUsage);
        yield* fake.emit("turn/completed", {
          turnId: nativeId,
          terminal: "completed",
          usage: {
            inputTokens: 300,
            outputTokens: 75,
            cachedTokens: 120,
            cacheReadTokens: 100,
            cacheWriteTokens: 25,
            reasoningTokens: 16,
          },
        });
        const completed = yield* harness.takeEvent(
          "provider_turn.updated",
          (event) => event.providerTurn.status === "completed",
        );
        assert.deepStrictEqual(completed.providerTurn.turnTokenUsage, {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 400,
          outputTokens: 75,
          cachedInputTokens: 100,
          cacheCreationTokens: 25,
          reasoningTokens: 16,
        });
        assert.isUndefined(completed.providerTurn.tokenUsage);
        yield* harness.takeEvent("turn.terminal");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("projects native todos with stable identity and removes cancelled steps", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      yield* startConversation(harness, fake);
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
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("preserves the committed conversation head across a weak compaction turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const first = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", { turnId: first.nativeId, terminal: "completed" });
      const committed = yield* harness.takeEvent(
        "provider_thread.updated",
        (event) => event.providerThread.nativeConversationHeadRef?.nativeId === first.nativeId,
      );
      yield* harness.takeEvent("turn.terminal");
      yield* harness.runtime.compactThread!(yield* turnInput(committed.providerThread, 2));
      const compactCall = yield* fake.takeCall("session/compact");
      const compactTurn = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.nativeTurnRef?.nativeId === compactCall.commandId,
      );
      assert.strictEqual(compactTurn.providerTurn.nativeTurnRef?.strength, "weak");
      yield* fake.emit("item/completed", {
        item: {
          itemId: "compaction-head",
          kind: "compaction",
          revision: 1,
          status: "completed",
          outcome: "compacted",
        },
      });
      const settled = yield* harness.takeEvent(
        "provider_thread.updated",
        (event) => event.providerThread.status === "idle",
      );
      assert.deepStrictEqual(
        settled.providerThread.nativeConversationHeadRef,
        committed.providerThread.nativeConversationHeadRef,
      );
      assert.strictEqual((yield* harness.takeEvent("turn.terminal")).status, "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("preserves the committed head when later turns fail or are cancelled", () =>
    Effect.gen(function* () {
      for (const outcome of ["failed", "cancelled"] as const) {
        const fake = yield* makeFakeMuse();
        const harness = yield* makeHarness(fake);
        const first = yield* startConversation(harness, fake);
        yield* fake.emit("turn/completed", { turnId: first.nativeId, terminal: "completed" });
        const committed = yield* harness.takeEvent(
          "provider_thread.updated",
          (event) => event.providerThread.nativeConversationHeadRef?.nativeId === first.nativeId,
        );
        yield* harness.takeEvent("turn.terminal");
        yield* harness.runtime.startTurn(yield* turnInput(committed.providerThread, 2));
        const next = yield* fake.takeCall("turn/start");
        yield* fake.emit("turn/completed", { turnId: next.commandId, terminal: outcome });
        const settled = yield* harness.takeEvent(
          "provider_thread.updated",
          (event) => event.providerThread.status === "idle",
        );
        assert.deepStrictEqual(
          settled.providerThread.nativeConversationHeadRef,
          committed.providerThread.nativeConversationHeadRef,
        );
        assert.strictEqual((yield* harness.takeEvent("turn.terminal")).status, outcome);
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails completed compaction items whose native outcome is failed or noop", () =>
    Effect.gen(function* () {
      for (const outcome of ["failed", "noop"] as const) {
        const fake = yield* makeFakeMuse();
        const harness = yield* makeHarness(fake);
        yield* harness.runtime.compactThread!(yield* turnInput(harness.providerThread));
        yield* fake.takeCall("session/compact");
        yield* fake.emit("item/completed", {
          item: {
            itemId: `compaction-${outcome}`,
            kind: "compaction",
            revision: 1,
            status: "completed",
            outcome,
            reason: "Native compaction did not compact context",
          },
        });
        const terminal = yield* harness.takeEvent("turn.terminal");
        assert.strictEqual(terminal.status, "failed");
        assert.isNotNull(terminal.failure);
        assert.strictEqual(terminal.threadDisposition, "reusable");
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects unknown compaction admission status without leaving an active turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      fake.queueResponse("session/compact", { status: "unsupported_future_status" });
      const result = yield* harness.runtime.compactThread!(
        yield* turnInput(harness.providerThread),
      ).pipe(Effect.exit);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual((yield* harness.takeEvent("turn.terminal")).status, "failed");
      yield* startConversation(harness, fake, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "uses durable terminal evidence for historical turns and leaves unknown turns pending",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        fake.setHistory(
          ["completed", "failed", "cancelled", "unknown"].map((status) => ({
            itemId: `message-${status}`,
            turnId: `turn-${status}`,
            kind: "agentMessage",
            status: "completed",
            revision: 1,
            text: `Answer from ${status} turn`,
          })),
        );
        const harness = yield* makeHarness(fake, INSTANCE_ID, "saved-session");
        fake.queueResponse("view/page", {
          events: ["completed", "failed", "cancelled"].map((terminal) => ({
            method: "turn/completed",
            params: { sessionId: "saved-session", turnId: `turn-${terminal}`, terminal },
          })),
          nextCursor: null,
        });
        const snapshot = yield* harness.runtime.readThreadSnapshot!({
          providerThread: harness.providerThread,
        });
        assert.deepStrictEqual(
          Object.fromEntries(
            snapshot.providerTurns.map((turn) => [turn.nativeTurnRef?.nativeId, turn.status]),
          ),
          {
            "turn-completed": "completed",
            "turn-failed": "failed",
            "turn-cancelled": "cancelled",
            "turn-unknown": "pending",
          },
        );
        assert.strictEqual(snapshot.messages.length, 4);
        const failed = snapshot.providerTurns.find(
          (turn) => turn.nativeTurnRef?.nativeId === "turn-failed",
        )!;
        const rollback = yield* harness.runtime.rollbackThread!({
          providerThread: harness.providerThread,
          providerThreadTurns: snapshot.providerTurns,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("historical-failed-checkpoint"),
            appRunOrdinal: 2,
            providerTurn: failed,
          },
        }).pipe(Effect.exit);
        assert.strictEqual(rollback._tag, "Failure");
        assert.isFalse(fake.calls.some((call) => call.method === "session/fork"));
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "interrupts a recovered active native turn before attaching its saved conversation",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        fake.queueResponse("session/resume", {
          session: { sessionId: "saved-session", modelId: MODEL, activeTurnId: "orphaned-turn" },
          history: { items: [] },
        });
        const opening = yield* makeHarness(fake, INSTANCE_ID, "saved-session").pipe(
          Effect.forkScoped,
        );
        assert.strictEqual((yield* fake.takeCall("turn/interrupt")).params.turnId, "orphaned-turn");
        yield* fake.emit("turn/completed", { turnId: "orphaned-turn", terminal: "cancelled" });
        const harness = yield* Fiber.join(opening);
        assert.strictEqual(harness.providerThread.nativeThreadRef?.nativeId, "saved-session");
        assert.strictEqual(
          (yield* fake.takeCall("session/setApprovalMode")).params.mode,
          "allowAll",
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("forks through a completed native turn and adopts the fork on a fresh host", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const replacement = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake, INSTANCE_ID, undefined, replacement);
      const turn = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", { turnId: turn.nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      const completed = {
        ...turn.providerTurn,
        status: "completed" as const,
        completedAt: yield* DateTime.now,
      };
      fake.queueResponse("session/fork", {
        session: { sessionId: "forked-session", modelId: MODEL, activeTurnId: null },
        history: { items: [] },
      });
      const forked = yield* harness.runtime.forkThread!({
        sourceProviderThread: harness.providerThread,
        sourceProviderTurns: [completed],
        providerTurnId: completed.id,
        targetThreadId: ThreadId.make("forked-app-thread"),
      });
      assert.deepStrictEqual((yield* fake.takeCall("session/fork")).params.cutPoint, {
        lastTurnId: turn.nativeId,
      });
      assert.strictEqual(fake.closeCount(), 1);
      assert.strictEqual(
        (yield* replacement.takeCall("session/resume")).params.sessionId,
        "forked-session",
      );
      assert.strictEqual(forked.nativeThreadRef?.nativeId, "forked-session");
      assert.notStrictEqual(forked.id, harness.providerThread.id);
      assert.strictEqual(forked.appThreadId, "forked-app-thread");
      // The orchestration projector keeps its preallocated row and adopts only the native ref.
      const authoritative = { ...forked, id: ProviderThreadId.make("orchestrator-fork-row") };
      yield* harness.runtime.startTurn(yield* turnInput(authoritative, 2));
      yield* replacement.takeCall("turn/start");
      const adopted = yield* harness.takeEvent(
        "provider_turn.updated",
        (event) => event.providerTurn.providerThreadId === authoritative.id,
      );
      assert.strictEqual(adopted.providerTurn.providerThreadId, authoritative.id);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "rolls back through native forking while keeping the app provider-thread identity",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeMuse();
        const replacement = yield* makeFakeMuse();
        const harness = yield* makeHarness(fake, INSTANCE_ID, undefined, replacement);
        const turn = yield* startConversation(harness, fake);
        yield* fake.emit("turn/completed", { turnId: turn.nativeId, terminal: "completed" });
        yield* harness.takeEvent("turn.terminal");
        const completed = {
          ...turn.providerTurn,
          status: "completed" as const,
          completedAt: yield* DateTime.now,
        };
        fake.queueResponse("session/fork", {
          session: { sessionId: "rewound-session", modelId: MODEL, activeTurnId: null },
          history: { items: [] },
        });
        const restored = yield* harness.runtime.rollbackThread!({
          providerThread: harness.providerThread,
          providerThreadTurns: [completed],
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-1"),
            appRunOrdinal: 1,
            providerTurn: completed,
          },
        });
        assert.strictEqual(restored.providerThread.id, harness.providerThread.id);
        assert.strictEqual(restored.providerThread.nativeThreadRef?.nativeId, "rewound-session");
        assert.strictEqual(
          (yield* replacement.takeCall("session/resume")).params.sessionId,
          "rewound-session",
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects an uncommitted native boundary without issuing a fork", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const turn = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", {
        turnId: turn.nativeId,
        terminal: "failed",
        reason: "not committed",
      });
      yield* harness.takeEvent("turn.terminal");
      const failed = {
        ...turn.providerTurn,
        status: "failed" as const,
        completedAt: yield* DateTime.now,
      };
      const result = yield* harness.runtime.rollbackThread!({
        providerThread: harness.providerThread,
        providerThreadTurns: [failed],
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-failed"),
          appRunOrdinal: 1,
          providerTurn: failed,
        },
      }).pipe(Effect.exit);
      assert.strictEqual(result._tag, "Failure");
      assert.isFalse(fake.calls.some((call) => call.method === "session/fork"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rolls back to thread start without publishing a phantom provider-thread row", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const replacement = yield* makeFakeMuse("fresh");
      const allocated = yield* preallocatedProviderThread();
      const harness = yield* makeHarness(fake, INSTANCE_ID, undefined, replacement, allocated);
      const turn = yield* startConversation(harness, fake);
      yield* fake.emit("turn/completed", { turnId: turn.nativeId, terminal: "completed" });
      yield* harness.takeEvent("turn.terminal");
      const restored = yield* harness.runtime.rollbackThread!({
        providerThread: harness.providerThread,
        providerThreadTurns: [],
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("thread-start-checkpoint"),
          appRunOrdinal: 0,
        },
      });
      const started = yield* replacement.takeCall("session/start");
      assert.strictEqual(restored.providerThread.id, allocated.id);
      assert.strictEqual(
        restored.providerThread.nativeThreadRef?.nativeId,
        started.params.sessionId,
      );
      assert.notStrictEqual(
        restored.providerThread.nativeThreadRef?.nativeId,
        harness.providerThread.nativeThreadRef?.nativeId,
      );
      yield* harness.runtime.startTurn(yield* turnInput(restored.providerThread, 2));
      yield* replacement.takeCall("turn/start");
      yield* harness.takeEvent(
        "provider_thread.updated",
        (event) => event.providerThread.status === "active",
      );
      assert.isTrue(
        harness.allEvents.every(
          (event) =>
            event.type !== "provider_thread.updated" || event.providerThread.id === allocated.id,
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
