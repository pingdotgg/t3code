// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { setMcpProviderSession, clearMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { makeHermesAdapter } from "./HermesAdapter.ts";
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockHermesWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-hermes.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function makeSpawnLoggingHermesWrapper(spawnLogPath: string) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-spawn-"));
  const wrapperPath = NodePath.join(dir, "fake-hermes-spawn.sh");
  const script = `#!/bin/sh
printf '%s\\n' "$*" > ${JSON.stringify(spawnLogPath)}
printf 'HERMES_HOME=%s\\n' "$HERMES_HOME" >> ${JSON.stringify(spawnLogPath)}
printf 'HERMES_ACP_SKIP_CONFIGURED_MCP=%s\\n' "$HERMES_ACP_SKIP_CONFIGURED_MCP" >> ${JSON.stringify(spawnLogPath)}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const hermesAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeHermesAdapter>[1]) =>
  makeHermesAdapter(decodeHermesSettings({ binaryPath }), options).pipe(Effect.orDie);

const HERMES_THREAD = ThreadId.make("hermes-mock-thread");

it.layer(hermesAdapterTestLayer)("HermesAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: HERMES_THREAD,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "grok-mock-alt" },
      });

      assert.equal(session.provider, "hermes");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId: HERMES_THREAD,
        input: "hello hermes",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.configured",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }
      const completed = runtimeEvents.find((e) => e.type === "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
        assert.equal(completed.payload.stopReason, "end_turn");
      }

      yield* adapter.stopSession(HERMES_THREAD);
    }),
  );

  it.effect("passes profile, home path and launch args to the hermes acp spawn", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-args-")),
      );
      const spawnLogPath = NodePath.join(tempDir, "spawn.log");
      const wrapperPath = yield* Effect.promise(() => makeSpawnLoggingHermesWrapper(spawnLogPath));
      const adapter = yield* makeHermesAdapter(
        decodeHermesSettings({
          binaryPath: wrapperPath,
          homePath: "/custom/hermes-home",
          profile: "work",
          launchArgs: "--foo bar",
        }),
      ).pipe(Effect.orDie);

      const session = yield* adapter.startSession({
        threadId: ThreadId.make("hermes-spawn-args"),
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const spawnLog = yield* waitForFileContent(spawnLogPath);
      assert.include(spawnLog, "--profile work acp --foo bar");
      assert.include(spawnLog, "HERMES_HOME=/custom/hermes-home");

      yield* adapter.stopSession(ThreadId.make("hermes-spawn-args"));
      assert.equal(session.provider, "hermes");
    }),
  );

  it.effect("sets HERMES_ACP_SKIP_CONFIGURED_MCP when an MCP session is bound", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-mcp-skip");
      setMcpProviderSession({
        environmentId: "env-1" as never,
        threadId,
        providerSessionId: "mcp-session-1",
        providerInstanceId: ProviderInstanceId.make("hermes"),
        endpoint: "https://mcp.example.test/sse",
        authorizationHeader: "Bearer mock-token",
      });
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-mcp-")),
      );
      const spawnLogPath = NodePath.join(tempDir, "spawn.log");
      const wrapperPath = yield* Effect.promise(() => makeSpawnLoggingHermesWrapper(spawnLogPath));
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const spawnLog = yield* waitForFileContent(spawnLogPath);
      assert.include(spawnLog, "HERMES_ACP_SKIP_CONFIGURED_MCP=1");

      yield* adapter.stopSession(threadId);
      yield* Effect.sync(() => clearMcpProviderSession(threadId));
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId: ThreadId.make("hermes-provider-mismatch"),
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "grok-build" },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-empty-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps approval decisions to Hermes permission option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-approval-mapping");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-approval-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      // Use Hermes' real stable option ids (allow_once/allow_always/deny).
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "allow_once",
          T3_ACP_ALLOW_ALWAYS_OPTION_ID: "allow_always",
          T3_ACP_REJECT_ONCE_OPTION_ID: "deny",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const decisions = yield* Queue.unbounded<ProviderApprovalDecision>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Queue.take(decisions).pipe(
              Effect.flatMap((decision) =>
                adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.make(String(event.requestId)),
                  decision,
                ),
              ),
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "grok-build" },
      });

      yield* Queue.offer(decisions, "accept");
      yield* adapter.sendTurn({ threadId, input: "approve once", attachments: [] });
      yield* Queue.offer(decisions, "acceptForSession");
      yield* adapter.sendTurn({ threadId, input: "approve for session", attachments: [] });
      yield* Queue.offer(decisions, "decline");
      yield* adapter.sendTurn({ threadId, input: "deny", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const resolvedOptionIds = requests
        .map((entry) =>
          !("method" in entry) &&
          typeof entry.result === "object" &&
          entry.result !== null &&
          "outcome" in entry.result &&
          typeof entry.result.outcome === "object" &&
          entry.result.outcome !== null &&
          "optionId" in entry.result.outcome &&
          typeof entry.result.outcome.optionId === "string"
            ? entry.result.outcome.optionId
            : undefined,
        )
        .filter((id): id is string => id !== undefined);
      assert.deepEqual(resolvedOptionIds, ["allow_once", "allow_always", "deny"]);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores a session through the resume cursor", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-resume");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EMIT_LOAD_REPLAY: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "grok-build" },
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      // Replayed load notifications must not leak into the runtime stream.
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* adapter.sendTurn({
        threadId,
        input: "after resume",
        attachments: [],
      });

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects rollbackThread because Hermes ACP has no rollback", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-rollback");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
      assert.equal(error._tag, "ProviderAdapterValidationError");
      assert.include(error.message, "rollback");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails respondToUserInput cleanly when no user-input surface exists", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-user-input");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make("nope"), {}),
      );
      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("cancels an in-flight prompt when interrupted", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-cancel");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" ? Deferred.succeed(turnStarted, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hang forever", attachments: [] })
        .pipe(Effect.forkChild);

      yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
