import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
} from "../ProviderAdapter.ts";
import { makePiAdapterV2, PI_PROVIDER } from "./PiAdapterV2.ts";
import { makePiRpcConnection, type PiRpcRecord } from "./PiRpc.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-pi-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));

const testLayer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer, serverConfigLayer);

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PI_INSTANCE_ID = ProviderInstanceId.make("pi");
const THREAD_ID = ThreadId.make("thread-pi-test");
const SESSION_ID = ProviderSessionId.make("provider-session-pi-test");
const FAKE_SESSION_FILE = "/fake/.pi/agent/sessions/--workspace--/0001_abc.jsonl";
/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const modelSelection = (model: string): ModelSelection => ({
  instanceId: PI_INSTANCE_ID,
  model,
});

interface FakePi {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly emit: (record: PiRpcRecord) => Effect.Effect<void>;
  readonly takeRequest: (type: string) => Effect.Effect<PiRpcRecord>;
  /** Data returned by the next `get_entries` acks, consumed in order. */
  readonly queueEntries: (data: unknown) => void;
  /** Data returned by the next active-branch `get_messages` acks. */
  readonly queueMessages: (data: unknown) => void;
  /** Make the next `switch_session` ack report an extension veto. */
  readonly vetoNextSwitch: () => void;
  /** Data returned by the next `get_state` acks, consumed in order. */
  readonly queueState: (data: unknown) => void;
  /** Hold the next `get_state` response until the test resolves it. */
  readonly deferNextState: () => void;
  /** Resolve the held `get_state` request. */
  readonly resolveDeferredState: (data: unknown) => Effect.Effect<void>;
  /** Reject the next `get_state` request. */
  readonly failNextState: () => void;
  /** Every request received by the fake process. */
  readonly allRequests: () => ReadonlyArray<PiRpcRecord>;
  /** Data returned by the next `get_session_stats` acks, consumed in order. */
  readonly queueStats: (data: unknown) => void;
  /** Data returned by the next `get_commands` acks, consumed in order. */
  readonly queueCommands: (data: unknown) => void;
  /** Make the next `get_commands` ack fail. */
  readonly failNextCommands: () => void;
  /** Close the fake process stdout stream. */
  readonly closeStdout: Effect.Effect<void>;
  readonly lastSpawn: () => {
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
  };
}

/**
 * In-process fake `pi --mode rpc`: captures every stdin record, auto-acks
 * requests with canned data, and lets tests push protocol events to stdout.
 */
const makeFakePi: Effect.Effect<FakePi> = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<PiRpcRecord>();
  const entriesQueue: Array<unknown> = [];
  const messagesQueue: Array<unknown> = [];
  const stateQueue: Array<unknown> = [];
  const statsQueue: Array<unknown> = [];
  const commandsQueue: Array<{ readonly success: boolean; readonly data?: unknown }> = [];
  const allRequests: Array<PiRpcRecord> = [];
  let deferState = false;
  let deferredStateRequest: PiRpcRecord | undefined;
  let failState = false;
  let vetoSwitch = false;
  let stdinBuffer = "";

  const emit = (record: PiRpcRecord) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`)).pipe(
      Effect.asVoid,
    );

  const respondTo = (record: PiRpcRecord): PiRpcRecord | null => {
    if (typeof record["id"] !== "string") return null;
    const base = {
      type: "response",
      id: record["id"],
      command: String(record["type"]),
      success: true,
    };
    switch (record["type"]) {
      case "get_state":
        if (failState) {
          failState = false;
          return { ...base, success: false, error: "state unavailable" };
        }
        return {
          ...base,
          data: stateQueue.shift() ?? {
            model: null,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            autoCompactionEnabled: true,
            sessionFile: FAKE_SESSION_FILE,
            sessionId: "abc",
          },
        };
      case "switch_session": {
        const cancelled = vetoSwitch;
        vetoSwitch = false;
        return { ...base, data: { cancelled } };
      }
      case "get_entries":
        return { ...base, data: entriesQueue.shift() ?? { entries: [], leafId: null } };
      case "get_messages":
        return { ...base, data: messagesQueue.shift() ?? { messages: [] } };
      case "get_session_stats":
        return { ...base, data: statsQueue.shift() ?? {} };
      case "get_commands":
        return { ...base, ...(commandsQueue.shift() ?? { data: { commands: [] } }) };
      case "fork":
        return { ...base, data: { cancelled: false, message: "forked" } };
      default:
        return base;
    }
  };

  const handleStdinChunk = (chunk: Uint8Array) =>
    Effect.gen(function* () {
      stdinBuffer += new TextDecoder().decode(chunk);
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline === -1) return;
        const line = stdinBuffer.slice(0, newline);
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        const record = decodeJsonLine(line) as PiRpcRecord;
        allRequests.push(record);
        yield* Queue.offer(requests, record);
        if (record["type"] === "get_state" && deferState) {
          deferState = false;
          deferredStateRequest = record;
          continue;
        }
        const response = respondTo(record);
        if (response !== null) yield* emit(response);
      }
    });

  let lastSpawn: { readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv } = {
    args: [],
    env: {},
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) {
        lastSpawn = {
          args: command.args,
          env: command.options.env ?? {},
        };
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach(handleStdinChunk),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const takeRequest = (type: string): Effect.Effect<PiRpcRecord> =>
    Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(requests);
        if (record["type"] === type) return record;
      }
    });

  return {
    spawner,
    emit,
    takeRequest,
    queueEntries: (data) => entriesQueue.push(data),
    queueMessages: (data) => messagesQueue.push(data),
    deferNextState: () => {
      deferState = true;
    },
    resolveDeferredState: (data) =>
      Effect.gen(function* () {
        const record = deferredStateRequest;
        assert.isDefined(record);
        deferredStateRequest = undefined;
        yield* emit({
          type: "response",
          id: record!["id"],
          command: "get_state",
          success: true,
          data,
        });
      }),
    failNextState: () => {
      failState = true;
    },
    allRequests: () => allRequests,
    vetoNextSwitch: () => {
      vetoSwitch = true;
    },
    queueState: (data) => stateQueue.push(data),
    queueStats: (data) => statsQueue.push(data),
    queueCommands: (data) => commandsQueue.push({ success: true, data }),
    failNextCommands: () => commandsQueue.push({ success: false }),
    closeStdout: Queue.end(stdout),
    lastSpawn: () => lastSpawn,
  } satisfies FakePi;
});

const makeAdapter = Effect.fnUntraced(function* (fake: FakePi, launchArgs = "") {
  const idAllocator = yield* IdAllocatorV2;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  return makePiAdapterV2({
    instanceId: PI_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "pi", launchArgs, customModels: [] },
    environment: {},
    spawner: fake.spawner,
    fileSystem,
    idAllocator,
    serverConfig,
  });
});

const openRuntime = Effect.fnUntraced(function* (
  fake: FakePi,
  model = "default",
  threadId = THREAD_ID,
  providerSessionId = SESSION_ID,
) {
  const adapter = yield* makeAdapter(fake);
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId,
    modelSelection: modelSelection(model),
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  return { runtime, takeEvent };
});

const makeAppThread = Effect.fnUntraced(function* (model: string, threadId = THREAD_ID) {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: "project:fixture:pi" as OrchestrationV2AppThread["projectId"],
    title: "Pi test thread",
    providerInstanceId: PI_INSTANCE_ID,
    modelSelection: modelSelection(model),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  model = "default",
  attachments: ReadonlyArray<ChatAttachment> = [],
  text = "Hello pi",
  selection?: ModelSelection,
  runOrdinal = 1,
  threadId = THREAD_ID,
) {
  const appThread = yield* makeAppThread(model, threadId);
  const runId = RunId.make(`run:${threadId}:${runOrdinal}`);
  yield* runtime.startTurn({
    appThread,
    threadId,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${threadId}:${runOrdinal}` as never,
      text,
      attachments,
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection ?? modelSelection(model),
    runtimePolicy,
  });
});

const expectModelFailure = (errorMessage: string) =>
  Effect.gen(function* () {
    const fake = yield* makeFakePi;
    const { runtime, takeEvent } = yield* openRuntime(fake);
    const providerThread = yield* runtime.ensureThread({
      threadId: THREAD_ID,
      modelSelection: modelSelection("default"),
      runtimePolicy,
    });
    yield* startTurn(runtime, providerThread);
    yield* fake.takeRequest("prompt");
    yield* fake.emit({ type: "agent_start" });
    yield* fake.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage,
      },
    });
    yield* fake.emit({ type: "agent_settled" });

    const sessionError = yield* takeEvent(
      (event) =>
        event.type === "provider_session.updated" && event.providerSession.status === "error",
    );
    assert.isTrue(
      sessionError.type === "provider_session.updated" &&
        sessionError.providerSession.lastError === errorMessage,
    );
    const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
    assert.isTrue(
      terminal.type === "turn.terminal" &&
        terminal.status === "failed" &&
        terminal.failure.message === errorMessage,
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer));

describe("PiAdapterV2", () => {
  it.effect("stops provider-initiated work that has no T3 turn owner", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* fake.emit({ type: "agent_start" });

      const sessionError = yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      assert.isTrue(
        sessionError.type === "provider_session.updated" &&
          sessionError.providerSession.lastError?.includes("invisible tool execution") === true,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("injects the T3 MCP extension and bearer when a session exists", () =>
    Effect.gen(function* () {
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-pi-mcp"),
        threadId: THREAD_ID,
        providerSessionId: "mcp-session-pi",
        providerInstanceId: PI_INSTANCE_ID,
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer secret-pi-token",
        browserToolsAvailable: true,
      });
      const fake = yield* makeFakePi;
      yield* openRuntime(fake);
      const spawn = fake.lastSpawn();
      assert.isTrue(spawn.args.includes("--extension"));
      const extensions = spawn.args.flatMap((arg, index) =>
        arg === "--extension" ? [spawn.args[index + 1]] : [],
      );
      assert.isFalse(spawn.args.includes("--no-extensions"));
      assert.isTrue(extensions.some((path) => path?.endsWith("pi-t3-mcp-extension.ts")));
      assert.equal(spawn.env.T3_MCP_URL, "http://127.0.0.1:43123/mcp");
      assert.equal(spawn.env.T3_MCP_BEARER_TOKEN, "secret-pi-token");
      assert.equal(spawn.env.T3_PI_RUNTIME_MODE, "full-access");
    }).pipe(
      Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(THREAD_ID))),
      Effect.scoped,
      Effect.provide(testLayer),
    ),
  );

  it.effect("registers the thread from get_state and resumes via switch_session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      assert.equal(providerThread.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
      assert.equal(providerThread.driver, PI_PROVIDER);
      assert.isFalse(fake.lastSpawn().args.includes("--no-extensions"));

      yield* runtime.resumeThread({ providerThread });
      const switchRequest = yield* fake.takeRequest("switch_session");
      assert.equal(switchRequest["sessionPath"], FAKE_SESSION_FILE);

      yield* startTurn(runtime, providerThread, "anthropic/claude-sonnet");
      const setModel = yield* fake.takeRequest("set_model");
      assert.equal(setModel["provider"], "anthropic");
      assert.equal(runtime.providerSession.model, "anthropic/claude-sonnet");
      yield* fake.takeRequest("prompt");
      const error = yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterResumeThreadError");
      assert.match(String(error.cause), /while a turn is active/);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("adopts the run's provider thread identity instead of minting a second row", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const now = yield* DateTime.now;
      // The placeholder row the orchestrator creates for a first run: no
      // native identity yet. The adapter must bind the pi session to this
      // row instead of registering a second session-file-keyed row, or the
      // projection ends up with two live rows per app thread.
      const placeholder: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("thread:provider:pi:native-thread:pending:run:thread-pi-test:1"),
        driver: PI_PROVIDER,
        providerInstanceId: PI_INSTANCE_ID,
        providerSessionId: SESSION_ID,
        appThreadId: THREAD_ID,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: placeholder,
      });
      assert.equal(providerThread.id, placeholder.id);
      assert.equal(providerThread.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
      const updated = yield* takeEvent((event) => event.type === "provider_thread.updated");
      assert.isTrue(
        updated.type === "provider_thread.updated" && updated.providerThread.id === placeholder.id,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resets applied thinking when returning to Pi default", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueState({
        model: { provider: "xai", id: "grok-4.6" },
        thinkingLevel: "medium",
        sessionFile: FAKE_SESSION_FILE,
        sessionId: "abc",
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      // An explicit effort on a concrete model.
      yield* startTurn(runtime, providerThread, "default", [], "Hello pi", {
        instanceId: PI_INSTANCE_ID,
        model: "xai/grok-4.6",
        options: [{ id: "thinking", value: "high" }],
      });
      const modelRequest = yield* fake.takeRequest("set_model");
      assert.equal(modelRequest["provider"], "xai");
      assert.equal(modelRequest["modelId"], "grok-4.6");
      const levelRequest = yield* fake.takeRequest("set_thinking_level");
      assert.equal(levelRequest["level"], "high");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");

      // Back to Pi default with no explicit thinking choice of its own.
      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Hello pi",
        {
          instanceId: PI_INSTANCE_ID,
          model: "default",
        },
        2,
      );
      const replayModel = yield* fake.takeRequest("set_model");
      assert.equal(replayModel["provider"], "xai");
      assert.equal(replayModel["modelId"], "grok-4.6");
      const resetLevel = yield* fake.takeRequest("set_thinking_level");
      assert.equal(resetLevel["level"], "medium");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("expands a selected $ skill through Pi's native skill command", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueCommands({
        commands: [
          {
            name: "skill:repo-review",
            description: "Review this repository.",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/repo-review/SKILL.md",
              scope: "project",
            },
          },
        ],
      });
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Review this change please $repo-review",
      );
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/skill:repo-review Review this change please");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("expands every selected $ skill through Pi native skill commands", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueCommands({
        commands: [
          {
            name: "skill:repo-review",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/repo-review/SKILL.md",
              scope: "project",
            },
          },
          {
            name: "skill:deploy",
            source: "skill",
            sourceInfo: {
              path: "/workspace/.agents/skills/deploy/SKILL.md",
              scope: "project",
            },
          },
        ],
      });
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "use $repo-review and $deploy");
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/skill:repo-review /skill:deploy use and");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("streams assistant text and settles a completed turn on agent_settled", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "Hello pi");
      // Fire-and-forget: extension slash commands can hold the ack open on a
      // user dialog, so the prompt must carry no correlation id to await.
      assert.equal(prompt["id"], undefined);

      // A normal prompt ack only confirms that Pi accepted the command. Agent
      // activity may follow it, so the adapter must still wait for settlement.
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
      });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
      });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello" },
      });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          stopReason: "stop",
        },
      });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      fake.queueStats({
        tokens: { input: 12_000, output: 500, cacheRead: 8_000, cacheWrite: 0, total: 20_500 },
        toolCalls: 3,
        contextUsage: { tokens: 20_500, contextWindow: 200_000, percent: 10.25 },
      });
      yield* fake.emit({ type: "agent_settled" });

      const assistantItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.streaming === false,
      );
      assert.isTrue(
        assistantItem.type === "turn_item.updated" &&
          assistantItem.turnItem.type === "assistant_message" &&
          assistantItem.turnItem.text === "Hello",
      );
      // Session stats ride on the settled provider turn so the shared meter
      // picks them up through the base's per-turn `tokenUsage` (#8144).
      const completedTurn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      const { updatedAt, ...tokenUsage } =
        completedTurn.type === "provider_turn.updated"
          ? (completedTurn.providerTurn.tokenUsage ?? {})
          : {};
      assert.isString(updatedAt);
      assert.deepEqual(tokenUsage, {
        usedTokens: 20_500,
        maxTokens: 200_000,
        inputTokens: 12_000,
        cachedInputTokens: 8_000,
        outputTokens: 500,
      });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      // An acknowledged stats request can still omit usable window values.
      // That turn then carries no report, so the meter keeps the last one.
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      fake.queueStats({ contextUsage: { tokens: null, contextWindow: 200_000 } });
      yield* fake.emit({ type: "agent_settled" });
      const unreportedTurn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      assert.isUndefined(
        unreportedTurn.type === "provider_turn.updated"
          ? unreportedTurn.providerTurn.tokenUsage
          : null,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("captures session-tree refs at turn boundaries and rolls back via fork", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      // First get_entries ack baselines the leaf during ensureThread; the
      // second answers the finalize capture with this turn's user entry.
      fake.queueEntries({ entries: [], leafId: "leaf-0" });
      fake.queueEntries({
        entries: [{ type: "message", id: "u1", message: { role: "user" } }],
        leafId: "a1",
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const finalTurn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
      );
      yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        finalTurn.type === "provider_turn.updated" &&
          finalTurn.providerTurn.nativeTurnRef?.nativeId === "u1" &&
          finalTurn.providerTurn.nativeTurnRef.strength === "strong",
      );

      const turnRef = (ordinal: number, nativeId: string): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`provider-turn:test:${ordinal}`),
        providerThreadId: providerThread.id,
        nodeId: NodeId.make(`node:test:${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId, strength: "strong" },
        ordinal,
        status: "completed",
        startedAt: null,
        completedAt: null,
      });
      const rollbackSnapshot = yield* runtime.rollbackThread({
        providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint:test:1"),
          appRunOrdinal: 1,
          providerTurn: turnRef(1, "u1"),
        },
        providerThreadTurns: [turnRef(1, "u1"), turnRef(2, "u2")],
      });
      const fork = yield* fake.takeRequest("fork");
      assert.equal(fork["entryId"], "u2");
      assert.equal(rollbackSnapshot.providerThread.id, providerThread.id);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("observes official subagent results without inventing child threads", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_sub",
        toolName: "subagent",
        partialResult: {
          content: [{ type: "text", text: "(running...)" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stderr: "",
                sessionFile: "/ignored/custom-extension-session.jsonl",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "scanning files" }] },
                ],
              },
            ],
          },
        },
      });
      const running = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "running",
      );
      assert.isTrue(
        running.type === "subagent.updated" &&
          running.subagent.title === "scout" &&
          running.subagent.prompt === "map the repo" &&
          running.subagent.progress === "scanning files" &&
          running.subagent.childThreadId === null,
      );

      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_sub",
        toolName: "subagent",
        isError: false,
        result: {
          content: [{ type: "text", text: "done" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stopReason: "stop",
                stderr: "",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "repo has one file" }] },
                ],
              },
            ],
          },
        },
      });
      const doneCard = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
      );
      assert.isTrue(
        doneCard.type === "subagent.updated" &&
          doneCard.subagent.result === "repo has one file" &&
          doneCard.subagent.childThreadId === null,
      );
      const subagentItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        subagentItem.type === "turn_item.updated" &&
          subagentItem.turnItem.type === "subagent" &&
          subagentItem.turnItem.childThreadId === null,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("settles a command-only prompt from its deferred ack and idle probe", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/command-only");
      yield* fake.takeRequest("prompt");
      // A pure extension command: dialog + notify, then the deferred ack —
      // pi emits no agent_start/agent_settled at all.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-cmd",
        method: "notify",
        message: "done",
        notifyType: "info",
      });
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      // The adapter probes get_state (auto-acked idle by the fake), then
      // settles the turn as completed.
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("sends RPC compact for /compact instead of a prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact keep the auth rewrite");
      const compact = yield* fake.takeRequest("compact");
      assert.equal(compact["customInstructions"], "keep the auth rewrite");
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "prompt"));
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      const completed = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        completed.type === "turn_item.updated" &&
          completed.turnItem.type === "compaction" &&
          completed.turnItem.title === "Context compacted",
      );
      yield* fake.emit({ type: "response", command: "compact", success: true });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("leaves /compacted as an ordinary prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compacted please");
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/compacted please");
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "compact"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a too-small compact as a failed compaction item", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact");
      yield* fake.takeRequest("compact");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: null,
        aborted: false,
        errorMessage: "Compaction failed: Nothing to compact (session too small)",
      });
      const failed = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "failed",
      );
      assert.isTrue(
        failed.type === "turn_item.updated" &&
          failed.turnItem.type === "compaction" &&
          failed.turnItem.title === "Context compaction failed",
      );
      yield* fake.emit({
        type: "response",
        command: "compact",
        success: false,
        error: "Nothing to compact (session too small)",
      });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails a compact that never started", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact");
      yield* fake.takeRequest("compact");
      yield* fake.emit({
        type: "response",
        command: "compact",
        success: false,
        error: "Nothing to compact (session too small)",
      });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message === "Nothing to compact (session too small)",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("restarts Pi when Stop interrupts a user compact", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact");
      yield* fake.takeRequest("compact");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "abort"));
      yield* fake.closeStdout;
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("steers /compact as RPC compact instead of a prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      yield* fake.emit({ type: "agent_start" });
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:steer-compact" as never,
          text: "/compact keep the tests",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const compact = yield* fake.takeRequest("compact");
      assert.equal(compact["customInstructions"], "keep the tests");
      assert.isUndefined(compact["streamingBehavior"]);
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.emit({ type: "response", command: "compact", success: true });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("persists current xAI capacity text for the thread error banner", () =>
    expectModelFailure("The model is currently at capacity due to high demand."),
  );

  it.effect("persists extension-normalized xAI capacity text for the thread error banner", () =>
    expectModelFailure(
      "Provider overloaded: The model is currently at capacity due to high demand.",
    ),
  );

  it.effect("stops with restart by aborting and then terminating the process", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: providerTurnId!,
        requestRuntimeRestart: true,
      });
      yield* fake.takeRequest("abort");
      // The fake process cannot die; pi settling still closes the turn as
      // interrupted rather than failed.
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
      yield* fake.closeStdout;
      const stopped = yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "stopped",
      );
      assert.equal(
        stopped.type === "provider_session.updated" ? stopped.providerSession.lastError : undefined,
        null,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("emits session-start dialogs before a turn exists", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      // Project-trust style prompt before any turn exists.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({ requestId: requestId!, decision: "accept" });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-trust");
      assert.equal(uiResponse["confirmed"], true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reads a thread snapshot from pi's active branch", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueMessages({
        messages: [
          {
            role: "user",
            content: "hello pi",
            timestamp: 1700000000000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "hello back" }],
            timestamp: 1700000001000,
          },
          { role: "toolResult", content: [] },
        ],
      });
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(snapshot.messages.length, 2);
      assert.equal(snapshot.messages[0]!.role, "user");
      assert.equal(snapshot.messages[0]!.text, "hello pi");
      assert.equal(snapshot.messages[1]!.role, "assistant");
      assert.equal(snapshot.messages[1]!.text, "hello back");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("steers the active turn through pi's native steer command", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });

      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:steer" as never,
          text: "Focus on tests",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const steer = yield* fake.takeRequest("prompt");
      assert.equal(steer["message"], "Focus on tests");
      assert.equal(steer["streamingBehavior"], "steer");

      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:command" as never,
          text: "/my-command",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const command = yield* fake.takeRequest("prompt");
      assert.equal(command["message"], "/my-command");

      yield* fake.emit({ type: "agent_settled" });
      const firstTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(firstTerminal.type === "turn.terminal" && firstTerminal.status === "completed");

      yield* startTurn(runtime, providerThread, "default", [], "Second turn", undefined, 2);
      yield* fake.takeRequest("prompt");
      // The slash command's response belongs to the settled first turn. It
      // must not consume or fail the second turn's prompt acknowledgement.
      yield* fake.emit({
        type: "response",
        command: "prompt",
        success: false,
        error: "late command rejection",
      });
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const secondTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        secondTerminal.type === "turn.terminal" && secondTerminal.status === "completed",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows compaction progress and completes the same activity row", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "compaction_start", reason: "threshold" });

      const runningNode = yield* takeEvent(
        (event) => event.type === "node.updated" && event.node.kind === "system",
      );
      const runningItem = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      assert.isTrue(
        runningNode.type === "node.updated" &&
          runningNode.node.status === "running" &&
          runningItem.type === "turn_item.updated" &&
          runningItem.turnItem.type === "compaction" &&
          runningItem.turnItem.status === "running" &&
          runningItem.turnItem.title === "Compacting context...",
      );

      yield* fake.emit({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "smaller", tokensBefore: 200_000, estimatedTokensAfter: 3_400 },
        aborted: false,
        willRetry: false,
      });
      const completedNode = yield* takeEvent(
        (event) => event.type === "node.updated" && event.node.kind === "system",
      );
      const completedItem = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      assert.isTrue(
        runningNode.type === "node.updated" &&
          completedNode.type === "node.updated" &&
          runningItem.type === "turn_item.updated" &&
          runningItem.turnItem.type === "compaction" &&
          completedItem.type === "turn_item.updated" &&
          completedItem.turnItem.type === "compaction" &&
          completedNode.node.id === runningNode.node.id &&
          completedNode.node.status === "completed" &&
          completedItem.turnItem.id === runningItem.turnItem.id &&
          completedItem.turnItem.ordinal === runningItem.turnItem.ordinal &&
          completedItem.turnItem.startedAt === runningItem.turnItem.startedAt &&
          completedItem.turnItem.status === "completed" &&
          completedItem.turnItem.title === "Context compacted" &&
          completedItem.turnItem.beforeTokenCount === 200_000 &&
          completedItem.turnItem.afterTokenCount === 3_400,
      );

      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("uses distinct compaction IDs for first turns in separate threads", () =>
    Effect.gen(function* () {
      const firstFake = yield* makeFakePi;
      const { runtime: firstRuntime, takeEvent: takeFirstEvent } = yield* openRuntime(firstFake);
      const firstProviderThread = yield* firstRuntime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(firstRuntime, firstProviderThread);
      yield* firstFake.takeRequest("prompt");
      yield* firstFake.emit({ type: "agent_start" });
      yield* firstFake.emit({ type: "compaction_start", reason: "threshold" });
      const first = yield* takeFirstEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      const secondThreadId = ThreadId.make("thread-pi-test-second");
      const secondFake = yield* makeFakePi;
      const { runtime: secondRuntime, takeEvent: takeSecondEvent } = yield* openRuntime(
        secondFake,
        "default",
        secondThreadId,
        ProviderSessionId.make("provider-session-pi-test-second"),
      );
      const secondProviderThread = yield* secondRuntime.ensureThread({
        threadId: secondThreadId,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(
        secondRuntime,
        secondProviderThread,
        "default",
        [],
        "Hello from another thread",
        undefined,
        1,
        secondThreadId,
      );
      yield* secondFake.takeRequest("prompt");
      yield* secondFake.emit({ type: "agent_start" });
      yield* secondFake.emit({ type: "compaction_start", reason: "threshold" });
      const second = yield* takeSecondEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      assert.isTrue(
        first.type === "turn_item.updated" &&
          first.turnItem.type === "compaction" &&
          second.type === "turn_item.updated" &&
          second.turnItem.type === "compaction" &&
          first.turnItem.ordinal === second.turnItem.ordinal &&
          first.turnItem.id !== second.turnItem.id,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows aborted compactions as stopped", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      const running = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: null,
        aborted: true,
      });
      const stopped = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      assert.isTrue(
        running.type === "turn_item.updated" &&
          running.turnItem.type === "compaction" &&
          stopped.type === "turn_item.updated" &&
          stopped.turnItem.type === "compaction" &&
          stopped.turnItem.id === running.turnItem.id &&
          stopped.turnItem.status === "cancelled" &&
          stopped.turnItem.title === "Context compaction stopped",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the turn open and updates one retry row through final failure", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: true });
      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 3_000,
        errorMessage: "529 overloaded",
      });
      const firstRetry = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          firstRetry.turnItem.status === "running" &&
          firstRetry.turnItem.title === "Provider retry" &&
          firstRetry.turnItem.failure.retryable === true &&
          firstRetry.turnItem.retry?.attempt === 1 &&
          firstRetry.turnItem.retry.maxAttempts === 3 &&
          firstRetry.turnItem.retry.retryDelayMs === 3_000,
      );

      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 3,
        maxAttempts: 3,
        delayMs: 12_000,
        errorMessage: "529 still overloaded",
      });
      const lastRetry = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          lastRetry.type === "turn_item.updated" &&
          lastRetry.turnItem.type === "error" &&
          lastRetry.turnItem.id === firstRetry.turnItem.id &&
          lastRetry.turnItem.startedAt === firstRetry.turnItem.startedAt &&
          lastRetry.turnItem.retry?.attempt === 3,
      );

      yield* fake.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "529 overloaded",
      });
      const failedRetry = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.status === "failed",
      );
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          failedRetry.type === "turn_item.updated" &&
          failedRetry.turnItem.type === "error" &&
          failedRetry.turnItem.id === firstRetry.turnItem.id &&
          failedRetry.turnItem.title === "Provider error" &&
          failedRetry.turnItem.failure.retryable === false &&
          failedRetry.turnItem.retry?.attempt === 3 &&
          failedRetry.turnItem.retry.maxAttempts === 3,
      );
      yield* fake.emit({ type: "agent_settled" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");
      assert.isTrue(
        firstRetry.type === "turn_item.updated" &&
          firstRetry.turnItem.type === "error" &&
          terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message.includes("overloaded") &&
          terminal.retry?.attempt === 3 &&
          terminal.retry.maxAttempts === 3 &&
          terminal.retryStartedAt === firstRetry.turnItem.startedAt,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("preserves exhausted retry failure through non-retrying compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 5,
        maxAttempts: 5,
        delayMs: 48_000,
        errorMessage: "socket timed out",
      });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      yield* fake.emit({
        type: "auto_retry_end",
        success: false,
        attempt: 5,
        finalError: "socket timed out",
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.status === "failed",
      );
      yield* fake.emit({ type: "compaction_start", reason: "threshold" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      yield* fake.emit({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "smaller", tokensBefore: 200_000, estimatedTokensAfter: 3_400 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.emit({ type: "agent_settled" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message === "socket timed out" &&
          terminal.retry?.attempt === 5 &&
          terminal.retry.maxAttempts === 5,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("marks retry progress recovered when Pi succeeds", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "temporary network failure",
        },
      });
      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 5,
        delayMs: 3_000,
        errorMessage: "temporary network failure",
      });
      const running = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      yield* fake.emit({ type: "auto_retry_end", success: true, attempt: 1 });
      const recovered = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        running.type === "turn_item.updated" &&
          running.turnItem.type === "error" &&
          recovered.type === "turn_item.updated" &&
          recovered.turnItem.type === "error" &&
          recovered.turnItem.id === running.turnItem.id &&
          recovered.turnItem.status === "completed" &&
          recovered.turnItem.title === "Provider recovered",
      );

      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("stops active retry progress when the turn is interrupted", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const runningTurn = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        runningTurn.type === "provider_turn.updated" ? runningTurn.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);

      yield* fake.emit({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 5,
        delayMs: 6_000,
        errorMessage: "temporary network failure",
      });
      const retrying = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      yield* fake.takeRequest("abort");
      yield* fake.emit({ type: "agent_settled" });

      const stopped = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
      );
      assert.isTrue(
        retrying.type === "turn_item.updated" &&
          retrying.turnItem.type === "error" &&
          stopped.type === "turn_item.updated" &&
          stopped.turnItem.type === "error" &&
          stopped.turnItem.id === retrying.turnItem.id &&
          stopped.turnItem.status === "interrupted" &&
          stopped.turnItem.title === "Provider retry stopped",
      );
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps extension-started compaction and recovery in the settled turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });

      // Extension ctx.compact() waits for this first settlement, then starts
      // compaction in a detached continuation.
      fake.queueState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      fake.queueState({ isStreaming: true, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      yield* fake.emit({ type: "agent_start" });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.takeRequest("get_state");

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps working after a settle probe fails before detached compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });

      fake.failNextState();
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("restarts Pi when Stop interrupts detached compaction", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      assert.equal(running.type, "provider_turn.updated");
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "agent_start" });

      fake.queueState({ isStreaming: false, isCompacting: true, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );

      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "abort"));
      yield* fake.closeStdout;
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("steers through an atomic prompt that can restart an idle Pi run", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;

      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:steer" as never,
          text: "Focus on tests",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const steer = yield* fake.takeRequest("prompt");
      assert.equal(steer["message"], "Focus on tests");
      assert.equal(steer["streamingBehavior"], "steer");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("ignores an idle snapshot made stale by a steer", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      assert.equal(running.type, "provider_turn.updated");
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "agent_start" });

      fake.deferNextState();
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:late-steer" as never,
          text: "Continue after settlement",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* fake.takeRequest("prompt");
      yield* fake.resolveDeferredState({
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
      });

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Recovered" },
      });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Recovered" }],
          stopReason: "stop",
        },
      });
      const assistantItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.streaming === false,
      );
      assert.isTrue(
        assistantItem.type === "turn_item.updated" &&
          assistantItem.turnItem.type === "assistant_message" &&
          assistantItem.turnItem.text === "Recovered",
      );

      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("PiRpc framing", () => {
  it.effect("reassembles records across chunk boundaries and strips CR", () =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const push = (text: string) =>
        Queue.offer(stdout, new TextEncoder().encode(text)).pipe(Effect.asVoid);
      yield* push('{"type":"agent_');
      yield* push('start"}\r\n{"type":"agent_settled"}\nnot json\n{"type":"queue_update"}\n');

      const first = yield* Queue.take(connection.events);
      assert.equal(first["type"], "agent_start");
      const second = yield* Queue.take(connection.events);
      assert.equal(second["type"], "agent_settled");
      const third = yield* Queue.take(connection.events);
      assert.equal(third["type"], "queue_update");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

// This fails before a provider transcript exists, so a replay fixture is not
// an honest fit. The boundary is the stdio transport seeing stdout end.
describe("PiRpc early process exit", () => {
  const makeHandle = (options: {
    readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>;
    readonly stderr: Stream.Stream<Uint8Array>;
  }) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(FAKE_PID),
      exitCode: options.exitCode,
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: options.stderr,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });

  it.effect("reports a nonzero exit code instead of an unexplained stdout close", () =>
    Effect.gen(function* () {
      const secret = "API_KEY=super-secret\n";
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            stderr: Stream.fromIterable([new TextEncoder().encode(secret)]),
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const error = yield* Queue.take(connection.events).pipe(Effect.flip);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "pi process exited with code 1");
      assert.isFalse((error.detail ?? "").includes("API_KEY"));
      assert.isFalse((error.detail ?? "").includes("super-secret"));
      assert.isFalse(error.message.includes("API_KEY"));
      assert.isFalse(error.message.includes("super-secret"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the unexplained stdout-close message when the process has not exited", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeHandle({
            exitCode: Effect.never,
            stderr: Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const fiber = yield* Effect.forkChild(Queue.take(connection.events).pipe(Effect.flip));
      yield* TestClock.adjust(Duration.millis(300));
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "pi process closed stdout");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the exit-code diagnosis when stdin breaks while exit is still pending", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(FAKE_PID),
            exitCode: Effect.sleep(Duration.millis(50)).pipe(
              Effect.andThen(Effect.succeed(ChildProcessSpawner.ExitCode(1))),
            ),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "stdin",
                description: "broken pipe",
              }),
            ),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const connection = yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const fiber = yield* Effect.forkChild(Queue.take(connection.events).pipe(Effect.flip));
      yield* TestClock.adjust(Duration.millis(300));
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "pi process exited with code 1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
