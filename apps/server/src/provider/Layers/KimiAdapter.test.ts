// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  KimiSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { KimiAdapterShape } from "../Services/KimiAdapter.ts";
import { makeKimiAdapter, selectDecisionPermissionOptionId } from "./KimiAdapter.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

// Test-local service tag so the rest of the file can keep using `yield* KimiAdapter`.
class KimiAdapter extends Context.Service<KimiAdapter, KimiAdapterShape>()(
  "t3/provider/Layers/KimiAdapter.test/KimiAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-agent",
    env: { T3_ACP_KIMI: "1", ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath, expectedArgs: ["acp"] }),
  });
}

async function makeProbeWrapper(requestLogPath: string, argvLogPath: string) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-probe-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-agent",
    env: {
      T3_ACP_KIMI: "1",
      T3_ACP_REQUEST_LOG_PATH: requestLogPath,
    },
    source: execScriptSource({
      scriptPath: mockAgentPath,
      expectedArgs: ["acp"],
      argvLogPath,
    }),
  });
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Tests mutate `ServerSettingsService` mid-flight (e.g. setting
// `providers.kimi.binaryPath` to a mock ACP wrapper). The adapter
// captures `kimiSettings` once at construction, so without a resolver
// the mutation is invisible — sessions would spawn the constructor's
// (empty) binary path.
const makeResolveKimiSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return yield* Effect.succeed(
    serverSettings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.providers.kimi),
      Effect.orDie,
    ),
  );
});

const kimiAdapterTestLayer = it.layer(
  Layer.effect(
    KimiAdapter,
    Effect.gen(function* () {
      const kimiConfig = decodeKimiSettings({});
      const resolveSettings = yield* makeResolveKimiSettings;
      return yield* makeKimiAdapter(kimiConfig, { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-kimi-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

kimiAdapterTestLayer("KimiAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-mock-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event: ProviderRuntimeEvent) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("kimi"),
          model: "kimi-code/kimi-for-coding",
        },
      });

      assert.equal(session.provider, "kimi");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello kimi", attachments: [] });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = new Set<string>(runtimeEvents.map((event) => event.type));
      for (const type of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ]) {
        assert.ok(types.has(type), `expected a ${type} event`);
      }
      const completed = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.equal(completed?.payload.state, "completed");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("classifies Agent and AgentSwarm tool calls as subagent rows", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-subagent-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_KIMI_EMIT_SUBAGENT_TOOL_CALLS: "1" }),
      );
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event: ProviderRuntimeEvent) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      yield* adapter.sendTurn({ threadId, input: "dispatch agents", attachments: [] });
      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const subagentRows = runtimeEvents.flatMap((event) =>
        event.type === "item.updated" || event.type === "item.completed"
          ? event.payload.itemType === "collab_agent_tool_call"
            ? [event.payload]
            : []
          : [],
      );
      assert.deepStrictEqual(
        subagentRows.map((payload) => [payload.title, payload.status]).toSorted(),
        [
          ["Agent swarm", "completed"],
          ["Subagent", "completed"],
        ],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("publishes kimi's advertised slash commands through onAvailableCommands", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-commands-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      const advertised: Array<string> = [];
      const commandsReceived = yield* Deferred.make<void>();
      const adapterWithCommands = yield* makeKimiAdapter(decodeKimiSettings({}), {
        resolveSettings: yield* makeResolveKimiSettings,
        onAvailableCommands: (commands) =>
          Effect.sync(() => {
            advertised.push(...commands.map((command) => command.name));
          }).pipe(Effect.andThen(Deferred.succeed(commandsReceived, undefined))),
      });

      yield* adapterWithCommands.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      // The notification consumer that delivers `available_commands_update`
      // runs in a fiber forked by `startSession`, so wait for the first
      // delivery instead of racing it.
      yield* Deferred.await(commandsReceived);
      assert.deepStrictEqual(advertised, ["compact", "status", "usage", "help"]);
      yield* adapterWithCommands.stopSession(threadId);
    }),
  );

  it.effect("maps runtime modes and model selection onto kimi ACP requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-mode-thread");
      const logDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-log-")),
      );
      const requestLogPath = NodePath.join(logDir, "requests.ndjson");
      const argvLogPath = NodePath.join(logDir, "argv.tsv");
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );

      const rawAdapter = yield* makeKimiAdapter(decodeKimiSettings({ binaryPath: wrapperPath }));

      yield* rawAdapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("kimi"),
          model: "kimi-code/k3",
        },
      });

      const argv = yield* Effect.promise(() => NodeFSP.readFile(argvLogPath, "utf8"));
      assert.equal(argv.trim(), "acp");

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeRequest = requests.find(
        (request) =>
          request.method === "session/set_config_option" &&
          (request.params as Record<string, unknown> | undefined)?.configId === "mode",
      );
      assert.ok(modeRequest, "expected a session/set_config_option mode request");
      assert.equal((modeRequest.params as Record<string, unknown>).value, "yolo");
      const modelRequest = requests.find(
        (request) =>
          request.method === "session/set_model" &&
          (request.params as Record<string, unknown> | undefined)?.modelId === "kimi-code/k3",
      );
      assert.ok(modelRequest, "expected a session/set_model request for kimi-code/k3");

      yield* rawAdapter.stopSession(threadId);
    }),
  );

  it.effect("resumes through kimi's session/resume capability", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kimi-resume-thread");
      const logDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-log-")),
      );
      const requestLogPath = NodePath.join(logDir, "requests.ndjson");
      const argvLogPath = NodePath.join(logDir, "argv.tsv");
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );

      const rawAdapter = yield* makeKimiAdapter(decodeKimiSettings({ binaryPath: wrapperPath }));

      yield* rawAdapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const resumeRequest = requests.find((request) => request.method === "session/resume");
      assert.ok(resumeRequest, "expected a session/resume request");
      assert.equal((resumeRequest.params as Record<string, unknown>).sessionId, "mock-session-1");

      yield* rawAdapter.stopSession(threadId);
    }),
  );

  it.effect("maps kimi ACP elicitation to user-input.requested and resolves the reply", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-elicitation-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_KIMI_EMIT_ELICIT: "1" }),
      );
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me a question", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.questions.length, 1);
      assert.equal(requestedEvent.payload.questions[0]?.id, "color");
      assert.equal(requestedEvent.payload.questions[0]?.header, "Color");
      assert.deepEqual(
        requestedEvent.payload.questions[0]?.options.map((option) => option.value),
        ["red", "blue"],
      );
      assert.equal(requestedEvent.raw?.method, "session/elicitation");

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        { color: "red" },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, { color: "red" });
      yield* Fiber.join(sendTurnFiber);
      const completedEvent = yield* Deferred.await(completed);
      assert.equal(completedEvent.payload.state, "completed");

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects a duplicate user-input response after the first answer", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-elicitation-duplicate-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_KIMI_EMIT_ELICIT: "1" }),
      );
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me a question", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      const requestId = ApprovalRequestId.make(String(requestedEvent.requestId));

      yield* adapter.respondToUserInput(threadId, requestId, { color: "red" });
      const duplicate = yield* adapter
        .respondToUserInput(threadId, requestId, { color: "blue" })
        .pipe(Effect.flip);
      assert.equal(duplicate._tag, "ProviderAdapterRequestError");
      if (duplicate._tag === "ProviderAdapterRequestError") {
        assert.match(duplicate.detail, /Unknown pending user-input request/);
      }

      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(completed);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects invalid user-input answers and keeps the request pending", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-elicitation-invalid-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_KIMI_EMIT_ELICIT: "1" }),
      );
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me a question", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      const requestId = ApprovalRequestId.make(String(requestedEvent.requestId));

      const invalid = yield* adapter
        .respondToUserInput(threadId, requestId, { color: { shade: "dark" } })
        .pipe(Effect.flip);
      assert.equal(invalid._tag, "ProviderAdapterValidationError");
      if (invalid._tag === "ProviderAdapterValidationError") {
        assert.match(invalid.issue, /must be a string, number, boolean, or array of strings/);
      }

      // The request is still pending, so a valid answer resolves the turn.
      yield* adapter.respondToUserInput(threadId, requestId, { color: "red" });
      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, { color: "red" });
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(completed);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects missing required user-input answers and keeps the request retryable", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-elicitation-missing-required-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_KIMI_EMIT_ELICIT: "1" }),
      );
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me a question", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      const requestId = ApprovalRequestId.make(String(requestedEvent.requestId));

      const missing = yield* adapter.respondToUserInput(threadId, requestId, {}).pipe(Effect.flip);
      assert.equal(missing._tag, "ProviderAdapterValidationError");
      if (missing._tag === "ProviderAdapterValidationError") {
        assert.match(missing.issue, /Missing required answer for "color"/);
      }

      // The request is still pending, so an in-enum answer resolves the turn.
      yield* adapter.respondToUserInput(threadId, requestId, { color: "red" });
      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, { color: "red" });
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(completed);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects out-of-enum user-input answers and keeps the request retryable", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-elicitation-out-of-enum-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_KIMI_EMIT_ELICIT: "1" }),
      );
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me a question", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      const requestId = ApprovalRequestId.make(String(requestedEvent.requestId));

      const outOfEnum = yield* adapter
        .respondToUserInput(threadId, requestId, { color: "green" })
        .pipe(Effect.flip);
      assert.equal(outOfEnum._tag, "ProviderAdapterValidationError");
      if (outOfEnum._tag === "ProviderAdapterValidationError") {
        assert.match(outOfEnum.issue, /must be one of: red, blue/);
      }

      // The request is still pending, so an in-enum answer resolves the turn.
      yield* adapter.respondToUserInput(threadId, requestId, { color: "blue" });
      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, { color: "blue" });
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(completed);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("coerces string boolean answers and keeps unconvertible ones retryable", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-elicitation-boolean-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_KIMI_EMIT_ELICIT: "boolean" }),
      );
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me to confirm", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.deepEqual(
        requestedEvent.payload.questions[0]?.options.map((option) => option.value),
        ["true", "false"],
      );
      assert.equal(requestedEvent.payload.questions[0]?.allowCustomAnswer, false);
      const requestId = ApprovalRequestId.make(String(requestedEvent.requestId));

      const wrongType = yield* adapter
        .respondToUserInput(threadId, requestId, { agree: "yes" })
        .pipe(Effect.flip);
      assert.equal(wrongType._tag, "ProviderAdapterValidationError");
      if (wrongType._tag === "ProviderAdapterValidationError") {
        assert.match(wrongType.issue, /Answer for "agree" must be a boolean\./);
      }

      // The request is still pending, so a string "true" answer resolves
      // the turn with a coerced boolean.
      yield* adapter.respondToUserInput(threadId, requestId, { agree: "true" });
      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, { agree: true });
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(completed);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("coerces a numeric string answer for number properties", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-elicitation-number-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_KIMI_EMIT_ELICIT: "number" }),
      );
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me for a count", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      const requestId = ApprovalRequestId.make(String(requestedEvent.requestId));

      yield* adapter.respondToUserInput(threadId, requestId, { count: "42" });
      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, { count: 42 });
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(completed);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects a non-integer string for integer properties and stays retryable", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-elicitation-integer-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_KIMI_EMIT_ELICIT: "integer" }),
      );
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask me for retries", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      const requestId = ApprovalRequestId.make(String(requestedEvent.requestId));

      const wrongType = yield* adapter
        .respondToUserInput(threadId, requestId, { retries: "4.5" })
        .pipe(Effect.flip);
      assert.equal(wrongType._tag, "ProviderAdapterValidationError");
      if (wrongType._tag === "ProviderAdapterValidationError") {
        assert.match(wrongType.issue, /Answer for "retries" must be an integer\./);
      }

      // The request is still pending, so an integer string resolves the turn.
      yield* adapter.respondToUserInput(threadId, requestId, { retries: "4" });
      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, { retries: 4 });
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(completed);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "rejects type-mismatched free-form string answers and keeps the request retryable",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KimiAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("kimi-elicitation-freeform-string-thread");

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({ T3_ACP_KIMI_EMIT_ELICIT: "free-form-string" }),
        );
        yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

        const requested =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
        const resolved =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
        const completed =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (String(event.threadId) !== String(threadId)) {
            return Effect.void;
          }
          if (event.type === "user-input.requested") {
            return Deferred.succeed(requested, event).pipe(Effect.ignore);
          }
          if (event.type === "user-input.resolved") {
            return Deferred.succeed(resolved, event).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            return Deferred.succeed(completed, event).pipe(Effect.ignore);
          }
          return Effect.void;
        }).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("kimi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const sendTurnFiber = yield* adapter
          .sendTurn({ threadId, input: "ask me for a note", attachments: [] })
          .pipe(Effect.forkChild);

        const requestedEvent = yield* Deferred.await(requested);
        const requestId = ApprovalRequestId.make(String(requestedEvent.requestId));

        const wrongType = yield* adapter
          .respondToUserInput(threadId, requestId, { note: 42 })
          .pipe(Effect.flip);
        assert.equal(wrongType._tag, "ProviderAdapterValidationError");
        if (wrongType._tag === "ProviderAdapterValidationError") {
          assert.match(wrongType.issue, /Answer for "note" must be a string\./);
        }

        // The request is still pending, so a string answer resolves the turn.
        yield* adapter.respondToUserInput(threadId, requestId, { note: "hello" });
        const resolvedEvent = yield* Deferred.await(resolved);
        assert.deepEqual(resolvedEvent.payload.answers, { note: "hello" });
        yield* Fiber.join(sendTurnFiber);
        yield* Deferred.await(completed);

        yield* Fiber.interrupt(eventsFiber);
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect(
    "disables custom answers for optional enum properties on the user-input.requested question",
    () =>
      Effect.gen(function* () {
        const adapter = yield* KimiAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("kimi-elicitation-optional-enum-thread");

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({ T3_ACP_KIMI_EMIT_ELICIT: "optional-color" }),
        );
        yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

        const requested =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
        const resolved =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();
        const completed =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

        const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (String(event.threadId) !== String(threadId)) {
            return Effect.void;
          }
          if (event.type === "user-input.requested") {
            return Deferred.succeed(requested, event).pipe(Effect.ignore);
          }
          if (event.type === "user-input.resolved") {
            return Deferred.succeed(resolved, event).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            return Deferred.succeed(completed, event).pipe(Effect.ignore);
          }
          return Effect.void;
        }).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("kimi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const sendTurnFiber = yield* adapter
          .sendTurn({ threadId, input: "ask me a question", attachments: [] })
          .pipe(Effect.forkChild);

        const requestedEvent = yield* Deferred.await(requested);
        const question = requestedEvent.payload.questions[0];
        assert.ok(question, "expected a question for the optional enum property");
        assert.equal(question.id, "color");
        assert.deepEqual(
          question.options.map((option) => option.value),
          ["red", "blue"],
        );
        // Even though `color` is optional, the server-side validator rejects
        // any non-enum value, so the UI must not offer a free-form escape
        // hatch.
        assert.equal(question.allowCustomAnswer, false);

        yield* adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.make(String(requestedEvent.requestId)),
          { color: "red" },
        );

        const resolvedEvent = yield* Deferred.await(resolved);
        assert.deepEqual(resolvedEvent.payload.answers, { color: "red" });
        yield* Fiber.join(sendTurnFiber);
        yield* Deferred.await(completed);

        yield* Fiber.interrupt(eventsFiber);
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("rejects a duplicate approval response after the first answer", () =>
    Effect.gen(function* () {
      const adapter = yield* KimiAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("kimi-approval-duplicate-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* settings.updateSettings({ providers: { kimi: { binaryPath: wrapperPath } } });

      const opened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const resolvedApproval =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.resolved" }>>();
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "request.opened") {
          return Deferred.succeed(opened, event).pipe(Effect.ignore);
        }
        if (event.type === "request.resolved") {
          return Deferred.succeed(resolvedApproval, event).pipe(Effect.ignore);
        }
        if (event.type === "turn.completed") {
          return Deferred.succeed(completed, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "run a command", attachments: [] })
        .pipe(Effect.forkChild);

      const openedEvent = yield* Deferred.await(opened);
      const requestId = ApprovalRequestId.make(String(openedEvent.requestId));

      yield* adapter.respondToRequest(threadId, requestId, "accept");
      yield* Deferred.await(resolvedApproval);

      const duplicate = yield* adapter
        .respondToRequest(threadId, requestId, "accept")
        .pipe(Effect.flip);
      assert.equal(duplicate._tag, "ProviderAdapterRequestError");
      if (duplicate._tag === "ProviderAdapterRequestError") {
        assert.match(duplicate.detail, /Unknown pending approval request/);
      }

      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(completed);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});

function kimiPermissionRequest(
  options: ReadonlyArray<{
    readonly optionId: string;
    readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>,
) {
  return {
    sessionId: "mock-session-1",
    toolCall: {
      toolCallId: "tool-call-1",
      title: "cat package.json",
      kind: "execute" as const,
      status: "pending" as const,
    },
    options: options.map((option) => ({
      optionId: option.optionId,
      name: option.kind,
      kind: option.kind,
    })),
  };
}

it("selects the offered option id matching the user's decision", () => {
  const request = kimiPermissionRequest([
    { optionId: "remember-this-command", kind: "allow_always" },
    { optionId: "go-ahead-once", kind: "allow_once" },
    { optionId: "not-today", kind: "reject_once" },
  ]);

  assert.equal(
    selectDecisionPermissionOptionId(request, "acceptForSession"),
    "remember-this-command",
  );
  assert.equal(selectDecisionPermissionOptionId(request, "accept"), "go-ahead-once");
  assert.equal(selectDecisionPermissionOptionId(request, "decline"), "not-today");
});

it("degrades acceptForSession to the offered allow_once option", () => {
  const request = kimiPermissionRequest([
    { optionId: "go-ahead-once", kind: "allow_once" },
    { optionId: "not-today", kind: "reject_once" },
  ]);

  assert.equal(selectDecisionPermissionOptionId(request, "acceptForSession"), "go-ahead-once");
});

it("falls back to the hardcoded acp outcome ids when no option kind matches", () => {
  const request = kimiPermissionRequest([{ optionId: "not-today", kind: "reject_once" }]);

  assert.equal(selectDecisionPermissionOptionId(request, "accept"), "allow-once");
  assert.equal(selectDecisionPermissionOptionId(request, "acceptForSession"), "allow-always");
});

it("selects the offered allow_always option for acceptAlways", () => {
  const request = kimiPermissionRequest([
    { optionId: "remember-this-command", kind: "allow_always" },
    { optionId: "go-ahead-once", kind: "allow_once" },
    { optionId: "not-today", kind: "reject_once" },
  ]);

  assert.equal(selectDecisionPermissionOptionId(request, "acceptAlways"), "remember-this-command");
});

it("degrades acceptAlways to the offered allow_once option", () => {
  const request = kimiPermissionRequest([
    { optionId: "go-ahead-once", kind: "allow_once" },
    { optionId: "not-today", kind: "reject_once" },
  ]);

  assert.equal(selectDecisionPermissionOptionId(request, "acceptAlways"), "go-ahead-once");
});

it("falls back to the hardcoded allow-always outcome for acceptAlways", () => {
  const request = kimiPermissionRequest([{ optionId: "not-today", kind: "reject_once" }]);

  assert.equal(selectDecisionPermissionOptionId(request, "acceptAlways"), "allow-always");
});
