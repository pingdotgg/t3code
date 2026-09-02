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
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  makeHermesAdapter,
  resolveRequestedModeId,
  selectAutoApprovedPermissionOption,
} from "./HermesAdapter.ts";

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

const hermesAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeHermesAdapter>[1]) =>
  makeHermesAdapter(decodeHermesSettings({ binaryPath }), options).pipe(Effect.orDie);

it("auto-approves with allow_always when the agent offers it", () => {
  const optionId = selectAutoApprovedPermissionOption({
    sessionId: "mock-session-1",
    toolCall: { toolCallId: "tool-1" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  assert.equal(optionId, "allow-always");
});

it("auto-approves with allow_once when allow_always is absent", () => {
  const optionId = selectAutoApprovedPermissionOption({
    sessionId: "mock-session-1",
    toolCall: { toolCallId: "tool-1" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  assert.equal(optionId, "allow-once");
});

it("auto-approves nothing when the agent offers no allow options", () => {
  const optionId = selectAutoApprovedPermissionOption({
    sessionId: "mock-session-1",
    toolCall: { toolCallId: "tool-1" },
    options: [{ optionId: "reject-once", name: "Reject", kind: "reject_once" }],
  });
  assert.isUndefined(optionId);
});

it("resolves plan interaction mode to the agent's plan mode", () => {
  const modeId = resolveRequestedModeId({
    interactionMode: "plan",
    runtimeMode: "full-access",
    modeState: {
      currentModeId: "implement",
      availableModes: [
        { id: "plan", name: "Plan" },
        { id: "implement", name: "Implement" },
      ],
    },
  });
  assert.equal(modeId, "plan");
});

it("resolves approval-required to an approval-shaped mode before implement", () => {
  const modeId = resolveRequestedModeId({
    interactionMode: undefined,
    runtimeMode: "approval-required",
    modeState: {
      currentModeId: "implement",
      availableModes: [
        { id: "ask", name: "Ask" },
        { id: "implement", name: "Implement" },
      ],
    },
  });
  assert.equal(modeId, "ask");
});

it("resolves no mode when the agent advertises none", () => {
  const modeId = resolveRequestedModeId({
    interactionMode: undefined,
    runtimeMode: "full-access",
    modeState: undefined,
  });
  assert.isUndefined(modeId);
});

it.layer(hermesAdapterTestLayer)("HermesAdapter (mock ACP agent)", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-mock-thread");
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
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "grok-mock-alt",
        },
      });

      assert.equal(session.provider, "hermes");
      assert.equal(session.model, "grok-mock-alt");

      yield* adapter.sendTurn({
        threadId,
        input: "hello hermes",
        attachments: [],
      });

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

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("merges a sendTurn racing session configuration into the in-flight turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-steer-race");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_EMIT_CONTENT_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const contentDelta = yield* Deferred.make<void>();
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "content.delta") {
            yield* Deferred.succeed(contentDelta, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      // Steer while the first prompt is still in flight. The steer must
      // observe the first turn's id — assigned synchronously with the
      // in-flight increment, before the awaited session configuration — and
      // merge into it; a second turn.started is the duplicate-turn
      // regression.
      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "start work", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(contentDelta).pipe(Effect.timeout("2 seconds"), TestClock.withLive);

      const steerSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "steer the running turn", attachments: [] })
        .pipe(Effect.forkChild);
      for (let yieldAttempt = 0; yieldAttempt < 12; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      // The steer folded into the running turn: exactly one turn.started,
      // one distinct turn id. A second of either is the regression.
      const turnStartedEvents = runtimeEvents.filter((event) => event.type === "turn.started");
      assert.lengthOf(turnStartedEvents, 1);
      const turnIds = new Set(
        runtimeEvents
          .filter((event) => event.type === "turn.started")
          .map((event) => String(event.turnId)),
      );
      assert.equal(turnIds.size, 1);

      // interruptTurn settles both in-flight prompts; stopSession tears the
      // hung mock child down regardless.
      yield* adapter.interruptTurn(threadId).pipe(Effect.ignore);
      yield* Fiber.interrupt(firstSendTurnFiber);
      yield* Fiber.interrupt(steerSendTurnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId).pipe(Effect.ignore);
    }),
  );
});
