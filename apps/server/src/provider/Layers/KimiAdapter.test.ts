// @effect-diagnostics nodeBuiltinImport:off - executable ACP fixture setup uses Node filesystem boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  KimiSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { makeKimiAdapter } from "./KimiAdapter.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const makeKimiWrapper = Effect.fn("makeKimiWrapper")(function* (
  extraEnv?: Record<string, string>,
  version = "0.29.0",
) {
  const windows = (yield* HostProcessPlatform) === "win32";
  return yield* Effect.promise(async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mock-"));
    const wrapperPath = NodePath.join(directory, windows ? "kimi.cmd" : "fake-kimi.sh");
    const envExports = Object.entries(extraEnv ?? {})
      .map(([key, value]) =>
        windows
          ? `set "${key}=${value.replaceAll('"', '\\"')}"`
          : `export ${key}=${encodeJsonString(value)}`,
      )
      .join("\n");
    const script = windows
      ? `@echo off\r\nif "%~1"=="--version" (\r\n  echo kimi ${version}\r\n  exit /b 0\r\n)\r\n${envExports}\r\n${encodeJsonString(process.execPath)} ${encodeJsonString(mockAgentPath)} %*\r\n`
      : `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf 'kimi ${version}\\n'\n  exit 0\nfi\n${envExports}\nexec ${encodeJsonString(process.execPath)} ${encodeJsonString(mockAgentPath)} "$@"\n`;
    await NodeFSP.writeFile(wrapperPath, script, "utf8");
    if (!windows) await NodeFSP.chmod(wrapperPath, 0o755);
    return wrapperPath;
  });
});

async function readRequests(requestLogPath: string) {
  const raw = await NodeFSP.readFile(requestLogPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map(
      (line) =>
        JSON.parse(line) as {
          readonly method?: string;
          readonly params?: {
            readonly configId?: string;
            readonly value?: unknown;
            readonly mcpServers?: ReadonlyArray<unknown>;
          };
        },
    );
}

const readRequestMethods = (requestLogPath: string) =>
  readRequests(requestLogPath).then((entries) => entries.map((entry) => entry.method));

const kimiAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kimi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (
  binaryPath: string,
  instanceId = ProviderInstanceId.make("kimi"),
  nativeEventLogger?: EventNdjsonLogger,
) =>
  makeKimiAdapter(decodeKimiSettings({ binaryPath }), {
    instanceId,
    ...(nativeEventLogger ? { nativeEventLogger } : {}),
  }).pipe(Effect.orDie);

it.layer(kimiAdapterTestLayer)("KimiAdapter", (it) => {
  it.effect("rejects an incompatible Kimi CLI before starting ACP", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter(yield* makeKimiWrapper(undefined, "0.28.1"));
      const threadId = ThreadId.make("kimi-old-version");
      const result = yield* Effect.result(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("kimi"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        }),
      );

      if (Result.isSuccess(result)) {
        yield* adapter.stopSession(threadId);
        assert.fail("expected an incompatible Kimi version to be rejected");
      }
      assert.equal(result.failure._tag, "ProviderAdapterProcessError");
      assert.include(result.failure.message, "0.29.0");
    }),
  );

  it.effect("starts a Kimi ACP session and emits canonical prompt lifecycle events", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mode-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* makeKimiWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const threadId = ThreadId.make("kimi-lifecycle");
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const assistantCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
          Effect.andThen(
            event.type === "item.completed" && event.payload.itemType === "assistant_message"
              ? Deferred.succeed(assistantCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kimi"), model: "default" },
      });
      assert.equal(session.provider, "kimi");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.isTrue(
        (yield* Effect.promise(() => readRequests(requestLogPath))).some(
          (entry) =>
            entry.method === "session/set_config_option" &&
            entry.params?.configId === "mode" &&
            entry.params.value === "code",
        ),
      );

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Inspect this repository",
        attachments: [],
      });
      assert.equal(turn.threadId, threadId);
      assert.include(
        events.map((event) => event.type),
        "item.completed",
      );
      yield* Deferred.await(completed);
      yield* Deferred.await(assistantCompleted);
      yield* Fiber.interrupt(eventsFiber);

      for (const type of [
        "item.started",
        "content.delta",
        "item.completed",
        "turn.plan.updated",
        "turn.completed",
      ] as const) {
        assert.include(
          events.map((event) => event.type),
          type,
        );
      }
      assert.isTrue(events.every((event) => event.provider === ProviderDriverKind.make("kimi")));
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not start an ACP prompt when interruption wins during turn setup", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-interrupt-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* makeKimiWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_SET_CONFIG_OPTION_DELAY_MS: "100",
        }),
      );
      const threadId = ThreadId.make("kimi-interrupt-setup");
      const started = yield* Deferred.make<TurnId>();
      const completed = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.threadId !== threadId
          ? Effect.void
          : event.type === "turn.started" && event.turnId
            ? Deferred.succeed(started, event.turnId).pipe(Effect.asVoid)
            : event.type === "turn.completed"
              ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
              : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Do not prompt after cancellation",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("kimi"),
            model: "composer-2",
          },
        })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(started);
      yield* adapter.interruptTurn(threadId, turnId);
      yield* Fiber.join(turnFiber);
      yield* Deferred.await(completed);

      assert.notInclude(
        yield* Effect.promise(() => readRequestMethods(requestLogPath)),
        "session/prompt",
      );
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("leaves plan mode when a specialized full-access mode is unavailable", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mode-fallback-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* makeKimiWrapper({
          T3_ACP_OMIT_CODE_MODE: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const threadId = ThreadId.make("kimi-mode-fallback");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Plan first",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.sendTurn({ threadId, input: "Now implement", attachments: [] });

      const modeValues = (yield* Effect.promise(() => readRequests(requestLogPath)))
        .filter(
          (entry) =>
            entry.method === "session/set_config_option" && entry.params?.configId === "mode",
        )
        .map((entry) => entry.params?.value);
      assert.deepStrictEqual(modeValues, ["architect", "ask"]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes the ACP session and keeps adapter instances isolated", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-resume-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const first = yield* makeTestAdapter(
        yield* makeKimiWrapper({
          T3_ACP_ADVERTISE_RESUME: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
        ProviderInstanceId.make("kimi-work"),
      );
      const second = yield* makeTestAdapter(
        yield* makeKimiWrapper(),
        ProviderInstanceId.make("kimi-personal"),
      );
      const resumedThread = ThreadId.make("kimi-resumed");
      const otherThread = ThreadId.make("kimi-other-instance");

      const session = yield* first.startSession({
        threadId: resumedThread,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "kimi-session-1" },
        modelSelection: { instanceId: ProviderInstanceId.make("kimi-work"), model: "default" },
      });
      yield* second.startSession({
        threadId: otherThread,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      assert.equal(session.providerInstanceId, ProviderInstanceId.make("kimi-work"));
      assert.isTrue(yield* first.hasSession(resumedThread));
      assert.isFalse(yield* second.hasSession(resumedThread));
      assert.isTrue(yield* second.hasSession(otherThread));
      const requestMethods = yield* Effect.promise(() => readRequestMethods(requestLogPath));
      assert.include(requestMethods, "session/resume");

      yield* first.stopAll();
      assert.isFalse(yield* first.hasSession(resumedThread));
      assert.isTrue(yield* second.hasSession(otherThread));
      yield* second.stopAll();
    }),
  );

  it.effect("preserves the T3 MCP credential when replacing a session", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-mcp-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* makeKimiWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const threadId = ThreadId.make("kimi-mcp-replacement");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-1"),
        threadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("kimi"),
        endpoint: "http://127.0.0.1:4567/mcp",
        authorizationHeader: "Bearer test-token",
      });

      const input = {
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required" as const,
      };
      yield* adapter.startSession(input);
      yield* adapter.startSession(input);

      const newSessionRequests = (yield* Effect.promise(() => readRequests(requestLogPath))).filter(
        (entry) => entry.method === "session/new",
      );
      assert.equal(newSessionRequests.length, 2);
      assert.isTrue(newSessionRequests.every((entry) => entry.params?.mcpServers?.length === 1));
      assert.isDefined(McpProviderSession.readMcpProviderSession(threadId));
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("removes a session when the Kimi ACP process exits", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter(
        yield* makeKimiWrapper({ T3_ACP_EXIT_BEFORE_PROMPT_RESPONSE: "1" }),
      );
      const threadId = ThreadId.make("kimi-process-exit");
      const exited = yield* Deferred.make<ProviderRuntimeEvent>();
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.threadId === threadId && event.type === "session.exited"
              ? Deferred.succeed(exited, event).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter
        .sendTurn({ threadId, input: "exit before responding", attachments: [] })
        .pipe(Effect.result);
      const exitEvent = yield* Deferred.await(exited);

      assert.deepInclude(exitEvent.payload, { exitKind: "error" });
      const relevantTypes = events
        .filter((event) => event.threadId === threadId)
        .map((event) => event.type);
      assert.isBelow(
        relevantTypes.indexOf("turn.completed"),
        relevantTypes.indexOf("session.exited"),
      );
      assert.equal(relevantTypes.filter((type) => type === "turn.completed").length, 1);
      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* Fiber.interrupt(eventsFiber);
    }),
  );

  it.effect("rejects an empty turn before changing session configuration", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kimi-acp-empty-turn-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const adapter = yield* makeTestAdapter(
        yield* makeKimiWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const threadId = ThreadId.make("kimi-empty-turn");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const methodsBefore = yield* Effect.promise(() => readRequestMethods(requestLogPath));
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      const error = yield* adapter
        .sendTurn({ threadId, input: "   ", attachments: [] })
        .pipe(Effect.flip);
      const methodsAfter = yield* Effect.promise(() => readRequestMethods(requestLogPath));

      assert.equal(error._tag, "ProviderAdapterValidationError");
      assert.deepEqual(methodsAfter, methodsBefore);
      assert.notInclude(
        events.map((event) => event.type),
        "turn.started",
      );
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("writes native ACP events through the configured logger", () =>
    Effect.gen(function* () {
      const records: unknown[] = [];
      const logger: EventNdjsonLogger = {
        filePath: "memory://kimi-native-events",
        write: (event) => Effect.sync(() => records.push(event)),
        close: () => Effect.void,
      };
      const adapter = yield* makeTestAdapter(
        yield* makeKimiWrapper(),
        ProviderInstanceId.make("kimi"),
        logger,
      );
      const threadId = ThreadId.make("kimi-native-logging");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kimi"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      assert.isAbove(records.length, 0);
      yield* adapter.stopSession(threadId);
    }),
  );
});
