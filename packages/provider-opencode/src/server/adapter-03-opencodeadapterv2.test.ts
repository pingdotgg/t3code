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
  it.effect(
    "preserves tool lifecycle, approval kinds, and late assistant text without cached tool payloads",
    () =>
      Effect.gen(function* () {
        const nativeEvents = asyncEventStream();
        const nativeSessionId = "native-opencode-tool-lifecycle";
        const harness = yield* makeOpenCodeRuntimeHarness("tool-lifecycle", nativeSessionId, {
          event: {
            subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
              options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
              return { stream: nativeEvents.stream };
            },
          },
          session: {
            create: async () => ({
              data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
            }),
            promptAsync: async () => ({ data: true }),
          },
        });
        yield* harness.startTurn();
        const received = yield* harness.runtime.events.pipe(
          Stream.takeUntil(
            (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
          ),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const states = [
          { status: "pending", input: { command: "pwd" }, raw: "" },
          {
            status: "running",
            input: { command: "pwd" },
            title: "Working directory",
            time: { start: 1 },
          },
          {
            status: "completed",
            input: { command: "pwd" },
            output: "/repo\n",
            title: "Working directory",
            metadata: {},
            time: { start: 1, end: 2 },
          },
          {
            status: "error",
            input: { command: "pwd" },
            error: "Command failed",
            time: { start: 3, end: 4 },
          },
        ] satisfies ReadonlyArray<ToolPart["state"]>;
        for (const state of states) {
          yield* Effect.promise(() =>
            nativeEvents.push({
              type: "message.part.updated",
              properties: {
                sessionID: nativeSessionId,
                part: {
                  id: state.status === "error" ? "part-failed" : "part-working",
                  sessionID: nativeSessionId,
                  messageID: "late-assistant",
                  type: "tool",
                  callID: state.status === "error" ? "call-failed" : "call-working",
                  tool: "bash",
                  state,
                },
              },
            }),
          );
        }
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: "part-exit",
                sessionID: nativeSessionId,
                messageID: "late-assistant",
                type: "tool",
                callID: "call-exit",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: "vp test" },
                  output: "1 failed\n",
                  title: "Run tests",
                  metadata: { output: "1 failed\n", exit: 1, truncated: false },
                  time: { start: 4, end: 5 },
                },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: "part-read",
                sessionID: nativeSessionId,
                messageID: "late-assistant",
                type: "tool",
                callID: "call-read",
                tool: "read",
                state: { status: "pending", input: { filePath: "/outside/file" }, raw: "" },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "permission.asked",
            properties: {
              id: "read-permission",
              sessionID: nativeSessionId,
              permission: "external_directory",
              patterns: ["/outside/*"],
              always: [],
              metadata: {},
              tool: { messageID: "late-assistant", callID: "call-read" },
            },
          }),
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: "part-text",
                sessionID: nativeSessionId,
                messageID: "late-assistant",
                type: "text",
                text: "Tool results received",
                time: { start: 4 },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.updated",
            properties: {
              sessionID: nativeSessionId,
              info: {
                id: "late-assistant",
                sessionID: nativeSessionId,
                role: "assistant",
                time: { created: 1, completed: 4 },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "session.compacted",
            properties: { sessionID: nativeSessionId },
          }),
        );
        const events = yield* Fiber.join(received);
        const items = events.flatMap((event) =>
          event.type === "turn_item.updated" ? [event.turnItem] : [],
        );
        const commands = items.filter((item) => item.type === "command_execution");
        assert.deepEqual(
          commands.map((item) => item.status),
          ["pending", "running", "completed", "failed", "failed"],
        );
        assert.deepEqual(
          commands.map((item) => item.input),
          ["pwd", "pwd", "pwd", "pwd", "vp test"],
        );
        assert.equal(commands[2]?.output, "/repo\n");
        assert.equal(commands[3]?.output, "Command failed");
        assert.equal(commands[4]?.exitCode, 1);
        assert.equal(
          events
            .flatMap((event) => (event.type === "node.updated" ? [event.node] : []))
            .findLast((node) => node.id === commands[4]?.nodeId)?.status,
          "failed",
        );
        assert.isTrue(
          events.some(
            (event) =>
              event.type === "runtime_request.updated" && event.runtimeRequest.kind === "file-read",
          ),
        );
        const assistant = items.filter((item) => item.type === "assistant_message");
        assert.equal(assistant.at(-1)?.text, "Tool results received");
        assert.equal(assistant.at(-1)?.status, "completed");
      }).pipe(
        Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
        Effect.scoped,
      ),
  );
  it.effect("reports a background task child as pending work after the root turn settles", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const push = (event: unknown) => Effect.promise(() => nativeEvents.push(event));
      const root = "ses_root";
      const child = "ses_child";
      let promptId = "";
      const harness = yield* makeOpenCodeRuntimeHarness("background-child", root, {
        event: { subscribe: async () => ({ stream: nativeEvents.stream }) },
        session: {
          create: async () => ({ data: { id: root, time: { created: 1, updated: 1 } } }),
          get: async () => ({
            data: { id: child, parentID: root, permission: [], time: { created: 2, updated: 2 } },
          }),
          update: async () => ({ data: { id: child, parentID: root } }),
          promptAsync: async (input: { messageID: string }) => {
            promptId = input.messageID;
            return { data: true };
          },
          abort: async () => ({ data: true }),
          children: async () => ({ data: [] }),
        },
      });
      const hasPendingBackgroundWork = harness.runtime.hasPendingBackgroundWork;
      if (hasPendingBackgroundWork === undefined) {
        return yield* Effect.die("OpenCode runtime must expose hasPendingBackgroundWork.");
      }
      yield* harness.startTurn();
      const terminal = yield* harness.runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
        Effect.forkScoped,
      );
      const taskPart = (status: "running" | "completed") => ({
        type: "message.part.updated",
        properties: {
          sessionID: root,
          part: {
            id: "prt_task",
            sessionID: root,
            messageID: "msg_root_assistant",
            type: "tool",
            tool: "task",
            callID: "call_task",
            state: {
              status,
              input: {
                description: "Background sleep task",
                prompt: "sleep",
                subagent_type: "general",
              },
              title: "Background sleep task",
              metadata: { parentSessionId: root, sessionId: child, background: true },
              time: { start: 3, ...(status === "completed" ? { end: 3 } : {}) },
              ...(status === "completed" ? { output: "Background task started" } : {}),
            },
          },
        },
      });
      const status = (sessionID: string, type: "busy" | "idle") => ({
        type: "session.status",
        properties: { sessionID, status: { type } },
      });

      yield* push({
        type: "message.updated",
        properties: {
          sessionID: root,
          info: { id: promptId, sessionID: root, role: "user", time: { created: 1 } },
        },
      });
      yield* push(status(root, "busy"));
      yield* push(taskPart("running"));
      yield* push({
        type: "session.created",
        properties: {
          sessionID: child,
          info: { id: child, parentID: root, time: { created: 2, updated: 2 } },
        },
      });
      yield* push(status(child, "busy"));
      yield* push(taskPart("completed"));
      yield* push(status(root, "idle"));
      assert.equal(Option.getOrUndefined(yield* Fiber.join(terminal))?.status, "completed");
      assert.isTrue(yield* hasPendingBackgroundWork, "the running child must pin idle release");

      yield* push(status(child, "idle"));
      yield* push({ type: "session.idle", properties: { sessionID: child } });
      assert.isFalse(yield* hasPendingBackgroundWork, "an idle child must not pin idle release");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
});

