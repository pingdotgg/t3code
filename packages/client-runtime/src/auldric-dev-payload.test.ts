import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "./connection/model.ts";
import type { PreparedConnection } from "./connection/model.ts";
import * as EnvironmentSupervisor from "./connection/supervisor.ts";
import { startThreadTurn } from "./operations/commands.ts";
import type { WsRpcProtocolClient } from "./rpc/protocol.ts";
import type * as RpcSession from "./rpc/session.ts";

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const makeSupervisor = Effect.fn("AuldricDevPayload.makeSupervisor")(function* (
  dispatched: ClientOrchestrationCommand[],
) {
  const client = {
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

it.effect("keeps the native Dev turn payload free of Auldric product context", () =>
  Effect.gen(function* () {
    const dispatched: ClientOrchestrationCommand[] = [];
    const supervisor = yield* makeSupervisor(dispatched);

    yield* startThreadTurn({
      commandId: CommandId.make("dev-turn-command"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Keep this native Dev request unchanged.",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-06-06T00:02:00.000Z",
    }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

    expect(dispatched).toEqual([
      {
        type: "thread.turn.start",
        commandId: "dev-turn-command",
        threadId: "thread-1",
        message: {
          messageId: "message-1",
          role: "user",
          text: "Keep this native Dev request unchanged.",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-06-06T00:02:00.000Z",
      },
    ]);
  }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
);
