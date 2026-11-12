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
  it.effect("projects OpenCode read output and search titles from native tool calls", () =>
    Effect.gen(function* () {
      const directoryOutput =
        "<path>/workspace/src</path>\n<type>directory</type>\n<entries>\nenv.ts\nlib/\n\n(2 entries)\n</entries>";
      const fileOutput =
        "<path>/workspace/src/env.ts</path>\n<type>file</type>\n<content>\n1: hello\n2: </content> literal\n3: world\n</content>";
      const fileWithInstructions =
        "<path>/workspace/src/env.ts</path>\n<type>file</type>\n<content>1: hello\n\n(End of file - total 1 lines)\n</content>\n\n<system-reminder>\nProject instructions\n</system-reminder>";
      const missingPath = directoryOutput.slice(directoryOutput.indexOf("<type>"));
      const missingClose = fileOutput.slice(0, fileOutput.lastIndexOf("\n</content>"));
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-search";
      const harness = yield* makeOpenCodeRuntimeHarness("search-projection", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        mcp: { status: async () => ({ data: {} }) },
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
      const toolCalls = [
        ["read", { filePath: "src/env.ts" }, "---\nfile body"],
        ["read", { filePath: "/workspace/src" }, directoryOutput],
        ["read", { filePath: "/workspace/src/env.ts" }, fileOutput],
        ["read", { filePath: "/workspace/src/env.ts" }, fileWithInstructions],
        ["read", { filePath: "/workspace/src" }, missingPath],
        ["read", { filePath: "/workspace/src/env.ts" }, missingClose],
        ["custom_read", { filePath: "/workspace/src" }, directoryOutput],
        ["grep", { pattern: "TODO", path: "apps/web" }, "---\nfile body"],
        ["websearch", { query: "OpenCode documentation" }, "---\nfile body"],
        ["glob", { pattern: "missing", path: "apps/web" }, ""],
        ["codesearch", {}, " \n\t"],
      ] as const;
      for (const [index, [tool, input, output]] of toolCalls.entries()) {
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: `part-${index}`,
                sessionID: nativeSessionId,
                messageID: "assistant-search",
                type: "tool",
                callID: `call-${index}`,
                tool,
                state: {
                  status: "completed",
                  input,
                  output,
                  title: tool,
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              },
            },
          }),
        );
      }
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.compacted",
          properties: { sessionID: nativeSessionId },
        }),
      );
      const items = (yield* Fiber.join(received)).flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const reads = items.filter((item) => item.type === "dynamic_tool");
      assert.equal(reads[0]?.title, "Read src/env.ts");
      assert.deepEqual(
        reads.map((item) => ({ toolName: item.toolName, output: item.output })),
        [
          { toolName: "read", output: "---\nfile body" },
          { toolName: "read", output: "env.ts\nlib/\n\n(2 entries)" },
          { toolName: "read", output: "1: hello\n2: </content> literal\n3: world" },
          {
            toolName: "read",
            output:
              "1: hello\n\n(End of file - total 1 lines)\n\n<system-reminder>\nProject instructions\n</system-reminder>",
          },
          { toolName: "read", output: missingPath },
          { toolName: "read", output: missingClose },
          { toolName: "custom_read", output: directoryOutput },
        ],
      );
      const grep = items.find((item) => item.type === "file_search");
      assert.equal(grep?.title, "Searched TODO in web");
      assert.equal(grep?.type === "file_search" ? grep.pattern : null, "TODO");
      assert.deepEqual(grep?.type === "file_search" ? grep.results : null, [
        { fileName: "apps/web", preview: "---\nfile body" },
      ]);
      const webSearch = items.find((item) => item.type === "web_search");
      assert.deepEqual(webSearch?.type === "web_search" ? webSearch.patterns : null, [
        "OpenCode documentation",
      ]);
      assert.deepEqual(webSearch?.type === "web_search" ? webSearch.results : null, [
        { snippet: "---\nfile body" },
      ]);
      const emptyFileSearch = items.find(
        (item) => item.type === "file_search" && item.pattern === "missing",
      );
      assert.ok(emptyFileSearch?.type === "file_search");
      assert.equal(emptyFileSearch.results, undefined);
      const emptyWebSearch = items.find(
        (item) => item.type === "web_search" && item.patterns === undefined,
      );
      assert.ok(emptyWebSearch?.type === "web_search");
      assert.equal(emptyWebSearch.results, undefined);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
  it.effect("drops cancelled OpenCode todos so a finished list completes", () =>
    Effect.gen(function* () {
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-todos";
      const harness = yield* makeOpenCodeRuntimeHarness("todos", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        mcp: { status: async () => ({ data: {} }) },
        session: {
          create: async () => ({
            data: { id: nativeSessionId, time: { created: 1, updated: 1 } },
          }),
          promptAsync: async () => ({ data: true }),
        },
      });
      yield* harness.startTurn();
      const received = yield* harness.runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "plan.updated"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "todo.updated",
          properties: {
            sessionID: nativeSessionId,
            todos: [
              { content: "Write the fix", status: "completed", priority: "high" },
              { content: "Try another approach", status: "cancelled", priority: "low" },
              { content: "Add a test", status: "completed", priority: "medium" },
            ],
          },
        }),
      );
      const plan = (yield* Fiber.join(received)).flatMap((event) =>
        event.type === "plan.updated" ? [event.plan] : [],
      )[0];
      assert.ok(plan?.kind === "todo_list");
      assert.deepEqual(
        plan.steps.map((step) => ({ text: step.text, status: step.status })),
        [
          { text: "Write the fix", status: "completed" },
          { text: "Add a test", status: "completed" },
        ],
      );
      assert.equal(plan.status, "completed");
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
  it.effect("presents OpenCode MCP calls without treating remote tools as local edits", () =>
    Effect.gen(function* () {
      const output =
        "<path>/workspace/src</path>\n<type>directory</type>\n<entries>\nenv.ts\nlib/\n\n(2 entries)\n</entries>";
      const nativeEvents = asyncEventStream();
      const nativeSessionId = "native-opencode-mcp";
      let statusReads = 0;
      const harness = yield* makeOpenCodeRuntimeHarness("mcp-presentation", nativeSessionId, {
        event: {
          subscribe: async (_input: unknown, options: { signal?: AbortSignal }) => {
            options.signal?.addEventListener("abort", () => nativeEvents.close(), { once: true });
            return { stream: nativeEvents.stream };
          },
        },
        session: {
          create: async () => ({ data: { id: nativeSessionId, time: { created: 1, updated: 1 } } }),
          promptAsync: async () => ({ data: true }),
        },
        mcp: {
          status: async () => {
            statusReads++;
            return {
              data: {
                "my.server_with_underscores": { status: "connected" },
                ambiguous: { status: "connected" },
                ambiguous_server: { status: "connected" },
                code: { status: "connected" },
                apply: { status: "connected" },
              },
            };
          },
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
      for (const status of ["running", "completed", "error"] as const) {
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: "mcp-part",
                sessionID: nativeSessionId,
                messageID: "mcp-assistant",
                type: "tool",
                callID: "mcp-call",
                tool: "my_server_with_underscores_edit_document",
                state: {
                  status,
                  input: { document: "remote-doc" },
                  title: "Edit remote document",
                  metadata: {},
                  output,
                  error: "failed",
                  time: { start: 1, end: 2 },
                },
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
              id: "ambiguous-part",
              sessionID: nativeSessionId,
              messageID: "mcp-assistant",
              type: "tool",
              callID: "ambiguous-call",
              tool: "ambiguous_server_edit_document",
              state: {
                status: "completed",
                input: {},
                title: "Ambiguous tool",
                metadata: {},
                output: "",
                time: { start: 1, end: 2 },
              },
            },
          },
        }),
      );
      for (const tool of ["code_search", "apply_patch"]) {
        yield* Effect.promise(() =>
          nativeEvents.push({
            type: "message.part.updated",
            properties: {
              sessionID: nativeSessionId,
              part: {
                id: `native-${tool}`,
                sessionID: nativeSessionId,
                messageID: "mcp-assistant",
                type: "tool",
                callID: `native-${tool}`,
                tool,
                state: {
                  status: "completed",
                  input: { query: "needle", filePath: "local.ts" },
                  title: `Native ${tool}`,
                  metadata: {},
                  output: "done",
                  time: { start: 1, end: 2 },
                },
              },
            },
          }),
        );
      }
      yield* Effect.promise(() =>
        nativeEvents.push({
          type: "session.compacted",
          properties: { sessionID: nativeSessionId },
        }),
      );
      const allItems = (yield* Fiber.join(received)).flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      assert.equal(
        allItems.find((item) => item.title === "Native code_search")?.type,
        "web_search",
      );
      assert.equal(
        allItems.find((item) => item.title === "Native apply_patch")?.type,
        "file_change",
      );
      const items = allItems.filter((item) => item.type === "dynamic_tool");
      assert.deepEqual(
        items.slice(0, 3).map((item) => item.status),
        ["running", "completed", "failed"],
      );
      assert.deepEqual(
        items.slice(0, 3).map((item) => item.title),
        ["Edit remote document", "Edit remote document", "edit document"],
      );
      for (const item of items.slice(0, 3)) {
        assert.deepEqual(item.toolSource, {
          key: "mcp:my.server_with_underscores",
          name: "my.server with underscores",
          kind: "integration",
        });
        assert.deepEqual(item.input, { document: "remote-doc" });
      }
      assert.equal(items[1]?.output, output);
      assert.equal(items[3]?.toolName, "ambiguous_server_edit_document");
      assert.isUndefined(items[3]?.toolSource);
      assert.equal(statusReads, 1);
    }).pipe(
      Effect.provide(Layer.merge(IdAllocator.layer, McpProviderSessions.layer)),
      Effect.scoped,
    ),
  );
});

