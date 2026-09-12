// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ApprovalRequestId,
  DevinSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";
import { makeDevinAcpRuntime } from "../acp/DevinAcpSupport.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);
const DEVIN_INSTANCE = ProviderInstanceId.make("devin");

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
// Stopping a session kills the agent with SIGTERM; Windows terminates the
// process instead, so the mock never sees a signal to log.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

async function makeMockDevinWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-devin",
    env: { T3_ACP_DEVIN: "1", ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath, expectedArgs: ["acp"] }),
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

const devinAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * `environment` doubles as the ambient-credential input: `WINDSURF_API_KEY`
 * or `<HOME>/.local/share/devin/credentials.toml` decide whether the runtime
 * sends `devin-browser` at startup.
 */
const makeTestAdapter = (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  options?: Omit<Parameters<typeof makeDevinAdapter>[1], "makeRuntime" | "instanceId">,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* makeDevinAdapter(decodeDevinSettings({ enabled: true, binaryPath }), {
      instanceId: DEVIN_INSTANCE,
      ...options,
      makeRuntime: (input) =>
        makeDevinAcpRuntime({
          ...input,
          devinSettings: { binaryPath },
          environment,
          childProcessSpawner,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        ),
    }).pipe(Effect.orDie);
  });

/** Process env with every Devin ambient-credential source removed. */
function signedOutEnvironment(home: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    HOME: home,
    WINDSURF_API_KEY: "",
    // Blank (not delete) so a machine where these are set still reads as
    // signed out: resolution treats empty values as unset.
    XDG_DATA_HOME: "",
    LOCALAPPDATA: "",
  };
  return env;
}

it.layer(devinAdapterTestLayer)("DevinAdapterLive", (it) => {
  it.effect("starts a session without an authenticate request when credentials exist", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-ambient-auth");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-ambient-auth-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        ...process.env,
        WINDSURF_API_KEY: "ws-test",
      });

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: DEVIN_INSTANCE, model: "swe-2-medium" },
      });

      assert.equal(session.provider, "devin");
      assert.equal(session.model, "swe-2-medium");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((request) => request.method);
      // Ambient credentials mean the runtime must not ask `devin acp` to
      // authenticate — that call opens a browser on every spawn otherwise.
      assert.notInclude(methods, "authenticate");
      assert.includeMembers(methods, ["initialize", "session/new"]);
      const configWrites = requests
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => request.params);
      assert.deepInclude(configWrites, {
        sessionId: "mock-session-1",
        configId: "model",
        value: "swe-2-medium",
      });
      assert.deepInclude(configWrites, {
        sessionId: "mock-session-1",
        configId: "mode",
        value: "bypass",
      });
      // Devin has no SessionModelState; model changes must ride the config
      // option, never `session/set_model`.
      assert.notInclude(methods, "session/set_model");
    }),
  );

  it.effect("sends devin-browser authenticate only when no credentials are available", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-browser-auth");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-browser-auth-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, signedOutEnvironment(tempDir));

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const authenticate = requests.find((request) => request.method === "authenticate");
      assert.isDefined(authenticate);
      assert.deepEqual(authenticate?.params, { methodId: "devin-browser" });
    }),
  );

  it.effect("never requests browser authentication when resuming while signed out", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-resume-signed-out");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-resume-signed-out-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, signedOutEnvironment(tempDir));

      // Recovery during server restart resumes with a cursor; popping a
      // browser there would surprise nobody at the keyboard.
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
        resumeCursor: { schemaVersion: 1, sessionId: "previous-devin-session" },
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((request) => request.method);
      assert.notInclude(methods, "authenticate");
      assert.include(methods, "session/load");
      assert.notInclude(methods, "session/new");
    }),
  );

  it.effect("maps the mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath, {
        ...process.env,
        WINDSURF_API_KEY: "ws-test",
      });

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

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: DEVIN_INSTANCE, model: "swe-2-max" },
      });

      yield* adapter.sendTurn({ threadId, input: "hello devin", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const types = runtimeEvents.map((event) => event.type);
      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("routes permission requests through the approval flow", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-permission-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        ...process.env,
        WINDSURF_API_KEY: "ws-test",
      });

      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "needs approval", attachments: [] })
        .pipe(Effect.forkChild);
      const requestOpenedEvent = yield* Deferred.await(requestOpened);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(requestOpenedEvent.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interruptTurn cancels a prompt awaiting permission, and the next turn works", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-interrupt-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-interrupt-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        ...process.env,
        WINDSURF_API_KEY: "ws-test",
      });

      const requestIds: Array<string> = [];
      const firstRequestOpened = yield* Deferred.make<void>();
      const secondRequestOpened = yield* Deferred.make<void>();
      const firstTurnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const secondTurnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      let turnCompletedCount = 0;
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) return;
          if (event.type === "request.opened") {
            requestIds.push(String(event.requestId));
            yield* Deferred.succeed(
              requestIds.length === 1 ? firstRequestOpened : secondRequestOpened,
              undefined,
            ).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            turnCompletedCount += 1;
            yield* Deferred.succeed(
              turnCompletedCount === 1 ? firstTurnCompleted : secondTurnCompleted,
              event,
            ).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const firstTurn = yield* adapter
        .sendTurn({ threadId, input: "needs approval", attachments: [] })
        .pipe(Effect.forkChild);
      // Wait until the mock's permission request is pending, then interrupt:
      // the adapter must answer it "cancelled" so the prompt can settle.
      yield* Deferred.await(firstRequestOpened);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(firstTurn);

      const firstCompleted = yield* Deferred.await(firstTurnCompleted);
      assert.equal(firstCompleted.payload.state, "cancelled");
      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.isUndefined(session?.activeTurnId);

      // The next turn's permission request must still reach the approval flow.
      const secondTurn = yield* adapter
        .sendTurn({ threadId, input: "again", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(secondRequestOpened);
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(requestIds[1]!), "accept");
      yield* Fiber.join(secondTurn);
      const secondCompleted = yield* Deferred.await(secondTurnCompleted);
      assert.equal(secondCompleted.payload.state, "completed");

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventsFiber);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isNotEmpty(requests.filter((request) => request.method === "session/cancel"));
    }),
  );

  it.effect("resumes an existing session through session/load", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-resume-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-resume-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        ...process.env,
        WINDSURF_API_KEY: "ws-test",
      });

      const session = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
        resumeCursor: { schemaVersion: 1, sessionId: "previous-devin-session" },
      });
      assert.equal(session.provider, "devin");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "previous-devin-session",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isEmpty(
        requests.filter((request) => request.method === "session/new"),
        "resume must not open a new Devin session",
      );
      const loads = requests.filter((request) => request.method === "session/load");
      assert.lengthOf(loads, 1);
      assert.equal(
        (loads[0]?.params as { sessionId?: string } | undefined)?.sessionId,
        "previous-devin-session",
      );
    }),
  );

  it.effect("resumes onto the session model when the saved model left the catalog", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-stale-model-resume");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_DEVIN_MODELS: "swe-2-high,swe-2-medium" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        ...process.env,
        WINDSURF_API_KEY: "ws-test",
      });

      const session = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
        resumeCursor: { schemaVersion: 1, sessionId: "stale-model-session" },
        modelSelection: { instanceId: DEVIN_INSTANCE, model: "swe-2-max" },
      });
      assert.equal(session.model, "swe-2-high");

      // The thread's persisted (stale) selection is re-sent on every turn; it
      // must keep falling back instead of failing with invalidParams.
      yield* adapter.sendTurn({
        threadId,
        input: "still on old selection",
        attachments: [],
        modelSelection: { instanceId: DEVIN_INSTANCE, model: "swe-2-max" },
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect.skipIf(windowsHost)("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        ...process.env,
        WINDSURF_API_KEY: "ws-test",
      });

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );
});
