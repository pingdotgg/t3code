import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as RpcMessage from "effect/unstable/rpc/RpcMessage";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as RpcSession from "../rpc/session.ts";
import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import { startThreadTurn } from "./commands.ts";

const ROW_COUNT = 600;
const OUTPUT_BYTES_PER_ROW = 8_192;

// Recorded before server-resolved dispatch and raw tool-output wire omission at
// 91b193653ec. The old path read this entire response once for every routine
// implicit-auto message send; keep the raw fixture to preserve that baseline.
const HISTORICAL_FULL_PROJECTION_APPLICATION_BYTES = 10_371_419;
// Projection response + dispatch command + dispatch receipt, excluding RPC
// envelope bytes. The omitted projection request only makes the old path larger.
const HISTORICAL_FORMER_SEND_APPLICATION_BYTES = 10_371_678;
// Corrected measurement: contract-encoded payloads in Effect RPC Request/Exit
// envelopes before WebSocket framing and compression. Trace values use the
// production 32/16 hex-character widths so the byte cost is representative.
const FORMER_SEND_RPC_JSON_BYTES = 10_372_184;
// The corrected first server-resolved implementation measured 522 bytes.
const MAX_CURRENT_SEND_RPC_JSON_BYTES = 1_024;

const RPC_TRACE_CONTEXT = {
  traceId: "0".repeat(32),
  spanId: "0".repeat(16),
  sampled: true,
} as const;

const encodeGetThreadProjectionInput = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.getThreadProjection.input),
);
const encodeGetThreadProjectionOutput = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.getThreadProjection.output),
);
const encodeDispatchCommandInput = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.dispatchCommand.input),
);
const encodeDispatchCommandOutput = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.dispatchCommand.output),
);

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function encodedRpcRequestBytes(input: {
  readonly requestId: number;
  readonly tag: string;
  readonly payload: unknown;
}): number {
  const request = {
    _tag: "Request",
    id: input.requestId,
    tag: input.tag,
    payload: input.payload,
    ...RPC_TRACE_CONTEXT,
    headers: [],
  } satisfies RpcMessage.RequestEncoded;
  return encodedBytes(request);
}

function encodedRpcSuccessBytes(input: {
  readonly requestId: number;
  readonly value: unknown;
}): number {
  const response = {
    _tag: "Exit",
    requestId: input.requestId,
    exit: { _tag: "Success", value: input.value },
  } satisfies RpcMessage.ResponseExitEncoded;
  return encodedBytes(response);
}

function makeLargeProjection(): OrchestrationV2ThreadProjection {
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = Array.from(
    { length: ROW_COUNT },
    (_, index) => {
      const item: OrchestrationV2TurnItem = {
        id: TurnItemId.make(`item-${index}`),
        type: "command_execution",
        threadId: v2ThreadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index + 1,
        status: "completed",
        title: `Command ${index}`,
        input: `cmd-${index}`,
        output: "x".repeat(OUTPUT_BYTES_PER_ROW),
        exitCode: 0,
        startedAt: v2Now,
        completedAt: v2Now,
        updatedAt: v2Now,
      };
      return {
        position: index,
        visibility: "local",
        sourceThreadId: v2ThreadId,
        sourceItemId: item.id,
        item,
      };
    },
  );

  return {
    ...v2Projection,
    turnItems: visibleTurnItems.map((row) => row.item),
    visibleTurnItems,
  };
}

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-perf"),
  label: "Performance fixture",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const makeSupervisor = Effect.fn("CommandPerformance.makeSupervisor")(function* (input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly projectionRequests: Array<unknown>;
  readonly projectionResponseBytes: { value: number };
  readonly commands: OrchestrationV2Command[];
}) {
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (requestInput: unknown) =>
      Effect.sync(() => {
        input.projectionRequests.push(requestInput);
        input.projectionResponseBytes.value += encodedBytes(input.projection);
        return input.projection;
      }),
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
      Effect.sync(() => {
        input.commands.push(command);
        return { sequence: input.commands.length };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({
      environment: {
        capabilities: {
          repositoryIdentity: true,
          serverResolvedCommandContext: true,
        },
      },
    } as never),
    subscribeServerConfig: (requestInput) => client.subscribeServerConfig(requestInput),
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

describe("routine command transport budget", () => {
  it.effect("dispatches an implicit-auto message without a full projection round trip", () =>
    Effect.gen(function* () {
      const projection = makeLargeProjection();
      const projectionRequests: unknown[] = [];
      const projectionResponseBytes = { value: 0 };
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({
        projection,
        projectionRequests,
        projectionResponseBytes,
        commands,
      });

      const receipt = yield* startThreadTurn({
        commandId: CommandId.make("perf-send"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-perf"),
          role: "user",
          text: "continue",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        titleSeed: "continue",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      const command = commands[0]!;
      if (command.type !== "message.dispatch") {
        throw new Error(`Expected message.dispatch, received ${command.type}`);
      }
      if (!("sequence" in receipt)) {
        throw new Error("Expected a dispatch receipt");
      }
      const { deliveryIntent: _deliveryIntent, ...formerCommand } = command;

      const historicalApplicationBytes =
        encodedBytes(projection) + encodedBytes(formerCommand) + encodedBytes(receipt);
      const projectionRequestRpcJsonBytes = encodedRpcRequestBytes({
        requestId: 0,
        tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
        payload: encodeGetThreadProjectionInput({ threadId: v2ThreadId }),
      });
      const projectionResponseRpcJsonBytes = encodedRpcSuccessBytes({
        requestId: 0,
        value: encodeGetThreadProjectionOutput(projection),
      });
      const formerDispatchRequestRpcJsonBytes = encodedRpcRequestBytes({
        requestId: 1,
        tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        payload: encodeDispatchCommandInput(formerCommand),
      });
      const currentDispatchRequestRpcJsonBytes = encodedRpcRequestBytes({
        requestId: 1,
        tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        payload: encodeDispatchCommandInput(command),
      });
      const receiptRpcJsonBytes = encodedRpcSuccessBytes({
        requestId: 1,
        value: encodeDispatchCommandOutput(receipt),
      });
      const formerRpcJsonBytes =
        projectionRequestRpcJsonBytes +
        projectionResponseRpcJsonBytes +
        formerDispatchRequestRpcJsonBytes +
        receiptRpcJsonBytes;
      const currentRpcJsonBytes = currentDispatchRequestRpcJsonBytes + receiptRpcJsonBytes;

      expect(encodedBytes(projection)).toBe(HISTORICAL_FULL_PROJECTION_APPLICATION_BYTES);
      expect(historicalApplicationBytes).toBe(HISTORICAL_FORMER_SEND_APPLICATION_BYTES);
      expect(formerRpcJsonBytes).toBe(FORMER_SEND_RPC_JSON_BYTES);
      expect(projectionRequests).toEqual([]);
      expect(projectionResponseBytes.value).toBe(0);
      expect(command).toMatchObject({
        type: "message.dispatch",
        deliveryIntent: "auto",
        dispatchMode: { type: "start_immediately" },
      });
      expect(currentRpcJsonBytes).toBeLessThanOrEqual(MAX_CURRENT_SEND_RPC_JSON_BYTES);
      expect(currentRpcJsonBytes / formerRpcJsonBytes).toBeLessThanOrEqual(0.000_06);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );
});
