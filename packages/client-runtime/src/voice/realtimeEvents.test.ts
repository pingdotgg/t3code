import { describe, expect, it } from "vite-plus/test";

import {
  decodeRealtimeServerEvent,
  decodeRealtimeServerEventMessage,
  extractRealtimeFunctionCalls,
  MAX_REALTIME_EVENT_JSON_CHARS,
} from "./realtimeEvents.ts";

describe("Realtime server event decoding", () => {
  it("accepts only the server events the voice UI consumes", () => {
    expect(
      decodeRealtimeServerEventMessage(
        JSON.stringify({
          event_id: "event-1",
          type: "response.output_audio_transcript.delta",
          response_id: "response-1",
          item_id: "item-1",
          delta: "Hello",
          ignored_upstream_field: true,
        }),
      ),
    ).toMatchObject({ type: "response.output_audio_transcript.delta", delta: "Hello" });

    expect(
      decodeRealtimeServerEvent({ event_id: "event-2", type: "rate_limits.updated" }),
    ).toBeNull();
    expect(
      decodeRealtimeServerEvent({ type: "session.created", session: { id: "session-1" } }),
    ).toBeNull();
    expect(decodeRealtimeServerEventMessage("not json")).toBeNull();
    expect(decodeRealtimeServerEventMessage(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(
      decodeRealtimeServerEventMessage("x".repeat(MAX_REALTIME_EVENT_JSON_CHARS + 1)),
    ).toBeNull();
  });

  it("accepts a sparse transcription failure error from the current protocol", () => {
    expect(
      decodeRealtimeServerEvent({
        event_id: "transcription-failed",
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "item-1",
        error: {},
      }),
    ).toEqual({
      event_id: "transcription-failed",
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item-1",
      error: {},
    });
  });

  it("keeps the bounded client event id used to correlate provider errors", () => {
    expect(
      decodeRealtimeServerEvent({
        event_id: "server-error",
        type: "error",
        error: { event_id: "t3-voice-1-1-continue", message: "must stay hidden" },
      }),
    ).toEqual({
      event_id: "server-error",
      type: "error",
      error: { event_id: "t3-voice-1-1-continue", message: "must stay hidden" },
    });
  });

  it("extracts complete canonical function calls only from response.done", () => {
    const event = decodeRealtimeServerEvent({
      event_id: "event-done",
      type: "response.done",
      response: {
        id: "response-1",
        status: "completed",
        output: [
          {
            id: "call-item-1",
            type: "function_call",
            call_id: "call-1",
            name: "open_thread",
            arguments: '{"title":"Voice follow-up"}',
            status: "completed",
          },
          {
            id: "call-item-2",
            type: "function_call",
            call_id: "call-2",
            name: "partial_tool",
            arguments: "{",
            status: "in_progress",
          },
          {
            id: "call-item-3",
            type: "function_call",
            call_id: "call-3",
            name: "incomplete_tool",
            arguments: "{}",
            status: "incomplete",
          },
          { id: "message-1", type: "message", content: [] },
          { id: "malformed", type: "function_call", name: "missing_call_id" },
        ],
      },
    });

    expect(event).not.toBeNull();
    expect(extractRealtimeFunctionCalls(event!)).toEqual([
      {
        itemId: "call-item-1",
        callId: "call-1",
        name: "open_thread",
        arguments: '{"title":"Voice follow-up"}',
      },
    ]);
  });

  it("does not execute calls from a non-completed response", () => {
    const event = decodeRealtimeServerEvent({
      event_id: "event-done",
      type: "response.done",
      response: {
        id: "response-1",
        status: "cancelled",
        output: [
          {
            id: "call-item-1",
            type: "function_call",
            call_id: "call-1",
            name: "open_thread",
            arguments: "{}",
            status: "completed",
          },
        ],
      },
    });

    expect(event).not.toBeNull();
    expect(extractRealtimeFunctionCalls(event!)).toEqual([]);
  });
});
