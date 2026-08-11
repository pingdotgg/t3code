import { describe, expect, it, vi } from "@effect/vitest";

import {
  MAX_REALTIME_CLIENT_EVENT_ID_CHARS,
  RealtimeSessionError,
  serializeRealtimeSessionUpdate,
  serializeRealtimeToolOutputBatch,
} from "./realtimeTransport.ts";

function serializationFailure() {
  return expect.objectContaining({
    name: "RealtimeSessionError",
    reason: "serialization_failed",
    message: "The voice message could not be prepared.",
  });
}

describe("Realtime transport serialization", () => {
  it("serializes the exact session update wire event", () => {
    expect(
      serializeRealtimeSessionUpdate({
        type: "realtime",
        instructions: "Keep the user informed.",
      }),
    ).toBe(
      '{"type":"session.update","session":{"type":"realtime","instructions":"Keep the user informed."}}',
    );
  });

  it("rejects a non-serializable session update with a redacted error", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() =>
      serializeRealtimeSessionUpdate({ type: "realtime", instructions: circular }),
    ).toThrow(serializationFailure());
    expect(() =>
      serializeRealtimeSessionUpdate({ type: "realtime", instructions: BigInt(1) }),
    ).toThrow(serializationFailure());
  });

  it("serializes every tool result before one response continuation in wire order", () => {
    const encoded = serializeRealtimeToolOutputBatch({
      outputs: [
        { eventId: "output-1", callId: "call-1", output: { threadId: "thread-1" } },
        { eventId: "output-2", callId: "call-2", output: "Second result" },
      ],
      responseCreateEventId: "continue-1",
    });

    expect(encoded).toEqual([
      '{"event_id":"output-1","type":"conversation.item.create","item":{"type":"function_call_output","call_id":"call-1","output":"{\\"threadId\\":\\"thread-1\\"}"}}',
      '{"event_id":"output-2","type":"conversation.item.create","item":{"type":"function_call_output","call_id":"call-2","output":"Second result"}}',
      '{"event_id":"continue-1","type":"response.create"}',
    ]);
  });

  it("enforces bounded trimmed client event IDs and preserves the empty-batch no-op", () => {
    const maximumId = "x".repeat(MAX_REALTIME_CLIENT_EVENT_ID_CHARS);
    expect(
      serializeRealtimeToolOutputBatch({
        outputs: [{ eventId: maximumId, callId: "call", output: null }],
        responseCreateEventId: maximumId,
      }),
    ).toHaveLength(2);

    for (const eventId of ["", " padded", "padded ", `${maximumId}x`]) {
      expect(() =>
        serializeRealtimeToolOutputBatch({
          outputs: [{ eventId, callId: "call", output: null }],
          responseCreateEventId: "continue",
        }),
      ).toThrow(serializationFailure());
      expect(() =>
        serializeRealtimeToolOutputBatch({
          outputs: [{ eventId: "output", callId: "call", output: null }],
          responseCreateEventId: eventId,
        }),
      ).toThrow(serializationFailure());
    }

    expect(
      serializeRealtimeToolOutputBatch({ outputs: [], responseCreateEventId: " invalid " }),
    ).toEqual([]);
  });

  it("preserves string output and JSON null fallback behavior", () => {
    const encoded = serializeRealtimeToolOutputBatch({
      outputs: [
        { eventId: "string", callId: "call-1", output: 'already {"json":true}' },
        { eventId: "null", callId: "call-2", output: null },
        { eventId: "undefined", callId: "call-3", output: undefined },
        { eventId: "function", callId: "call-4", output: () => undefined },
        { eventId: "symbol", callId: "call-5", output: Symbol("not-json") },
        { eventId: "nan", callId: "call-6", output: Number.NaN },
      ],
      responseCreateEventId: "continue",
    });
    const outputs = encoded.slice(0, -1).map((event) => {
      const decoded = JSON.parse(event) as { readonly item: { readonly output: string } };
      return decoded.item.output;
    });

    expect(outputs).toEqual(['already {"json":true}', "null", "null", "null", "null", "null"]);
  });

  it("rejects cycles and throwing or unsupported JSON values", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const throwing = {
      toJSON() {
        throw new Error("must stay redacted");
      },
    };

    for (const output of [circular, throwing, BigInt(1)]) {
      expect(() =>
        serializeRealtimeToolOutputBatch({
          outputs: [{ eventId: "output", callId: "call", output }],
          responseCreateEventId: "continue",
        }),
      ).toThrow(serializationFailure());
    }
  });

  it("prepares a batch all-or-nothing before a caller can send", () => {
    const send = vi.fn<(event: string) => void>();
    const circular: { self?: unknown } = {};
    circular.self = circular;

    try {
      for (const encoded of serializeRealtimeToolOutputBatch({
        outputs: [
          { eventId: "output-1", callId: "call-1", output: { ok: true } },
          { eventId: "output-2", callId: "call-2", output: circular },
        ],
        responseCreateEventId: "continue",
      })) {
        send(encoded);
      }
    } catch (error) {
      expect(error).toEqual(serializationFailure());
    }

    expect(send).not.toHaveBeenCalled();
  });

  it("keeps transport errors redacted while retaining safe reason and status", () => {
    expect(new RealtimeSessionError("upstream_rejected", 429)).toMatchObject({
      name: "RealtimeSessionError",
      reason: "upstream_rejected",
      status: 429,
      message: "The voice provider rejected the connection.",
    });
  });
});
