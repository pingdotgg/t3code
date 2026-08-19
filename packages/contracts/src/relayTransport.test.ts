import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";

import {
  decodeRelayTransportControlFrame,
  decodeRelayTransportFrame,
  encodeRelayTransportControlFrame,
  encodeRelayTransportFrame,
  encodeRelayTransportMessageFrames,
  normalizeRelayWebSocketCloseCode,
  RELAY_TRANSPORT_FRAME_HEADER_BYTES,
  RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES,
  RELAY_TRANSPORT_MAX_MESSAGE_BYTES,
  RelayTransportMessageAssembler,
  RelayTransportFrameKind,
} from "./relayTransport.ts";

describe("relay transport frames", () => {
  it("fragments messages at the payload limit and marks only the final frame complete", () => {
    const payload = new Uint8Array(RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES + 7);
    payload.fill(3);
    const encoded = encodeRelayTransportMessageFrames({
      kind: RelayTransportFrameKind.websocketBinary,
      streamId: 8,
      payload,
    });

    expect(encoded).toHaveLength(2);
    const decoded = encoded.map(decodeRelayTransportFrame);
    expect(decoded.every(Result.isSuccess)).toBe(true);
    if (!decoded.every(Result.isSuccess)) return;
    expect(decoded[0]!.success.endOfMessage).toBe(false);
    expect(decoded[0]!.success.payload).toHaveLength(RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES);
    expect(decoded[1]!.success.endOfMessage).toBe(true);
    expect(decoded[1]!.success.payload).toHaveLength(7);
  });

  it("rejects messages above the bounded reassembly limit", () => {
    expect(() =>
      encodeRelayTransportMessageFrames({
        kind: RelayTransportFrameKind.websocketBinary,
        streamId: 8,
        payload: new Uint8Array(RELAY_TRANSPORT_MAX_MESSAGE_BYTES + 1),
      }),
    ).toThrow(/message exceeds/u);
  });

  it("reassembles fragmented WebSocket messages", () => {
    const assembler = new RelayTransportMessageAssembler();
    expect(
      assembler.append({
        kind: RelayTransportFrameKind.websocketText,
        streamId: 3,
        endOfMessage: false,
        payload: new TextEncoder().encode("hello "),
      }),
    ).toBeNull();
    const message = assembler.append({
      kind: RelayTransportFrameKind.websocketText,
      streamId: 3,
      endOfMessage: true,
      payload: new TextEncoder().encode("world"),
    });

    expect(message?.kind).toBe(RelayTransportFrameKind.websocketText);
    expect(new TextDecoder().decode(message?.payload)).toBe("hello world");
  });

  it("round trips binary payloads without copying their contents into JSON", () => {
    const encoded = encodeRelayTransportFrame({
      kind: RelayTransportFrameKind.websocketBinary,
      streamId: 42,
      endOfMessage: true,
      payload: Uint8Array.of(0, 1, 127, 128, 255),
    });
    const decoded = decodeRelayTransportFrame(encoded);

    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.kind).toBe(RelayTransportFrameKind.websocketBinary);
      expect(decoded.success.streamId).toBe(42);
      expect(decoded.success.endOfMessage).toBe(true);
      expect([...decoded.success.payload]).toEqual([0, 1, 127, 128, 255]);
    }
  });

  it("decodes subarray views without reading bytes outside the view", () => {
    const frame = encodeRelayTransportFrame({
      kind: RelayTransportFrameKind.httpResponseBody,
      streamId: 7,
      endOfMessage: false,
      payload: Uint8Array.of(9, 8, 7),
    });
    const container = new Uint8Array(frame.length + 6);
    container.set(frame, 3);
    const decoded = decodeRelayTransportFrame(container.subarray(3, 3 + frame.length));

    expect(Result.isSuccess(decoded) && [...decoded.success.payload]).toEqual([9, 8, 7]);
  });

  it("rejects malformed headers and reserved flags", () => {
    const tooShort = decodeRelayTransportFrame(
      new Uint8Array(RELAY_TRANSPORT_FRAME_HEADER_BYTES - 1),
    );
    expect(Result.isFailure(tooShort) && tooShort.failure.reason).toBe("header_too_short");

    const frame = encodeRelayTransportFrame({
      kind: RelayTransportFrameKind.httpRequestBody,
      streamId: 1,
      endOfMessage: false,
      payload: new Uint8Array(),
    });
    new DataView(frame.buffer).setUint16(6, 2);
    const invalidFlags = decodeRelayTransportFrame(frame);
    expect(Result.isFailure(invalidFlags) && invalidFlags.failure.reason).toBe("invalid_flags");
  });

  it("reserves stream zero for connection-level control", () => {
    const frame = encodeRelayTransportFrame({
      kind: RelayTransportFrameKind.websocketText,
      streamId: 0,
      endOfMessage: true,
      payload: new Uint8Array(),
    });
    const decoded = decodeRelayTransportFrame(frame);

    expect(Result.isFailure(decoded) && decoded.failure.reason).toBe("invalid_stream_id");
  });

  it("bounds frame payloads before allocation", () => {
    expect(() =>
      encodeRelayTransportFrame({
        kind: RelayTransportFrameKind.httpRequestBody,
        streamId: 1,
        endOfMessage: false,
        payload: new Uint8Array(RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES + 1),
      }),
    ).toThrow(/exceeds/u);
  });
});

describe("relay transport control messages", () => {
  it("round trips HTTP request metadata", () => {
    const encoded = encodeRelayTransportControlFrame(17, {
      type: "http_request_start",
      method: "POST",
      url: "https://environment.example.test/oauth/token?attempt=1",
      headers: [
        ["content-type", "application/x-www-form-urlencoded"],
        ["dpop", "proof"],
      ],
    });
    const frame = decodeRelayTransportFrame(encoded);
    expect(Result.isSuccess(frame)).toBe(true);
    if (Result.isSuccess(frame)) {
      const control = decodeRelayTransportControlFrame(frame.success);
      expect(Result.isSuccess(control) && control.success).toEqual({
        type: "http_request_start",
        method: "POST",
        url: "https://environment.example.test/oauth/token?attempt=1",
        headers: [
          ["content-type", "application/x-www-form-urlencoded"],
          ["dpop", "proof"],
        ],
      });
    }
  });

  it("rejects invalid status codes", () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({ type: "http_response_start", status: 700, headers: [] }),
    );
    const decoded = decodeRelayTransportControlFrame({
      kind: RelayTransportFrameKind.control,
      streamId: 3,
      endOfMessage: true,
      payload: encoded,
    });

    expect(Result.isFailure(decoded)).toBe(true);
  });

  it("rejects unsendable WebSocket close codes and normalizes abnormal closes", () => {
    const decoded = decodeRelayTransportControlFrame({
      kind: RelayTransportFrameKind.control,
      streamId: 3,
      endOfMessage: true,
      payload: new TextEncoder().encode(
        JSON.stringify({ type: "websocket_close", code: 1006, reason: "abnormal" }),
      ),
    });

    expect(Result.isFailure(decoded)).toBe(true);
    expect(normalizeRelayWebSocketCloseCode(1006)).toBe(1011);
    expect(normalizeRelayWebSocketCloseCode(4003)).toBe(4003);
  });

  it("requires control messages to fit in one complete frame", () => {
    const decoded = decodeRelayTransportControlFrame({
      kind: RelayTransportFrameKind.control,
      streamId: 3,
      endOfMessage: false,
      payload: new Uint8Array(),
    });

    expect(Result.isFailure(decoded)).toBe(true);
  });
});
