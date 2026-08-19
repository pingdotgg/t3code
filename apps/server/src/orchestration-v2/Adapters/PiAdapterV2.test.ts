import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
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
  /** Make the next `switch_session` ack report an extension veto. */
  readonly vetoNextSwitch: () => void;
  /** Data returned by the next `get_state` acks, consumed in order. */
  readonly queueState: (data: unknown) => void;
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
  const stateQueue: Array<unknown> = [];
  const statsQueue: Array<unknown> = [];
  const commandsQueue: Array<{ readonly success: boolean; readonly data?: unknown }> = [];
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
        yield* Queue.offer(requests, record);
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

const makeAdapter = Effect.fnUntraced(function* (fake: FakePi) {
  const idAllocator = yield* IdAllocatorV2;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  return makePiAdapterV2({
    instanceId: PI_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
    environment: {},
    spawner: fake.spawner,
    fileSystem,
    idAllocator,
    serverConfig,
  });
});

const openRuntime = Effect.fnUntraced(function* (fake: FakePi, model = "default") {
  const adapter = yield* makeAdapter(fake);
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
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

const makeAppThread = Effect.fnUntraced(function* (model: string) {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:fixture:pi" as OrchestrationV2AppThread["projectId"],
    title: "Pi test thread",
    providerInstanceId: PI_INSTANCE_ID,
    modelSelection: modelSelection(model),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
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
) {
  const appThread = yield* makeAppThread(model);
  yield* runtime.startTurn({
    appThread,
    threadId: THREAD_ID,
    runId: RunId.make("run:thread-pi-test:1"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("run-attempt:run:thread-pi-test:1:1"),
    rootNodeId: NodeId.make("node:run:thread-pi-test:1:root"),
    providerThread,
    message: {
      messageId: "message:thread-pi-test:1" as never,
      text,
      attachments,
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: modelSelection(model),
    runtimePolicy,
  });
});

describe("PiAdapterV2", () => {
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
      assert.isTrue(extensions.some((path) => path?.endsWith("pi-t3-subagent-extension.ts")));
      assert.isTrue(extensions.some((path) => path?.endsWith("pi-t3-mcp-extension.ts")));
      assert.equal(spawn.env.T3_MCP_URL, "http://127.0.0.1:43123/mcp");
      assert.equal(spawn.env.T3_MCP_BEARER_TOKEN, "secret-pi-token");
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
      const spawn = fake.lastSpawn();
      assert.isTrue(
        spawn.args.some(
          (arg, index) =>
            arg === "--extension" && spawn.args[index + 1]?.endsWith("pi-t3-subagent-extension.ts"),
        ),
      );

      yield* runtime.resumeThread({ providerThread });
      const switchRequest = yield* fake.takeRequest("switch_session");
      assert.equal(switchRequest["sessionPath"], FAKE_SESSION_FILE);

      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const error = yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterResumeThreadError");
      assert.match(String(error.cause), /while a turn is active/);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("drops the old thread binding when switched-session state is invalid", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      fake.queueState({ thinkingLevel: "medium" });
      const resumeError = yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      assert.equal(resumeError._tag, "ProviderAdapterResumeThreadError");
      assert.match(String(resumeError.cause), /neither sessionFile nor sessionId/);

      const turnError = yield* startTurn(runtime, providerThread).pipe(Effect.flip);
      assert.equal(turnError._tag, "ProviderAdapterTurnStartError");
      assert.match(String(turnError.cause), /no registered thread/);

      fake.queueState({ sessionFile: FAKE_SESSION_FILE, sessionId: "abc" });
      const resumed = yield* runtime.resumeThread({ providerThread });
      assert.equal(resumed.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the thread usable when an attachment cannot be read", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [
        {
          type: "image",
          id: "missingpiattachment",
          name: "missing.png",
          mimeType: "image/png",
          sizeBytes: 1,
        },
      ]).pipe(Effect.flip);

      // The failed turn was never installed, so the next one still starts.
      yield* startTurn(runtime, providerThread);
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "Hello pi");
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

  it.effect("retries skill discovery after a transient session-open failure", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.failNextCommands();
      const { runtime } = yield* openRuntime(fake);
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
        ],
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "$repo-review check this");
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/skill:repo-review check this");
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
      const usage = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.contextUsage?.usedTokens === 20_500,
      );
      assert.deepEqual(
        usage.type === "provider_thread.updated" ? usage.providerThread.contextUsage : null,
        {
          usedTokens: 20_500,
          totalProcessedTokens: 20_500,
          maxTokens: 200_000,
          inputTokens: 12_000,
          cachedInputTokens: 8_000,
          outputTokens: 500,
          toolUses: 3,
          compactsAutomatically: true,
        },
      );
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");

      // An acknowledged stats request can still omit usable window values.
      // Keep the last good snapshot instead of making the meter disappear.
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      fake.queueStats({ contextUsage: { tokens: null, contextWindow: 200_000 } });
      yield* fake.emit({ type: "agent_settled" });
      const preservedUsage = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.status === "idle" &&
          event.providerThread.contextUsage?.totalProcessedTokens === 20_500,
      );
      assert.equal(
        preservedUsage.type === "provider_thread.updated"
          ? preservedUsage.providerThread.contextUsage?.usedTokens
          : null,
        20_500,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("syncs the thread title into pi's session name before prompting", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      // takeRequest discards preceding records, so this also proves ordering.
      const setName = yield* fake.takeRequest("set_session_name");
      assert.equal(setName["name"], "Pi test thread");
      yield* fake.takeRequest("prompt");
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
      yield* runtime.rollbackThread({
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
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails a resume when an extension vetoes the session switch", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.vetoNextSwitch();
      const error = yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterResumeThreadError");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("delivers empty dialog answers as values and shows editor prefill", () =>
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
        type: "extension_ui_request",
        id: "ui-editor",
        method: "editor",
        title: "Edit the note",
        prefill: "line one\nline two",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      const requestItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      assert.isTrue(
        requestItem.type === "turn_item.updated" &&
          requestItem.turnItem.type === "user_input_request" &&
          requestItem.turnItem.questions[0]!.question.includes("Current value:\nline one"),
      );
      // An empty string clears the note; it must arrive as a value, not a cancel.
      yield* runtime.respondToRuntimeRequest({
        requestId: requestId!,
        answers: { "ui-editor": "" },
      });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["value"], "");
      assert.notProperty(uiResponse, "cancelled");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows failed compactions instead of dropping them", () =>
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
        type: "compaction_end",
        reason: "threshold",
        result: null,
        aborted: false,
        errorMessage: "API quota exceeded",
      });
      const compaction = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      assert.isTrue(
        compaction.type === "turn_item.updated" &&
          compaction.turnItem.type === "compaction" &&
          compaction.turnItem.status === "failed" &&
          compaction.turnItem.summary === "API quota exceeded",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("presents tools aborted by Stop as interrupted, not failed", () =>
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
        type: "tool_execution_start",
        toolCallId: "call_sleep",
        toolName: "bash",
        args: { command: "sleep 30" },
      });
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;

      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      yield* fake.takeRequest("abort");
      // Pi reports the aborted tool as an error end before settling.
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_sleep",
        toolName: "bash",
        isError: true,
        result: { content: [{ type: "text", text: "Command aborted" }] },
      });
      yield* fake.emit({ type: "agent_settled" });

      const toolItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "command_execution" &&
          event.turnItem.status !== "running",
      );
      assert.isTrue(
        toolItem.type === "turn_item.updated" && toolItem.turnItem.status === "interrupted",
      );
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("projects the subagent extension's tasks as native subagents", () =>
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
        type: "tool_execution_start",
        toolCallId: "call_sub",
        toolName: "subagent",
        args: { tasks: [{ agent: "scout", task: "map the repo" }] },
      });
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_sub",
        toolName: "subagent",
        partialResult: {
          content: [{ type: "text", text: "(running...)" }],
          details: {
            mode: "parallel",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                finished: false,
                exitCode: 0,
                stopReason: "toolUse",
                stderr: "",
                sessionFile: "/tmp/pi-children/scout.jsonl",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "scanning files" }] },
                ],
              },
              {
                agent: "worker",
                task: "broken task",
                finished: false,
                exitCode: -1,
                stderr: "",
                messages: [],
              },
            ],
          },
        },
      });
      const childThread = yield* takeEvent((event) => event.type === "app_thread.created");
      if (childThread.type !== "app_thread.created") {
        assert.fail("expected app_thread.created");
        return;
      }
      const childThreadId = childThread.appThread.id;
      const childProviderThread = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.appThreadId === childThreadId,
      );
      assert.isTrue(
        childProviderThread.type === "provider_thread.updated" &&
          childProviderThread.providerThread.nativeThreadRef?.nativeId ===
            "/tmp/pi-children/scout.jsonl" &&
          childProviderThread.providerThread.providerSessionId === null,
      );
      const running = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "running",
      );
      assert.isTrue(
        running.type === "subagent.updated" &&
          running.subagent.title === "scout" &&
          running.subagent.prompt === "map the repo" &&
          running.subagent.progress === "scanning files" &&
          running.subagent.childThreadId === childThreadId,
      );
      const queuedSibling = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.title === "worker",
      );
      assert.isTrue(
        queuedSibling.type === "subagent.updated" && queuedSibling.subagent.status === "running",
      );
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_sub",
        toolName: "subagent",
        isError: false,
        result: {
          content: [{ type: "text", text: "done" }],
          details: {
            mode: "parallel",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                finished: true,
                exitCode: 0,
                stopReason: "stop",
                stderr: "",
                sessionFile: "/tmp/pi-children/scout.jsonl",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "repo has one file" }] },
                ],
              },
              {
                agent: "worker",
                task: "broken task",
                finished: true,
                exitCode: 1,
                stderr: "boom",
                messages: [],
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
          doneCard.subagent.childThreadId === childThreadId,
      );
      // Completed turn_item is emitted immediately after the completed card;
      // waiting for the failed card first would consume it.
      const subagentItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        subagentItem.type === "turn_item.updated" &&
          subagentItem.turnItem.type === "subagent" &&
          subagentItem.turnItem.childThreadId === childThreadId,
      );
      const failedCard = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "failed",
      );
      assert.isTrue(
        failedCard.type === "subagent.updated" &&
          failedCard.subagent.title === "worker" &&
          failedCard.subagent.result === "boom" &&
          failedCard.subagent.childThreadId === null,
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
      yield* startTurn(runtime, providerThread);
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

  it.effect("fails the turn when pi rejects a fire-and-forget prompt", () =>
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
      yield* fake.emit({ type: "response", command: "prompt", success: false, error: "boom" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message === "boom",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the turn open across agent_end and fails it on final retry failure", () =>
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
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "529 overloaded",
      });
      yield* fake.emit({ type: "agent_settled" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "failed");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message.includes("overloaded"),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("interrupts with abort and settles the turn as interrupted", () =>
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
      assert.equal(running.type, "provider_turn.updated");
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);

      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      yield* fake.takeRequest("abort");
      yield* fake.emit({ type: "agent_settled" });

      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "applies an explicit model before prompting and skips set_model for the Pi default",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime } = yield* openRuntime(fake, "anthropic/claude-sonnet-5");
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("anthropic/claude-sonnet-5"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread, "anthropic/claude-sonnet-5");
        const setModel = yield* fake.takeRequest("set_model");
        assert.equal(setModel["provider"], "anthropic");
        assert.equal(setModel["modelId"], "claude-sonnet-5");
        yield* fake.takeRequest("prompt");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("bridges extension select dialogs to runtime requests and answers them", () =>
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
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: "Pick one",
        options: ["Allow", "Block"],
      });

      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      assert.isTrue(
        pending.type === "runtime_request.updated" && pending.runtimeRequest.kind === "user_input",
      );
      const requestItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      assert.isTrue(
        requestItem.type === "turn_item.updated" &&
          requestItem.turnItem.type === "user_input_request" &&
          requestItem.turnItem.questions[0]?.options.length === 2,
      );

      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({
        requestId: requestId!,
        answers: { "ui-1": "Allow" },
      });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-1");
      assert.equal(uiResponse["value"], "Allow");

      const resolved = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "resolved",
      );
      assert.equal(resolved.type, "runtime_request.updated");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("clears a stashed model error when compaction recovers the turn", () =>
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
      // Overflow surfaces as a model error, then pi compacts and retries.
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "400 too long",
        },
      });
      yield* fake.emit({
        type: "compaction_end",
        reason: "overflow",
        result: { summary: "compacted", tokensBefore: 520000, estimatedTokensAfter: 3400 },
        aborted: false,
        willRetry: true,
      });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
      });
      fake.queueStats({
        tokens: { input: 12_000, output: 500, cacheRead: 8_000, cacheWrite: 0, total: 20_500 },
        contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
      });
      yield* fake.emit({ type: "agent_settled" });
      const usage = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.contextUsage?.usedTokens === 3_400,
      );
      assert.equal(
        usage.type === "provider_thread.updated"
          ? usage.providerThread.contextUsage?.usedTokens
          : null,
        3_400,
      );
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
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

  it.live("defers session-start dialogs to the next turn instead of cancelling", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
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
      // Give the pump real time to buffer the dialog before the turn opens.
      yield* Effect.sleep("60 millis");
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
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

  it.effect("projects setStatus as a keyed live row and closes it on settle", () =>
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
        type: "extension_ui_request",
        id: "ui-s1",
        method: "setStatus",
        statusKey: "tps",
        statusText: "42 tok/s",
      });
      const row = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.toolName === "status",
      );
      assert.isTrue(
        row.type === "turn_item.updated" &&
          row.turnItem.type === "dynamic_tool" &&
          row.turnItem.status === "running" &&
          row.turnItem.nativeItemRef?.nativeId === `status:${row.turnItem.providerTurnId}:tps` &&
          (row.turnItem.input as { status?: string }).status === "42 tok/s",
      );
      yield* fake.emit({ type: "agent_settled" });
      const closed = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.toolName === "status" &&
          event.turnItem.status === "completed",
      );
      assert.equal(closed.type, "turn_item.updated");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses to open a subagent child session while its task is running", () =>
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
      const childFile = "/fake/.pi/agent/sessions/children/child-1.jsonl";
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_child",
        toolName: "subagent",
        partialResult: {
          content: [{ type: "text", text: "(running...)" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "worker",
                task: "long task",
                finished: false,
                exitCode: -1,
                stopReason: "toolUse",
                stderr: "",
                messages: [],
                sessionFile: childFile,
              },
            ],
          },
        },
      });
      yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "running",
      );
      const childThread: OrchestrationV2ProviderThread = {
        ...providerThread,
        nativeThreadRef: { driver: PI_PROVIDER, nativeId: childFile, strength: "strong" },
      };
      const error = yield* runtime.resumeThread({ providerThread: childThread }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterResumeThreadError");

      // A parent teardown releases every child lock, even when the tool never
      // emitted a final result (for example after provider transport loss).
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");
      fake.queueState({ sessionFile: childFile, sessionId: "child-1" });
      const resumed = yield* runtime.resumeThread({ providerThread: childThread });
      assert.equal(resumed.nativeThreadRef?.nativeId, childFile);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("forks a thread by cloning pi's session and switching back", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const cloneFile = "/fake/.pi/agent/sessions/--workspace--/0002_clone.jsonl";
      fake.queueState({ sessionFile: cloneFile, sessionId: "clone" });
      const forked = yield* runtime.forkThread({
        sourceProviderThread: providerThread,
        targetThreadId: ThreadId.make("thread-pi-fork-target"),
      });
      assert.equal(forked.nativeThreadRef?.nativeId, cloneFile);
      assert.isNull(forked.providerSessionId);
      yield* fake.takeRequest("clone");
      const switchBack = yield* fake.takeRequest("switch_session");
      assert.equal(switchBack["sessionPath"], FAKE_SESSION_FILE);

      fake.queueState({
        sessionFile: "/fake/.pi/agent/sessions/--workspace--/0003_clone.jsonl",
        sessionId: "clone-2",
      });
      fake.vetoNextSwitch();
      const error = yield* runtime
        .forkThread({
          sourceProviderThread: providerThread,
          targetThreadId: ThreadId.make("thread-pi-fork-vetoed"),
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterForkThreadError");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reads a thread snapshot from pi's session entries", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueEntries({
        entries: [
          {
            type: "message",
            id: "e1",
            message: { role: "user", content: "hello pi", timestamp: 1700000000000 },
          },
          {
            type: "message",
            id: "e2",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hello back" }],
              timestamp: 1700000001000,
            },
          },
          { type: "message", id: "e3", message: { role: "toolResult", content: [] } },
        ],
        leafId: "e2",
      });
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(snapshot.messages.length, 2);
      assert.equal(snapshot.messages[0]!.role, "user");
      assert.equal(snapshot.messages[0]!.text, "hello pi");
      assert.equal(snapshot.messages[1]!.role, "assistant");
      assert.equal(snapshot.messages[1]!.text, "hello back");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("cancels unanswered extension dialogs when the turn settles", () =>
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
        type: "extension_ui_request",
        id: "ui-2",
        method: "confirm",
        title: "Continue?",
        message: "Really continue?",
      });
      yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      yield* fake.emit({ type: "agent_settled" });

      const cancelledResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(cancelledResponse["id"], "ui-2");
      assert.equal(cancelledResponse["cancelled"], true);
      const cancelled = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
      );
      assert.equal(cancelled.type, "runtime_request.updated");
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
      const steer = yield* fake.takeRequest("steer");
      assert.equal(steer["message"], "Focus on tests");
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
