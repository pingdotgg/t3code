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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  AntigravitySettings,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  antigravityPromptSettlementBelongsToContext,
  makeAntigravityAdapter,
} from "./AntigravityAdapter.ts";
const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockAntigravityWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "antigravity-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-antigravity.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
export T3_PROVIDER=antigravity
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const antigravityAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-antigravity-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (
  binaryPath: string,
  options?: Parameters<typeof makeAntigravityAdapter>[1],
) => makeAntigravityAdapter(decodeAntigravitySettings({ binaryPath }), options).pipe(Effect.orDie);

it("requires a settlement to match the live Antigravity turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    antigravityPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    antigravityPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    antigravityPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it.layer(antigravityAdapterTestLayer)("AntigravityAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("antigravity-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockAntigravityWrapper());
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
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      assert.strictEqual(session.provider, "antigravity");
      assert.strictEqual(session.status, "ready");

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock agent",
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const eventTypes = runtimeEvents.map((e) => e.type);
      assert.isTrue(eventTypes.includes("turn.started"));
      assert.isTrue(eventTypes.includes("turn.completed"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles permission requests and approvals", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("antigravity-approval-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAntigravityWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const requestOpened = yield* Deferred.make<ApprovalRequestId>();
      const turnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.type === "request.opened" && event.requestId) {
            yield* Deferred.succeed(requestOpened, ApprovalRequestId.make(event.requestId));
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "trigger permission",
        })
        .pipe(Effect.forkChild);

      const requestId = yield* Deferred.await(requestOpened);
      yield* adapter.respondToRequest(threadId, requestId, "accept");

      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-approves permissions in full-access runtime mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("antigravity-full-access-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAntigravityWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "trigger permission with auto-approval",
      });

      const requestOpenedEvents = runtimeEvents.filter((e) => e.type === "request.opened");
      assert.lengthOf(requestOpenedEvents, 0);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("interruptTurn cancels an in-flight prompt and restores ready status", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("antigravity-interrupt-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAntigravityWrapper({
          T3_ACP_HANG_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({
        threadId,
        input: "hang forever",
        attachments: [],
      });

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

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("steers an in-flight prompt by folding into active turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("antigravity-steer-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAntigravityWrapper({
          T3_ACP_PROMPT_DELAY_MS: "300",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "first prompt",
        })
        .pipe(Effect.forkChild);

      yield* Effect.sleep("100 millis");

      const secondTurnResult = yield* adapter.sendTurn({
        threadId,
        input: "steer while first is running",
      });

      const firstTurnResult = yield* Fiber.join(firstTurnFiber);

      assert.strictEqual(firstTurnResult.turnId, secondTurnResult.turnId);

      const turnStartedEvents = runtimeEvents.filter(
        (e) => e.type === "turn.started" && String(e.threadId) === String(threadId),
      );
      const turnCompletedEvents = runtimeEvents.filter(
        (e) => e.type === "turn.completed" && String(e.threadId) === String(threadId),
      );

      assert.lengthOf(turnStartedEvents, 1);
      assert.lengthOf(turnCompletedEvents, 1);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects rollbackThread with request error", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("antigravity-rollback-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockAntigravityWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const rollbackResult = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
      assert.isTrue(rollbackResult._tag === "Failure");

      yield* adapter.stopSession(threadId);
    }),
  );
});
