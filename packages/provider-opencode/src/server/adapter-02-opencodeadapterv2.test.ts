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
  it.effect.each(["completed", "failed", "unavailable"] as const)(
    "normalizes OpenCode step usage for %s turns",
    (ending) =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        let promptId = "";
        const harness = yield* makeOpenCodeRuntimeHarness(`usage-${ending}`, "root", {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            promptAsync: async (input: { messageID: string }) => {
              promptId = input.messageID;
              return { data: true };
            },
            abort: async () => ({ data: true }),
            children: async () => ({ data: [] }),
          },
        });
        yield* harness.startTurn();
        const received = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.updated",
            properties: {
              sessionID: "root",
              info: { id: promptId, role: "user", time: { created: 1 } },
            },
          }),
        );
        const step = (id: string, messageID = "assistant") => ({
          type: "message.part.updated",
          properties: {
            part: {
              type: "step-finish",
              id,
              sessionID: "root",
              messageID,
              reason: "stop",
              cost: 0.01,
              tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } },
            },
          },
        });
        if (ending !== "unavailable") {
          yield* Effect.promise(() => nativeEvents.push(step("one")));
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.updated",
              properties: {
                sessionID: "root",
                info: {
                  id: "assistant",
                  role: "assistant",
                  time: { created: 1 },
                  parentID: promptId,
                },
              },
            }),
          );
          yield* Effect.promise(() => nativeEvents.push(step("one")));
          yield* Effect.promise(() => nativeEvents.push(step("two")));
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.part.removed",
              properties: { sessionID: "root", messageID: "assistant", partID: "one" },
            }),
          );
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.updated",
              properties: {
                sessionID: "root",
                info: {
                  id: "old-assistant",
                  role: "assistant",
                  time: { created: 1 },
                  parentID: "old-prompt",
                },
              },
            }),
          );
          yield* Effect.promise(() => nativeEvents.push(step("old", "old-assistant")));
        }
        if (ending === "failed") {
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "session.error",
              properties: {
                sessionID: "root",
                error: { name: "UnknownError", data: { message: "failed" } },
              },
            }),
          );
        } else {
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "session.status",
              properties: { sessionID: "root", status: { type: "busy" } },
            }),
          );
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "session.status",
              properties: { sessionID: "root", status: { type: "idle" } },
            }),
          );
        }
        const events = yield* Fiber.join(received);
        const completed = events.findLast((event) => event.type === "provider_turn.updated");
        assert.deepEqual(
          completed?.providerTurn.turnTokenUsage,
          ending === "unavailable"
            ? { usageStatus: "unavailable", usageScope: "main_agent", hasSubagents: false }
            : {
                usageStatus: ending === "completed" ? "complete" : "partial",
                usageScope: "main_agent",
                inputTokens: 34,
                cachedInputTokens: 6,
                cacheCreationTokens: 8,
                outputTokens: 14,
                reasoningTokens: 4,
                hasSubagents: false,
              },
        );
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );
  it.effect("preserves native multi-select and custom-answer flags through a live reply", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      let delivered: unknown;
      const harness = yield* makeOpenCodeRuntimeHarness("question-flags", "root", {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
          promptAsync: async () => ({ data: true }),
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
        question: {
          reply: async (input: unknown) => {
            delivered = input;
            return { data: true };
          },
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "runtime_request.updated" ||
            (event.type === "turn_item.updated" && event.turnItem.type === "user_input_request"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "question.asked",
          properties: {
            id: "question",
            sessionID: "root",
            questions: [
              {
                header: "Drinks",
                question: "Which drinks?",
                multiple: true,
                custom: false,
                options: [
                  { label: "Tea", description: "Hot" },
                  { label: "Water", description: "Cold" },
                ],
              },
            ],
          },
        }),
      );
      const events = yield* Fiber.join(received);
      const item = events.find((event) => event.type === "turn_item.updated");
      const request = events.find((event) => event.type === "runtime_request.updated");
      assert.equal(item?.type, "turn_item.updated");
      if (
        item?.type !== "turn_item.updated" ||
        item.turnItem.type !== "user_input_request" ||
        request?.type !== "runtime_request.updated"
      )
        throw new Error("Native question missing");
      assert.equal(item.turnItem.questions[0]?.multiSelect, true);
      assert.equal(item.turnItem.questions[0]?.allowCustomAnswer, false);
      yield* harness.runtime.respondToRuntimeRequest({
        requestId: request.runtimeRequest.id,
        answers: { "question-0-drinks": ["Tea", "Water"] },
      });
      assert.deepInclude(delivered, { answers: [["Tea", "Water"]] });
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
});

