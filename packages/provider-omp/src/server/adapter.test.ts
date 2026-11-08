import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeOmpAdapterV2 } from "./adapter.ts";
import { makeOmpRpcConnection, type OmpRpcRecord } from "./rpc.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const OMP_INSTANCE_ID = ProviderInstanceId.make("omp");
const THREAD_ID = ThreadId.make("thread-omp-test");
const SESSION_ID = ProviderSessionId.make("provider-session-omp-test");
const FAKE_SESSION_FILE = "/fake/.omp/agent/sessions/--workspace--/0001_abc.jsonl";
/** Deliberately outside the valid pid range so a group-kill can never land. */
const FAKE_PID = 999_999_999;

const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const modelSelection = (model: string): ModelSelection => ({
  instanceId: OMP_INSTANCE_ID,
  model,
});

const makeFakeOmp = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<OmpRpcRecord>();
  const emit = (record: OmpRpcRecord) =>
    Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`));
  let buffered = "";
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(FAKE_PID),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            buffered += new TextDecoder().decode(chunk);
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines.filter(Boolean)) {
              const record = decodeJsonLine(line) as OmpRpcRecord;
              yield* Queue.offer(requests, record);
              if (record["type"] === "extension_ui_response") continue;
              const data =
                record["type"] === "get_state"
                  ? {
                      sessionFile: FAKE_SESSION_FILE,
                      isStreaming: false,
                      isSettled: true,
                      hasPendingAsyncWork: false,
                      queuedMessageCount: 0,
                    }
                  : record["type"] === "get_entries"
                    ? { entries: [], leafId: null }
                    : record["type"] === "get_available_models"
                      ? { models: [] }
                      : {};
              yield* emit({
                type: "response",
                id: record["id"],
                command: record["type"],
                success: true,
                data,
              });
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  const takeRequest = (type: string) =>
    Effect.gen(function* () {
      while (true) {
        const request = yield* Queue.take(requests);
        if (request["type"] === type) return request;
      }
    });
  return { spawner, emit, takeRequest, closeStdout: Queue.end(stdout) };
});
type FakeOmp = Effect.Success<typeof makeFakeOmp>;
const makeAdapter = (fake: FakeOmp) =>
  makeOmpAdapterV2({
    instanceId: OMP_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
    environment: {},
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));

const openRuntime = Effect.fnUntraced(function* (
  fake: FakeOmp,
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
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
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
    projectId: "project:fixture:omp" as OrchestrationV2AppThread["projectId"],
    title: "Omp test thread",
    providerInstanceId: OMP_INSTANCE_ID,
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
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  model = "default",
  attachments: ReadonlyArray<ChatAttachment> = [],
  text = "Hello omp",
  selection?: ModelSelection,
  runOrdinal = 1,
  threadId = THREAD_ID,
  continuation = false,
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
      createdBy: continuation ? "agent" : "user",
      creationSource: continuation ? "provider" : "web",
    },
    modelSelection: selection ?? modelSelection(model),
    runtimePolicy,
  });
});

describe("OmpAdapterV2", () => {
  it.effect(
    "renders command-only output and reapplies the selected model and thinking after native config changes",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeOmp;
        const { runtime, takeEvent } = yield* openRuntime(fake, "openai/selected");
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("openai/selected"),
          runtimePolicy,
        });
        const selection = {
          ...modelSelection("openai/selected"),
          options: [{ id: "thinking", value: "high" }],
        };
        yield* startTurn(runtime, providerThread, "openai/selected", [], "/model", selection);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "command_output", text: "Current model: openai/native" });
        const notice = yield* takeEvent(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
        );
        assert.isTrue(
          notice.type === "turn_item.updated" &&
            notice.turnItem.type === "system_notice" &&
            notice.turnItem.message === "Current model: openai/native",
        );
        yield* fake.emit({
          type: "config_update",
          model: { provider: "openai", id: "native", contextWindow: 32000 },
          thinkingLevel: "low",
        });
        yield* fake.emit({
          type: "prompt_result",
          status: "completed",
          agentInvoked: false,
          sessionSettled: true,
        });
        yield* takeEvent((event) => event.type === "turn.terminal");
        yield* startTurn(runtime, providerThread, "openai/selected", [], "Next", selection, 2);
        const setModel = yield* fake.takeRequest("set_model");
        assert.equal(setModel["modelId"], "selected");
        const setThinking = yield* fake.takeRequest("set_thinking_level");
        assert.equal(setThinking["level"], "high");
        yield* fake.takeRequest("prompt");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("sends native compaction modes as unchanged prompt commands", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      let ordinal = 0;
      for (const mode of ["soft", "remote", "snapcompact"]) {
        yield* startTurn(
          runtime,
          providerThread,
          "default",
          [],
          `/compact ${mode}`,
          undefined,
          ++ordinal,
        );
        const prompt = yield* fake.takeRequest("prompt");
        assert.equal(prompt["message"], `/compact ${mode}`);
        yield* fake.emit({
          type: "prompt_result",
          status: "completed",
          agentInvoked: false,
          sessionSettled: true,
        });
        yield* takeEvent((event) => event.type === "turn.terminal");
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("keeps background work open until OMP reports session settlement", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", isTerminal: false, messages: [] });
      yield* fake.emit({ type: "prompt_result", status: "completed", sessionSettled: false });
      yield* fake.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "native-child",
          agent: "explore",
          description: "Inspect files",
          status: "started",
          parentToolCallId: "spawn",
        },
      });
      const child = yield* takeEvent(
        (event) => event.type === "subagent.updated" || event.type === "turn.terminal",
      );
      assert.isTrue(child.type === "subagent.updated" && child.subagent.status === "running");
      yield* fake.emit({
        type: "subagent_lifecycle",
        payload: {
          id: "native-child",
          agent: "explore",
          status: "completed",
          parentToolCallId: "spawn",
        },
      });
      yield* fake.emit({ type: "session_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.equal(terminal.type, "turn.terminal");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("cancels a native question when OMP sends its targetId", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "question",
        method: "ask",
        questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
      });
      yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      yield* fake.emit({
        type: "extension_ui_request",
        id: "cancel",
        method: "cancel",
        targetId: "question",
      });
      const cancelled = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
      );
      assert.equal(cancelled.type, "runtime_request.updated");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("emits session-start dialogs before a turn exists", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .omp/extensions.",
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
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("cancels startup dialogs when Omp exits before a turn exists", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "startup",
        method: "confirm",
        title: "Trust project?",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      if (pending.type !== "runtime_request.updated") return;
      yield* fake.closeStdout;
      const cancelled = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" &&
          event.runtimeRequest.id === pending.runtimeRequest.id &&
          event.runtimeRequest.status === "cancelled",
      );
      assert.isTrue(cancelled.type === "runtime_request.updated");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("raises bridge edit confirmations as file-change approvals", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      for (const [id, title, requestKind] of [
        ["ui-edit", "Allow edit?", "file-change"],
        ["ui-bash", "Allow bash?", "command"],
        ["ui-ext", "Deploy to staging?", "command"],
      ] as const) {
        yield* fake.emit({ type: "extension_ui_request", id, method: "confirm", title });
        const item = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        );
        assert.isTrue(
          item.type === "turn_item.updated" &&
            item.turnItem.type === "approval_request" &&
            item.turnItem.requestKind === requestKind,
          `${title} should be ${requestKind}`,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

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

  it.effect("fails closed when OMP cannot load the required permission bridge", () =>
    Effect.gen(function* () {
      const requiredExtensionPath = "/fixture/omp-t3-mcp-extension.ts";
      const connection = yield* makeOmpRpcConnection({
        command: "omp",
        args: [],
        cwd: undefined,
        env: {},
        requiredExtensionPath,
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed({
              ...makeHandle({
                exitCode: Effect.never,
                stderr: Stream.succeed(
                  new TextEncoder().encode(
                    `Failed to load extension ${requiredExtensionPath}: unavailable dependency secret-token`,
                  ),
                ),
              }),
              stdout: Stream.never,
            }),
          ),
        ),
      );
      const error = yield* Queue.take(connection.events).pipe(Effect.flip);
      assert.equal(error.operation, "extension");
      assert.notInclude(error.message, "secret-token");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

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
      const connection = yield* makeOmpRpcConnection({
        command: "omp",
        args: ["--mode", "rpc"],
        cwd: undefined,
        env: {},
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const error = yield* Queue.take(connection.events).pipe(Effect.flip);
      assert.equal(error._tag, "OmpRpcError");
      assert.equal(error.operation, "read");
      assert.equal(error.detail, "omp process exited with code 1");
      assert.isFalse((error.detail ?? "").includes("API_KEY"));
      assert.isFalse((error.detail ?? "").includes("super-secret"));
      assert.isFalse(error.message.includes("API_KEY"));
      assert.isFalse(error.message.includes("super-secret"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
