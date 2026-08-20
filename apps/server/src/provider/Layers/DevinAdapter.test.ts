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
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  DevinSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import type { DevinAdapterShape } from "../Services/DevinAdapter.ts";
import { makeDevinAdapter, resolveRequestedModeId } from "./DevinAdapter.ts";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

// Test-local service tag so the rest of the file can keep using `yield* DevinAdapter`.
class DevinAdapter extends Context.Service<DevinAdapter, DevinAdapterShape>()(
  "t3/provider/Layers/DevinAdapter.test/DevinAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";
const mockAgentArgs = [mockAgentPath] as const;

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-agent.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(" ")} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function makeProbeWrapper(requestLogPath: string, extraEnv?: Record<string, string>) {
  return makeMockAgentWrapper({
    T3_ACP_REQUEST_LOG_PATH: requestLogPath,
    ...extraEnv,
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

// Tests mutate `ServerSettingsService` mid-flight (setting
// `providers.devin.binaryPath` to a mock ACP wrapper), so each session must
// read the latest snapshot. See the matching CursorAdapter.test.ts note.
const makeResolveDevinSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return yield* Effect.succeed(
    serverSettings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.providers.devin),
      Effect.orDie,
    ),
  );
});

const devinAdapterTestLayer = it.layer(
  Layer.effect(
    DevinAdapter,
    Effect.gen(function* () {
      const devinConfig = decodeDevinSettings({});
      const resolveSettings = yield* makeResolveDevinSettings;
      return yield* makeDevinAdapter(devinConfig, { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-devin-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const startSessionInput = (threadId: ThreadId) =>
  ({
    threadId,
    provider: ProviderDriverKind.make("devin"),
    cwd: process.cwd(),
    runtimeMode: "full-access",
    modelSelection: {
      instanceId: ProviderInstanceId.make("devin"),
      model: "default",
    },
  }) as const;

devinAdapterTestLayer("DevinAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-mock-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => String(event.threadId) === String(threadId)),
        Stream.take(9),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession(startSessionInput(threadId));

      assert.equal(session.provider, "devin");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((event) => event.type);
      for (const type of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(types, type);
      }

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  // Production calls startSession from a request fiber that finishes as soon
  // as the session exists. `Effect.forkChild` made the notification consumer a
  // child of that fiber, and Effect interrupts a fiber's children when it
  // completes, so the consumer died on return and every later session/update
  // was dropped. Every other test here calls startSession directly from the
  // test fiber, which never completes, so the consumer survived and the bug
  // stayed invisible. Running it in a fiber that finishes is what reproduces
  // production. See the matching GrokAdapter regression test.
  it.effect("keeps consuming notifications after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-consumer-outlives-start-session");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const turnCompleted = yield* Deferred.make<void>();
      const deltas: Array<string> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) return;
          if (event.type === "content.delta" && typeof event.payload.delta === "string") {
            deltas.push(event.payload.delta);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      const startSessionFiber = yield* adapter
        .startSession(startSessionInput(threadId))
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber).pipe(Effect.timeout("10 seconds"));

      // Forked, and the assertion waits on the projected event rather than on
      // sendTurn: with the consumer dead the turn never settles, so awaiting
      // it directly would hang until the suite timeout instead of failing.
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello mock", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("10 seconds"));

      assert.include(
        deltas,
        "hello from mock",
        "no content.delta was projected after the startSession fiber completed",
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
      // Live clock so the timeouts above are real: under the default test
      // clock they wait on virtual time that never advances, and a regression
      // would hang until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );

  it.effect("surfaces thought chunks and usage updates as runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-streaming-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_DEVIN_STREAMING: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => String(event.threadId) === String(threadId)),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession(startSessionInput(threadId));
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "stream it",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const reasoningDelta = runtimeEvents.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "thinking about it");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }

      const usage = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usage?.type, "thread.token-usage.updated");
      if (usage?.type === "thread.token-usage.updated") {
        assert.equal(usage.payload.usage.usedTokens, 15141);
        assert.equal(usage.payload.usage.maxTokens, 202752);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps form elicitation to user-input events and answers with option values", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-elicitation-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_DEVIN_ELICITATION: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const answered = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (
            String(event.threadId) !== String(threadId) ||
            event.type !== "user-input.requested"
          ) {
            return;
          }
          assert.deepStrictEqual(event.payload.questions, [
            {
              id: "q0",
              header: "Color",
              question: "Pick a color",
              options: [
                { label: "Red", description: "The color red" },
                { label: "Blue", description: "The color blue" },
              ],
              multiSelect: false,
            },
          ]);
          yield* adapter.respondToUserInput(
            threadId,
            ApprovalRequestId.make(String(event.requestId)),
            { q0: "Red" },
          );
          yield* Deferred.succeed(answered, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => String(event.threadId) === String(threadId)),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession(startSessionInput(threadId));
      yield* adapter.sendTurn({
        threadId,
        input: "ask me a question",
        attachments: [],
      });

      yield* Deferred.await(answered);
      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const resolved = runtimeEvents.find((event) => event.type === "user-input.resolved");
      assert.equal(resolved?.type, "user-input.resolved");
      if (resolved?.type === "user-input.resolved") {
        assert.deepStrictEqual(resolved.payload.answers, { q0: "Red" });
      }

      // The mock echoes the elicitation response it received back as an
      // assistant chunk, proving the accept/content mapping reached the CLI.
      const echo = runtimeEvents.find(
        (event) =>
          event.type === "content.delta" &&
          typeof event.payload.delta === "string" &&
          event.payload.delta.startsWith("elicitation:"),
      );
      assert.equal(echo?.type, "content.delta");
      if (echo?.type === "content.delta") {
        assert.equal(echo.payload.delta, "elicitation:accept:Red");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces exit-plan permission requests as proposed plans and rejects them", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-exit-plan-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_EXIT_PLAN_PERMISSION: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => String(event.threadId) === String(threadId)),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession(startSessionInput(threadId));
      yield* adapter.sendTurn({
        threadId,
        input: "plan something",
        attachments: [],
        interactionMode: "plan",
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const proposed = runtimeEvents.find((event) => event.type === "turn.proposed.completed");
      assert.equal(proposed?.type, "turn.proposed.completed");
      if (proposed?.type === "turn.proposed.completed") {
        assert.equal(proposed.payload.planMarkdown, "1. Create hello.js\n2. Run node hello.js");
      }

      // The proposal must not open a user-facing approval request; the
      // adapter answers Devin's permission request itself with reject_once.
      assert.isUndefined(runtimeEvents.find((event) => event.type === "request.opened"));
      const echo = runtimeEvents.find(
        (event) =>
          event.type === "content.delta" &&
          typeof event.payload.delta === "string" &&
          event.payload.delta.startsWith("exit-plan:"),
      );
      assert.equal(echo?.type, "content.delta");
      if (echo?.type === "content.delta") {
        assert.equal(echo.payload.delta, "exit-plan:selected:reject_once");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("opens approval requests for tool permissions and honors the user's decision", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-approval-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId) || event.type !== "request.opened") {
            return;
          }
          yield* adapter.respondToRequest(
            threadId,
            ApprovalRequestId.make(String(event.requestId)),
            "accept",
          );
        }),
      ).pipe(Effect.forkChild);

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => String(event.threadId) === String(threadId)),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        ...startSessionInput(threadId),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "run a command",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const opened = runtimeEvents.find((event) => event.type === "request.opened");
      assert.equal(opened?.type, "request.opened");
      if (opened?.type === "request.opened") {
        assert.equal(opened.payload.requestType, "exec_command_approval");
      }
      const resolvedRequest = runtimeEvents.find((event) => event.type === "request.resolved");
      assert.equal(resolvedRequest?.type, "request.resolved");
      if (resolvedRequest?.type === "request.resolved") {
        assert.equal(resolvedRequest.payload.decision, "accept");
      }
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interrupting a turn settles pending approvals and cancels the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-interrupt-thread");
      const approvalOpened = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "request.opened") {
          return Effect.void;
        }
        return Deferred.succeed(approvalOpened, undefined).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        ...startSessionInput(threadId),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "run a command and then get interrupted",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(approvalOpened);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.await(sendTurnFiber);

      assert.equal(yield* adapter.hasSession(threadId), true);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("runs the advertised browser sign-in and retries when a prompt needs auth", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-lazy-auth-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-lazy-auth-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, {
          T3_ACP_REQUIRE_AUTH_FOR_PROMPT: "1",
          T3_ACP_AUTH_STATE_PATH: NodePath.join(tempDir, "credentials-marker"),
        }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => String(event.threadId) === String(threadId)),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession(startSessionInput(threadId));
      yield* adapter.sendTurn({
        threadId,
        input: "hello while signed out",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      // The turn completes normally after the sign-in retry.
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
      }
      const waiting = runtimeEvents.find(
        (event) => event.type === "session.state.changed" && event.payload.state === "waiting",
      );
      assert.isDefined(waiting);
      // The mid-turn session restart is internal: a session.exited here would
      // make orchestration treat the running turn as stopped.
      assert.isUndefined(runtimeEvents.find((event) => event.type === "session.exited"));

      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((entry) => entry.method);
      // No authenticate at startup; exactly one triggered by the failed
      // prompt, using the advertised method id.
      const authenticateRequests = requests.filter((entry) => entry.method === "authenticate");
      assert.equal(authenticateRequests.length, 1);
      assert.equal(
        (authenticateRequests[0]?.params as Record<string, unknown> | undefined)?.methodId,
        "mock-browser",
      );
      assert.isBelow(methods.indexOf("session/prompt"), methods.indexOf("authenticate"));
      // Sessions created before sign-in never see the new credential, so the
      // adapter must have restarted the ACP session for the retry.
      assert.equal(methods.filter((method) => method === "session/new").length, 2);
    }),
  );

  it.effect("skips ACP authenticate and advertises form elicitation on startup", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-auth-probe-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-probe-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() => makeProbeWrapper(requestLogPath));
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession(startSessionInput(threadId));
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((entry) => entry.method);
      assert.include(methods, "initialize");
      // Devin's only advertised auth method opens a browser login; the
      // adapter must rely on stored CLI credentials instead.
      assert.notInclude(methods, "authenticate");

      const initialize = requests.find((entry) => entry.method === "initialize");
      const capabilities = (
        initialize?.params as
          | { clientCapabilities?: { elicitation?: { form?: object } } }
          | undefined
      )?.clientCapabilities;
      assert.isDefined(capabilities?.elicitation?.form);
    }),
  );

  it.effect("resumes a session by loading the persisted Devin session id", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-resume-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-resume-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() => makeProbeWrapper(requestLogPath));
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const session = yield* adapter.startSession({
        ...startSessionInput(threadId),
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const load = requests.find((entry) => entry.method === "session/load");
      assert.isDefined(load);
      assert.equal(
        (load?.params as Record<string, unknown> | undefined)?.sessionId,
        "mock-session-1",
      );
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("devin-bad-provider"),
          provider: ProviderDriverKind.make("codex"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }),
  );
});

const modeState: AcpSessionModeState = {
  currentModeId: "accept-edits",
  availableModes: [
    { id: "accept-edits", name: "Code" },
    { id: "smart", name: "Smart" },
    { id: "ask", name: "Ask" },
    { id: "plan", name: "Plan" },
    { id: "bypass", name: "Bypass Permissions" },
  ],
};

it("maps T3 Code runtime and interaction modes to Devin modes", () => {
  assert.equal(
    resolveRequestedModeId({ interactionMode: "default", runtimeMode: "auto", modeState }),
    "accept-edits",
  );
  assert.equal(
    resolveRequestedModeId({
      interactionMode: "default",
      runtimeMode: "approval-required",
      modeState,
    }),
    "ask",
  );
  assert.equal(
    resolveRequestedModeId({ interactionMode: "default", runtimeMode: "full-access", modeState }),
    "bypass",
  );
  assert.equal(
    resolveRequestedModeId({ interactionMode: "plan", runtimeMode: "auto", modeState }),
    "plan",
  );
});
