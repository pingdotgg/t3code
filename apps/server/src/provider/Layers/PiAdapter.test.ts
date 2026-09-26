import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import type { PiRpcRecord } from "../PiRpc.ts";
import { T3_PI_RUNTIME_MODE_ENV } from "../piT3McpExtensionSource.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-adapter-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const decodeRecordLine = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PI_INSTANCE_ID = ProviderInstanceId.make("pi");
const THREAD_ID = ThreadId.make("thread-pi-adapter");
const SESSION_FILE = "/fake/.pi/agent/sessions/--workspace--/0001.jsonl";
/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

const settings = { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] };

type RuntimeEventOf<T extends ProviderRuntimeEvent["type"]> = Extract<
  ProviderRuntimeEvent,
  { type: T }
>;

/**
 * In-process fake `pi --mode rpc`: captures every stdin record, answers
 * correlated requests like Pi 0.87, and lets tests push protocol events.
 */
const makeFakePi = Effect.fnUntraced(function* (initialSessionFile: string) {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<PiRpcRecord>();
  const entries: Array<unknown> = [];
  const stats: Array<unknown> = [];
  let sessionFile = initialSessionFile;
  let forks = 0;
  let stdinBuffer = "";
  let lastSpawn: { args: ReadonlyArray<string>; env: NodeJS.ProcessEnv } = { args: [], env: {} };

  const emit = (record: PiRpcRecord) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`)).pipe(
      Effect.asVoid,
    );

  const respond = (record: PiRpcRecord): PiRpcRecord | undefined => {
    if (typeof record["id"] !== "string") return undefined;
    const base = { type: "response", id: record["id"], command: record["type"], success: true };
    switch (record["type"]) {
      case "get_state":
        return {
          ...base,
          data: {
            model: { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 200_000 },
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
            sessionFile,
          },
        };
      case "set_model":
        return {
          ...base,
          data: { provider: record["provider"], id: record["modelId"], contextWindow: 400_000 },
        };
      case "get_entries":
        return { ...base, data: entries.shift() ?? { entries: [], leafId: null } };
      case "get_session_stats":
        return { ...base, data: stats.shift() ?? {} };
      case "get_commands":
        return { ...base, data: { commands: [] } };
      case "fork":
        sessionFile = `/fake/fork-${++forks}.jsonl`;
        return { ...base, data: { text: "forked", cancelled: false } };
      default:
        return base;
    }
  };

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) {
        lastSpawn = { args: command.args, env: command.options.env ?? {} };
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            stdinBuffer += new TextDecoder().decode(chunk);
            let newline = stdinBuffer.indexOf("\n");
            while (newline !== -1) {
              const record = decodeRecordLine(stdinBuffer.slice(0, newline));
              stdinBuffer = stdinBuffer.slice(newline + 1);
              yield* Queue.offer(requests, record);
              const response = respond(record);
              if (response !== undefined) yield* emit(response);
              newline = stdinBuffer.indexOf("\n");
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  return {
    spawner,
    emit,
    /** Next stdin record of this type; earlier records of other types are skipped. */
    takeRequest: (type: string) =>
      Effect.gen(function* () {
        while (true) {
          const record = yield* Queue.take(requests);
          if (record["type"] === type) return record;
        }
      }),
    queueEntries: (data: unknown) => entries.push(data),
    queueStats: (data: unknown) => stats.push(data),
    lastSpawn: () => lastSpawn,
  };
});

const makeHarness = Effect.fnUntraced(function* (sessionFile = SESSION_FILE) {
  const fake = yield* makeFakePi(sessionFile);
  const adapter = yield* makePiAdapter(settings, {
    environment: {},
    instanceId: PI_INSTANCE_ID,
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  const takeEvent = <T extends ProviderRuntimeEvent["type"]>(type: T) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === type) return event as RuntimeEventOf<T>;
      }
    });
  /** Every event up to and including the next one of this type. */
  const takeEventsThrough = (type: ProviderRuntimeEvent["type"]) =>
    Effect.gen(function* () {
      const seen: Array<ProviderRuntimeEvent> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (event.type === type) return seen;
      }
    });
  return { fake, adapter, takeEvent, takeEventsThrough };
});

describe("PiAdapter", () => {
  it.effect("runs a Pi turn and settles it only once Pi reports idle", () =>
    Effect.gen(function* () {
      const { fake, adapter, takeEvent } = yield* makeHarness();
      fake.queueEntries({ entries: [], leafId: "leaf-0" });
      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        title: "Pi test",
      });
      assert.equal((yield* fake.takeRequest("set_session_name"))["name"], "Pi test");
      const spawn = fake.lastSpawn();
      assert.deepEqual(spawn.args.slice(0, 2), ["--mode", "rpc"]);
      assert.isTrue(spawn.args.at(-1)?.endsWith("pi-t3-mcp-extension.ts"));
      assert.notInclude(spawn.args, "--session");
      assert.equal(spawn.env[T3_PI_RUNTIME_MODE_ENV], "approval-required");
      assert.equal((yield* takeEvent("thread.started")).payload.providerThreadId, SESSION_FILE);

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Hello pi",
        modelSelection: {
          instanceId: PI_INSTANCE_ID,
          model: "openai/gpt-5",
          options: [{ id: "thinking", value: "high" }],
        },
      });
      const setModel = yield* fake.takeRequest("set_model");
      assert.deepInclude(setModel, { provider: "openai", modelId: "gpt-5" });
      assert.equal((yield* fake.takeRequest("set_thinking_level"))["level"], "high");
      assert.equal((yield* fake.takeRequest("prompt"))["message"], "Hello pi");
      assert.equal((yield* takeEvent("turn.started")).turnId, turn.turnId);

      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi there" },
      });
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls" },
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "README.md" }], details: { exitCode: 0 } },
        isError: false,
      });
      yield* fake.emit({
        type: "message_end",
        message: { role: "assistant", usage: { totalTokens: 1_200, input: 1_000, output: 200 } },
      });
      fake.queueEntries({
        entries: [
          { type: "model_change", id: "model-1" },
          { type: "message", id: "user-1", message: { role: "user" } },
        ],
        leafId: "leaf-1",
      });
      fake.queueStats({
        contextUsage: { tokens: 1_300, contextWindow: 400_000 },
        tokens: { input: 1_000, output: 300 },
      });
      yield* fake.emit({ type: "agent_settled" });

      const delta = yield* takeEvent("content.delta");
      assert.deepEqual(delta.payload, { streamKind: "assistant_text", delta: "Hi there" });
      const tool = yield* takeEvent("item.completed");
      assert.equal(tool.payload.itemType, "command_execution");
      assert.deepInclude(tool.payload.data as object, { command: "ls", result: "README.md" });
      assert.equal(
        (yield* takeEvent("thread.token-usage.updated")).payload.usage.maxTokens,
        400_000,
      );
      // The turn's user entry is read relative to the leaf baselined at start.
      assert.equal((yield* fake.takeRequest("get_entries"))["since"], "leaf-0");
      const settledUsage = yield* takeEvent("thread.token-usage.updated");
      assert.equal(settledUsage.payload.usage.usedTokens, 1_300);
      const completed = yield* takeEvent("turn.completed");
      assert.equal(completed.turnId, turn.turnId);
      assert.equal(completed.payload.state, "completed");

      const [session] = yield* adapter.listSessions();
      assert.deepEqual(session?.resumeCursor, {
        schemaVersion: 1,
        sessionFile: SESSION_FILE,
        turnEntryIds: ["user-1"],
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resumes the session file at spawn and rolls back through a native fork", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-sessions-" });
      const sessionFile = `${dir}/resume.jsonl`;
      yield* fs.writeFileString(sessionFile, "");
      const { fake, adapter } = yield* makeHarness(sessionFile);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionFile, turnEntryIds: ["user-1", "", "user-3"] },
      });
      const args = fake.lastSpawn().args;
      assert.deepEqual(args.slice(args.indexOf("--session")), ["--session", sessionFile]);

      // Turn 2 added no user message (a /compact), so the fork boundary for
      // discarding turns 2 and 3 is turn 3's first user message.
      yield* adapter.rollbackThread(THREAD_ID, 2);
      assert.equal((yield* fake.takeRequest("fork"))["entryId"], "user-3");
      const [session] = yield* adapter.listSessions();
      assert.deepEqual(session?.resumeCursor, {
        schemaVersion: 1,
        sessionFile: "/fake/fork-1.jsonl",
        turnEntryIds: ["user-1"],
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("continues in a fresh Pi session when the resumed file is gone", () =>
    Effect.gen(function* () {
      const { fake, adapter, takeEvent } = yield* makeHarness();
      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          sessionFile: "/fake/deleted.jsonl",
          turnEntryIds: ["user-1"],
        },
      });
      assert.notInclude(fake.lastSpawn().args, "--session");
      assert.include(
        (yield* takeEvent("runtime.warning")).payload.message,
        "without earlier context",
      );
      const [session] = yield* adapter.listSessions();
      assert.deepEqual(session?.resumeCursor, {
        schemaVersion: 1,
        sessionFile: SESSION_FILE,
        turnEntryIds: [],
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("starts fresh without a warning when Pi never wrote the session file", () =>
    Effect.gen(function* () {
      const { fake, adapter, takeEventsThrough } = yield* makeHarness();
      // Pi writes a session file only once it holds a user or assistant
      // message. A first prompt Pi rejected leaves the cursor naming a file
      // that never existed, and there is no earlier context to lose.
      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          sessionFile: "/fake/never-written.jsonl",
          turnEntryIds: [""],
        },
      });
      assert.notInclude(fake.lastSpawn().args, "--session");
      const started = yield* takeEventsThrough("thread.started");
      assert.notInclude(
        started.map((event) => event.type),
        "runtime.warning",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("asks for approval once per session when the user accepts for the session", () =>
    Effect.gen(function* () {
      const { fake, adapter, takeEvent } = yield* makeHarness();
      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Edit the file" });
      yield* fake.takeRequest("prompt");
      const confirm = {
        type: "extension_ui_request",
        method: "confirm",
        title: "Allow edit?",
        message: '{ "path": "README.md" }',
      };
      yield* fake.emit({ ...confirm, id: "ui-1" });
      const opened = yield* takeEvent("request.opened");
      assert.equal(opened.payload.requestType, "file_change_approval");
      assert.isDefined(opened.requestId);
      yield* adapter.respondToRequest(
        THREAD_ID,
        ApprovalRequestId.make(opened.requestId!),
        "acceptForSession",
      );
      assert.deepInclude(yield* fake.takeRequest("extension_ui_response"), {
        id: "ui-1",
        confirmed: true,
      });
      assert.equal((yield* takeEvent("request.resolved")).payload.decision, "acceptForSession");

      // The identical confirmation is answered without asking again.
      yield* fake.emit({ ...confirm, id: "ui-2" });
      assert.deepInclude(yield* fake.takeRequest("extension_ui_response"), {
        id: "ui-2",
        confirmed: true,
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("runs /compact as RPC compaction and settles it without an agent run", () =>
    Effect.gen(function* () {
      const { fake, adapter, takeEvent } = yield* makeHarness();
      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/compact keep tests" });
      assert.deepInclude(yield* fake.takeRequest("compact"), {
        customInstructions: "keep tests",
      });
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* fake.emit({
        type: "compaction_end",
        result: { summary: "Summary", tokensBefore: 90_000, estimatedTokensAfter: 12_000 },
      });
      yield* fake.emit({ type: "response", command: "compact", success: true });

      const compacted = yield* takeEvent("thread.state.changed");
      assert.deepEqual(compacted.payload, {
        state: "compacted",
        beforeTokens: 90_000,
        afterTokens: 12_000,
      });
      const completed = yield* takeEvent("turn.completed");
      assert.equal(completed.turnId, turn.turnId);
      assert.equal(completed.payload.state, "completed");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("releases a pending approval before aborting a stopped turn", () =>
    Effect.gen(function* () {
      const { fake, adapter, takeEvent } = yield* makeHarness();
      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Run the tests" });
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-1",
        method: "confirm",
        title: "Allow bash?",
        message: '{ "command": "vp test" }',
      });
      yield* takeEvent("request.opened");

      yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
      assert.deepInclude(yield* fake.takeRequest("extension_ui_response"), {
        id: "ui-1",
        cancelled: true,
      });
      yield* fake.takeRequest("abort");
      assert.equal((yield* takeEvent("request.resolved")).payload.decision, "cancel");
      // No agent_settled arrives; the answered abort alone completes the turn.
      const completed = yield* takeEvent("turn.completed");
      assert.equal(completed.turnId, turn.turnId);
      assert.equal(completed.payload.state, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("stops Pi when it starts work outside a T3 turn", () =>
    Effect.gen(function* () {
      const { fake, adapter, takeEvent } = yield* makeHarness();
      yield* adapter.startSession({
        threadId: THREAD_ID,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* fake.emit({ type: "agent_start" });
      const exited = yield* takeEvent("session.exited");
      assert.equal(exited.payload.exitKind, "error");
      assert.include(exited.payload.reason ?? "", "outside an active T3 turn");
      assert.isFalse(yield* adapter.hasSession(THREAD_ID));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
