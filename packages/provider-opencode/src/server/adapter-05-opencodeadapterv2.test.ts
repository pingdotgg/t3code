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
  it.effect("admits a native command on its user receipt before generation completes", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const release = promiseGate<void>();
      const calls = yield* Queue.unbounded<{
        messageID: string;
        command: string;
        arguments: string;
        model: string;
      }>();
      let promptCalls = 0;
      const sessionId = "native-command";
      const harness = yield* makeOpenCodeRuntimeHarness("native-command", sessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        command: { list: async () => ({ data: [{ name: "git/review" }] }) },
        session: {
          create: async () => ({ data: { id: sessionId, time: { created: 1, updated: 1 } } }),
          command: async (input: {
            messageID: string;
            command: string;
            arguments: string;
            model: string;
          }) => {
            Queue.offerUnsafe(calls, input);
            await release.promise;
            return { data: true };
          },
          promptAsync: async () => {
            promptCalls++;
            return { data: true };
          },
        },
      });
      const start = yield* harness.startTurn("/git/review staged changes").pipe(Effect.forkScoped);
      const call = yield* Queue.take(calls);
      assert.equal(call.command, "git/review");
      assert.equal(call.arguments, "staged changes");
      assert.equal(call.model, "anthropic/claude-sonnet");
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "message.updated",
          properties: {
            sessionID: sessionId,
            info: {
              id: call.messageID,
              sessionID: sessionId,
              role: "user",
              time: { created: DateTime.toEpochMillis(harness.now) },
            },
          },
        }),
      );
      yield* Fiber.join(start);
      assert.equal(promptCalls, 0);
      release.resolve();
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
  it.effect("compacts with the native summarize API and emits a completed compaction", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const summarizeCalls: Array<unknown> = [];
      let promptCalls = 0;
      const harness = yield* makeOpenCodeRuntimeHarness("compact", "native-opencode-compact", {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: "native-opencode-compact", time: { created: 1, updated: 1 } },
          }),
          summarize: async (input: unknown) => {
            summarizeCalls.push(input);
            return { data: true };
          },
          promptAsync: async () => {
            promptCalls += 1;
            return { data: true };
          },
        },
      });
      yield* harness.startTurn("/compact");
      const events = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      assert.deepEqual(summarizeCalls, [
        {
          sessionID: "native-opencode-compact",
          providerID: "anthropic",
          modelID: "claude-sonnet",
          auto: false,
        },
      ]);
      assert.equal(promptCalls, 0);
      assert.equal(
        events.filter(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "compaction" &&
            event.turnItem.status === "completed",
        ).length,
        1,
      );
      assert.isTrue(
        events.some((event) => event.type === "turn.terminal" && event.status === "completed"),
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
  it.effect("ends a turn on the provider thread it started on", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const harness = yield* makeOpenCodeRuntimeHarness(
        "forked-row",
        "native-opencode-forked-row",
        {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
              return { stream: nativeEvents.stream };
            },
          },
          session: {
            create: async () => ({
              data: { id: "native-opencode-forked-row", time: { created: 1, updated: 1 } },
            }),
            summarize: async () => ({ data: true }),
          },
        },
      );
      const forkedRow = {
        ...harness.providerThread,
        id: ProviderThreadId.make("provider-thread:opencode-test:forked-run-row"),
      };
      yield* harness.startTurn("/compact", forkedRow);
      const terminal = yield* harness.runtime.events.pipe(
        Stream.filter(
          (event): event is Extract<typeof event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        ),
        Stream.runHead,
      );
      assert.equal(Option.getOrUndefined(terminal)?.providerThreadId, forkedRow.id);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
  it.effect("does not restore messages beyond OpenCode's persisted revert boundary", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-reverted-snapshot";
      const messages = [
        {
          info: {
            id: "user-kept",
            sessionID: nativeSessionId,
            role: "user",
            time: { created: 1 },
          },
          parts: [{ type: "text", text: "keep this prompt" }],
        },
        {
          info: {
            id: "assistant-kept",
            sessionID: nativeSessionId,
            role: "assistant",
            time: { created: 2, completed: 3 },
          },
          parts: [{ type: "text", text: "keep this answer" }],
        },
        {
          info: {
            id: "user-reverted",
            sessionID: nativeSessionId,
            role: "user",
            time: { created: 4 },
          },
          parts: [{ type: "text", text: "remove this prompt" }],
        },
        {
          info: {
            id: "assistant-reverted",
            sessionID: nativeSessionId,
            role: "assistant",
            time: { created: 5, completed: 6 },
          },
          parts: [{ type: "text", text: "remove this answer" }],
        },
      ];
      const harness = yield* makeOpenCodeRuntimeHarness("reverted-snapshot", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), {
              once: true,
            });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          get: async () => ({
            data: {
              id: nativeSessionId,
              time: { created: 1, updated: 6 },
              revert: { messageID: "user-reverted" },
            },
          }),
          messages: async () => ({ data: messages }),
        },
      });

      const snapshot = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });

      assert.deepEqual(
        snapshot.messages.map((message) => message.text),
        ["keep this prompt", "keep this answer"],
      );
      const providerPayload = snapshot.providerPayload as ReadonlyArray<{
        readonly info: { readonly id: string };
      }>;
      assert.deepEqual(
        providerPayload.map((entry) => entry.info.id),
        ["user-kept", "assistant-kept"],
      );
      assert.equal(snapshot.providerThread.nativeConversationHeadRef?.nativeId, "user-kept");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
  it.effect("steers with the turn's agent, reasoning variant and system instructions", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const promptInputs: Array<{ agent?: string; variant?: string; system?: string }> = [];
      const harness = yield* makeOpenCodeRuntimeHarness(
        "steer-agent",
        "root",
        {
          event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
          session: {
            create: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            get: async () => ({ data: { id: "root", time: { created: 1, updated: 1 } } }),
            messages: async () => ({ data: [] }),
            promptAsync: async (input: { agent?: string; variant?: string; system?: string }) => {
              promptInputs.push(input);
              return { data: true };
            },
            abort: async () => ({ data: true }),
            children: async () => ({ data: [] }),
          },
        },
        {},
        { options: [{ id: "variant", value: "high" }], interactionMode: "plan" },
      );
      yield* harness.startTurn();
      const snapshot = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      yield* harness.runtime.steerTurn({
        threadId: harness.threadId,
        runId: harness.runId,
        providerThread: harness.providerThread,
        providerTurnId: snapshot.providerTurns.at(-1)!.id,
        message: {
          messageId: MessageId.make("message-opencode-steer-agent"),
          text: "also cover the README",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });

      const [start, steer] = promptInputs;
      assert.equal(start?.agent, "plan");
      assert.equal(start?.variant, "high");
      assert.include(start?.system ?? "", "OpenCode");
      assert.deepEqual(
        { agent: steer?.agent, variant: steer?.variant, system: steer?.system },
        { agent: start?.agent, variant: start?.variant, system: start?.system },
      );
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
});

