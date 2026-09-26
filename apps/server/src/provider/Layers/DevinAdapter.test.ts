// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  DevinSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockDevinWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-devin",
    env: { T3_ACP_DEVIN: "1", ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath }),
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
  attempts = 80,
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

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeDevinAdapter>[1]) =>
  makeDevinAdapter(decodeDevinSettings({ binaryPath }), options).pipe(Effect.orDie);

it.layer(devinAdapterTestLayer)("DevinAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
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
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "swe-2-max" },
      });

      assert.equal(session.provider, "devin");
      assert.equal(session.model, "swe-2-max");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
        dataHome: `${NodeOS.homedir()}/.local/share/devin`,
      });

      yield* adapter.sendTurn({ threadId, input: "hello devin" });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((event) => event.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("negotiates model and mode through session/set_config_option, never authenticate", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-config-options");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-requests-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("devin"),
          model: "swe-2-max",
          options: [{ id: "reasoning", value: "max" }],
        },
      });
      yield* adapter.sendTurn({ threadId, input: "hi" });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((request) => request.method);
      assert.notInclude(methods, ["authenticate"]);
      assert.notInclude(methods, ["session/set_model"]);

      const configUpdates = requests
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => request.params as { configId: string; value: unknown })
        .map(({ configId, value }) => ({ configId, value }));
      assert.deepEqual(configUpdates, [
        { configId: "model", value: "swe-2-max" },
        { configId: "thought_level", value: "max" },
        { configId: "mode", value: "bypass" },
      ]);

      const prompt = requests.find((request) => request.method === "session/prompt");
      assert.isDefined(prompt);
      const promptParts = (prompt.params as { prompt: Array<{ text: string }> }).prompt;
      const lastPart = promptParts[promptParts.length - 1];
      assert.isDefined(lastPart);
      assert.include(lastPart.text, "Devin");
    }),
  );

  it.effect("maps approval-required onto Devin's accept-edits mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-supervised-mode");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-requests-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          // Devin's own default is accept-edits; start in smart so the
          // approval-required mapping produces an observable write.
          T3_ACP_DEVIN_INITIAL_MODE: "smart",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "hi" });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeUpdates = requests
        .filter((request) => request.method === "session/set_config_option")
        .map((request) => request.params as { configId: string; value: unknown })
        .filter((params) => params.configId === "mode");
      assert.deepEqual(
        modeUpdates.map((params) => params.value),
        ["accept-edits"],
      );
    }),
  );

  it.effect("auto-approves permission requests in full-access mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-full-access-approve");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
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

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run the command" });
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.interrupt(runtimeEventsFiber);

      // full-access resolves permission prompts inside the adapter; nothing
      // reaches the user-facing request stream.
      assert.isFalse(runtimeEvents.some((event) => event.type === "request.opened"));
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.isDefined(completed);

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("surfaces permission requests in approval-required mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-approval-request");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const requestOpened = yield* Deferred.make<ProviderRuntimeEvent>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "request.opened") {
            yield* Deferred.succeed(requestOpened, event);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "run it" })
        .pipe(Effect.forkChild);
      const opened = yield* Deferred.await(requestOpened).pipe(Effect.timeout("5 seconds"));
      assert.equal(opened.type, "request.opened");

      assert.isDefined(opened.requestId);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );
      yield* Fiber.await(turnFiber).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("cancels an in-flight turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-cancel-turn");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-requests-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_HANG_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turnFiber = yield* adapter.sendTurn({ threadId, input: "hang" }).pipe(Effect.forkChild);
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');
      yield* adapter.interruptTurn(threadId);
      const exit = yield* Fiber.await(turnFiber).pipe(Effect.timeout("5 seconds"));
      assert.isTrue(exit._tag === "Success" || exit._tag === "Failure");

      const requests = yield* waitForFileContent(
        requestLogPath,
        80,
        '"method":"session/cancel"',
      ).pipe(
        Effect.map((raw) =>
          raw
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        ),
      );
      assert.isTrue(requests.some((request) => request.method === "session/cancel"));

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects an empty turn without mutating session config", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-empty-turn");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-requests-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const baseline = yield* Effect.promise(() => readJsonLines(requestLogPath));

      const error = yield* adapter.sendTurn({ threadId, input: "   " }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterValidationError");

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.deepStrictEqual(
        requests.slice(baseline.length).map((request) => request.method),
        [],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("settles a started turn as failed when the prompt dies", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-failed-turn");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_FAIL_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<ProviderRuntimeEvent>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const error = yield* adapter.sendTurn({ threadId, input: "run it" }).pipe(Effect.flip);
      assert.match(String(error._tag), /^ProviderAdapter/);

      const completed = yield* Deferred.await(turnCompleted).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.interrupt(runtimeEventsFiber);
      assert.isTrue(runtimeEvents.some((event) => event.type === "turn.started"));
      if (completed.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
      } else {
        assert.fail(`expected turn.completed, got ${completed.type}`);
      }
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("resumes a session from the persisted cursor", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-resume");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-resume-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const dataHome = NodePath.join(tempDir, "devin-data");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const environment = { ...process.env, XDG_DATA_HOME: dataHome };
      const adapter = yield* makeTestAdapter(wrapperPath, { environment });

      const session = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: {
          schemaVersion: 1,
          sessionId: "mock-session-1",
          dataHome: `${dataHome}/devin`,
        },
      });
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
        dataHome: `${dataHome}/devin`,
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((request) => request.method === "session/load"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects a resume cursor from a different Devin account home", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-resume-mismatch");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const error = yield* adapter
        .startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: {
            schemaVersion: 1,
            sessionId: "mock-session-1",
            dataHome: "/some/other/devin",
          },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag === "ProviderAdapterValidationError") {
        assert.include(error.issue, "different Devin account home");
      }
    }),
  );

  it.effect("rejects rollback without discarding the provider conversation", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-unsupported-rollback");
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "Remember this turn" });
      const originalTurns = [...(yield* adapter.readThread(threadId)).turns];
      assert.isFalse(adapter.capabilities.supportsConversationRollback);
      const error = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.deepStrictEqual((yield* adapter.readThread(threadId)).turns, originalTurns);
      yield* adapter.stopSession(threadId);
    }),
  );
});
