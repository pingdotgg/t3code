import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HermesGatewayRequestId,
  HermesGatewaySessionId,
  ProviderInstanceId,
  ThreadId,
  type HermesGatewayT3ToPluginMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  HermesGatewayBroker,
  type HermesGatewayBrokerShape,
  type HermesGatewayEnvelope,
} from "../Services/HermesGatewayBroker.ts";
import {
  makeHermesAdapter,
  sanitizeHermesItemData,
  sanitizeHermesRequestArgs,
  shouldProjectHermesTurnStarted,
} from "./HermesAdapter.ts";

it("sanitizes persisted gateway payloads and suppresses steering acknowledgements", () => {
  assert.deepEqual(
    sanitizeHermesItemData("command_execution", {
      command: "git status",
      cwd: "/workspace",
      arbitrarySecret: "drop-me",
      result: { unbounded: true },
    }),
    { command: "git status", cwd: "/workspace" },
  );
  assert.deepEqual(
    sanitizeHermesRequestArgs("command_execution_approval", {
      command: "git push",
      arbitrarySecret: "drop-me",
    }),
    { command: "git push" },
  );
  const steerRequestId = HermesGatewayRequestId.make("steer-request");
  const startRequestId = HermesGatewayRequestId.make("start-request");
  const pendingSteerRequestIds = new Set([steerRequestId]);
  assert.isFalse(shouldProjectHermesTurnStarted(pendingSteerRequestIds, steerRequestId));
  assert.isTrue(shouldProjectHermesTurnStarted(pendingSteerRequestIds, startRequestId));
  assert.isFalse(pendingSteerRequestIds.has(steerRequestId));
});

it.effect("keeps cwd local while forwarding turn text byte-for-byte and steering follow-ups", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("hermes_remote");
    const threadId = ThreadId.make("thread-1");
    const sessionId = HermesGatewaySessionId.make("session-1");
    const sent: Array<HermesGatewayT3ToPluginMessage> = [];
    const brokerEvents = yield* PubSub.unbounded<HermesGatewayEnvelope>();
    const broker: HermesGatewayBrokerShape = {
      createEnrollment: () => Effect.die(new Error("unused")),
      getInstanceStatus: () => Effect.die(new Error("unused")),
      listInstances: Effect.succeed([]),
      revokeInstance: () => Effect.die(new Error("unused")),
      registerConnection: () => Effect.die(new Error("unused")),
      receive: () => Effect.void,
      disconnect: () => Effect.void,
      request: (_instanceId, message) => {
        sent.push(message);
        if (message.type === "session.ensure") {
          return Effect.succeed({
            type: "session.ready",
            protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
            requestId: message.requestId,
            threadId: message.threadId,
            sessionId,
            resumed: false,
          });
        }
        if (message.type === "turn.start" || message.type === "turn.steer") {
          return Effect.succeed({
            type: "turn.started",
            protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
            requestId: message.requestId,
            threadId: message.threadId,
            sessionId: message.sessionId,
            turnId: message.turnId,
          });
        }
        return Effect.die(new Error(`unexpected request ${message.type}`));
      },
      send: (_instanceId, message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
      isConnected: () => Effect.succeed(true),
      stream: Stream.fromPubSub(brokerEvents),
      streamStatuses: Stream.empty,
    };
    const adapter = yield* makeHermesAdapter({ instanceId }).pipe(
      Effect.provideService(HermesGatewayBroker, broker),
    );
    yield* Effect.yieldNow;
    const session = yield* adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      cwd: "/must/not/leak",
      runtimeMode: "full-access",
    });
    assert.equal(session.cwd, "/must/not/leak");
    const sessionEnsure = sent.find((message) => message.type === "session.ensure");
    assert.isFalse(sessionEnsure !== undefined && "cwd" in sessionEnsure);

    const original = "  /help keep all whitespace  \n";
    yield* adapter.sendTurn({ threadId, input: original });
    const turnStart = sent.find((message) => message.type === "turn.start");
    assert.equal(turnStart?.type === "turn.start" ? turnStart.text : undefined, original);

    if (!turnStart || turnStart.type !== "turn.start") {
      return yield* Effect.die(new Error("turn.start was not sent"));
    }
    const startEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "turn.started",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: turnStart.requestId,
        threadId,
        sessionId,
        turnId: turnStart.turnId,
      },
    });
    const startEvent = Option.getOrUndefined(yield* Fiber.join(startEventFiber));
    assert.equal(startEvent?.type, "turn.started");

    yield* adapter.sendTurn({ threadId, input: "follow up" });
    const turnSteer = sent.find((message) => message.type === "turn.steer");
    if (!turnSteer || turnSteer.type !== "turn.steer") {
      return yield* Effect.die(new Error("turn.steer was not sent"));
    }
    const nextEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "turn.started",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: turnSteer.requestId,
        threadId,
        sessionId,
        turnId: turnSteer.turnId,
      },
    });
    yield* PubSub.publish(brokerEvents, {
      instanceId,
      message: {
        type: "content.delta",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        threadId,
        sessionId,
        turnId: turnSteer.turnId,
        streamKind: "assistant_text",
        delta: "continued",
      },
    });
    const nextEvent = Option.getOrUndefined(yield* Fiber.join(nextEventFiber));
    assert.equal(nextEvent?.type, "content.delta");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
