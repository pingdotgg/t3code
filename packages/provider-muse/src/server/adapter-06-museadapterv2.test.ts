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
  it.effect("lists a running subagent under its turn item's native id as Muse reveals it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      const revisions = [
        { revision: 1, status: "inProgress" },
        { revision: 2, status: "inProgress", subagentId: "" },
        { revision: 3, status: "inProgress", subagentId: "subagent-1" },
        {
          revision: 4,
          status: "inProgress",
          subagentId: "subagent-1",
          childSessionId: "child-session-1",
        },
        {
          revision: 5,
          status: "completed",
          subagentId: "subagent-1",
          childSessionId: "child-session-1",
        },
      ];
      const listed: Array<{ nativeId: string | null | undefined; roster: Array<string> }> = [];
      for (const fields of revisions) {
        yield* fake.emit(fields.revision === 1 ? "item/started" : "item/updated", {
          turnId: nativeId,
          item: { itemId: "sub-1", kind: "subagent", turnId: nativeId, ...fields },
        });
        const item = yield* harness.takeEvent(
          "turn_item.updated",
          (event) => event.turnItem.type === "subagent",
        );
        const roster = harness.allEvents.findLast(
          (event) => event.type === "provider_thread.updated",
        );
        listed.push({
          nativeId: item.turnItem.nativeItemRef?.nativeId,
          roster:
            roster?.type === "provider_thread.updated"
              ? (roster.providerThread.pendingBackgroundTasks ?? []).map((task) => task.taskId)
              : [],
        });
      }
      assert.deepStrictEqual(listed, [
        { nativeId: "sub-1", roster: ["sub-1"] },
        { nativeId: "sub-1", roster: ["sub-1"] },
        { nativeId: "subagent-1", roster: ["subagent-1"] },
        { nativeId: "child-session-1", roster: ["child-session-1"] },
        { nativeId: "child-session-1", roster: [] },
      ]);
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

