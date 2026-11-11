import {
  EventId,
  OrchestrationV2RpcSchemas,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import { describe, expect, it } from "vite-plus/test";

import { projectDomainEventForWire } from "./WireProjection.ts";

const OUTPUT_BYTES_PER_ROW = 8_192;
const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const THREAD_ID = ThreadId.make("thread-perf");

const PRE_OMISSION_COMMAND_EVENT_RPC_JSON_BYTES = 8_790;
const MAX_PROJECTED_COMMAND_EVENT_RPC_JSON_BYTES = 1_024;

const encodeThreadStreamItem = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.subscribeThread.output),
);

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function encodedThreadStreamChunkBytes(value: OrchestrationV2ThreadStreamItem): number {
  const response = {
    _tag: "Chunk",
    requestId: 0,
    values: [encodeThreadStreamItem(value)],
  } satisfies RpcMessage.ResponseChunkEncoded;
  return encodedBytes(response);
}

function makeCommandItem(index: number): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`item-${index}`),
    type: "command_execution",
    threadId: THREAD_ID,
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
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  };
}

function makeTurnItemEvent(item: OrchestrationV2TurnItem): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${item.id}`),
    type: "turn-item.updated",
    threadId: THREAD_ID,
    occurredAt: NOW,
    payload: item,
  };
}

describe("thread transport payload budget", () => {
  it("omits command output from a live event without changing persisted source data", () => {
    const sourceItem = makeCommandItem(0);
    const sourceEvent = makeTurnItemEvent(sourceItem);
    const projectedEvent = projectDomainEventForWire(sourceEvent);
    const preOmissionStreamItem: OrchestrationV2ThreadStreamItem = {
      kind: "event",
      sequence: 1,
      event: sourceEvent,
    };
    const projectedStreamItem: OrchestrationV2ThreadStreamItem = {
      kind: "event",
      sequence: 1,
      event: projectedEvent,
    };

    const preOmissionRpcJsonBytes = encodedThreadStreamChunkBytes(preOmissionStreamItem);
    const projectedRpcJsonBytes = encodedThreadStreamChunkBytes(projectedStreamItem);

    expect(preOmissionRpcJsonBytes).toBe(PRE_OMISSION_COMMAND_EVENT_RPC_JSON_BYTES);
    expect(projectedRpcJsonBytes).toBeLessThanOrEqual(MAX_PROJECTED_COMMAND_EVENT_RPC_JSON_BYTES);
    expect(projectedRpcJsonBytes / preOmissionRpcJsonBytes).toBeLessThanOrEqual(0.1);
    expect(sourceItem).toHaveProperty("output", "x".repeat(OUTPUT_BYTES_PER_ROW));
    expect(projectedEvent.payload).not.toHaveProperty("output");
  });
});
