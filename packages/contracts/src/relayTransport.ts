import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const RELAY_TRANSPORT_PROTOCOL_VERSION = 1;
export const RELAY_TRANSPORT_FRAME_HEADER_BYTES = 12;
export const RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES = 64 * 1024;
export const RELAY_TRANSPORT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const RELAY_TRANSPORT_MAX_BUFFERED_MESSAGE_BYTES = 16 * 1024 * 1024;
export const RELAY_TRANSPORT_MAX_MESSAGE_FRAGMENTS = 1024;
export const RELAY_TRANSPORT_MAX_HTTP_REQUEST_BYTES = 16 * 1024 * 1024;
export const RELAY_TRANSPORT_INITIAL_WINDOW_BYTES = 256 * 1024;
export const RELAY_TRANSPORT_MAX_CONCURRENT_STREAMS = 256;
export const RELAY_CONNECTOR_TICKET_TTL_MILLIS = 30_000;

export const RelayConnectorTicketResponse = Schema.Struct({
  ticket: Schema.String.check(Schema.isMinLength(16)),
  expiresAt: Schema.String,
});
export type RelayConnectorTicketResponse = typeof RelayConnectorTicketResponse.Type;

const RELAY_TRANSPORT_FRAME_MAGIC = 0x54335231;
const RELAY_TRANSPORT_END_OF_MESSAGE_FLAG = 1;

export const RelayTransportFrameKind = {
  control: 1,
  httpRequestBody: 2,
  httpResponseBody: 3,
  websocketText: 4,
  websocketBinary: 5,
} as const;

export type RelayTransportFrameKind =
  (typeof RelayTransportFrameKind)[keyof typeof RelayTransportFrameKind];

const RelayTransportHeader = Schema.Tuple([Schema.String, Schema.String]);

export function isRelayWebSocketCloseCode(code: number): boolean {
  return (
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
      (code >= 3000 && code <= 4999))
  );
}

export function normalizeRelayWebSocketCloseCode(code: number): number {
  return isRelayWebSocketCloseCode(code) ? code : 1011;
}

const RelayWebSocketCloseCode = Schema.Int.check(
  Schema.makeFilter(
    (code) =>
      isRelayWebSocketCloseCode(code) || "WebSocket close code must be sendable in a close frame.",
  ),
);

export const RelayTransportControlMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connector_ready"),
    protocolVersion: Schema.Literal(RELAY_TRANSPORT_PROTOCOL_VERSION),
  }),
  Schema.Struct({
    type: Schema.Literal("http_request_start"),
    method: Schema.String,
    url: Schema.String,
    headers: Schema.Array(RelayTransportHeader),
  }),
  Schema.Struct({ type: Schema.Literal("http_request_end") }),
  Schema.Struct({ type: Schema.Literal("http_request_abort"), reason: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("http_response_start"),
    status: Schema.Int.check(Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(599)),
    headers: Schema.Array(RelayTransportHeader),
  }),
  Schema.Struct({ type: Schema.Literal("http_response_end") }),
  Schema.Struct({ type: Schema.Literal("http_response_abort"), reason: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("websocket_open"),
    url: Schema.String,
    headers: Schema.Array(RelayTransportHeader),
    protocols: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("websocket_accept"),
    protocol: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("websocket_reject"),
    status: Schema.Int.check(Schema.isGreaterThanOrEqualTo(400), Schema.isLessThanOrEqualTo(599)),
    reason: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("websocket_close"),
    code: RelayWebSocketCloseCode,
    reason: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("window_update"),
    creditBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);
export type RelayTransportControlMessage = typeof RelayTransportControlMessage.Type;

export interface RelayTransportFrame {
  readonly kind: RelayTransportFrameKind;
  readonly streamId: number;
  readonly endOfMessage: boolean;
  readonly payload: Uint8Array;
}

type RelayTransportWebSocketFrameKind =
  | typeof RelayTransportFrameKind.websocketText
  | typeof RelayTransportFrameKind.websocketBinary;

interface RelayTransportPartialMessage {
  readonly kind: RelayTransportWebSocketFrameKind;
  readonly chunks: Array<Uint8Array>;
  byteLength: number;
  fragmentCount: number;
}

export interface RelayTransportWebSocketMessage {
  readonly kind: RelayTransportWebSocketFrameKind;
  readonly payload: Uint8Array;
}

export class RelayTransportMessageAssembler {
  readonly #messages = new Map<number, RelayTransportPartialMessage>();
  #bufferedBytes = 0;

  append(frame: RelayTransportFrame): RelayTransportWebSocketMessage | null {
    if (
      frame.kind !== RelayTransportFrameKind.websocketText &&
      frame.kind !== RelayTransportFrameKind.websocketBinary
    ) {
      throw new TypeError("Only WebSocket data frames can be reassembled.");
    }
    const partial = this.#messages.get(frame.streamId);
    if (frame.payload.byteLength === 0 && !frame.endOfMessage) {
      this.delete(frame.streamId);
      throw new TypeError("Relay transport messages cannot contain empty non-final fragments.");
    }
    if (partial === undefined && frame.endOfMessage) {
      return { kind: frame.kind, payload: frame.payload };
    }
    if (partial !== undefined && partial.kind !== frame.kind) {
      this.delete(frame.streamId);
      throw new TypeError("Relay transport message changed frame kind before completion.");
    }
    const message = partial ?? {
      kind: frame.kind,
      chunks: [],
      byteLength: 0,
      fragmentCount: 0,
    };
    const nextByteLength = message.byteLength + frame.payload.byteLength;
    const nextFragmentCount = message.fragmentCount + 1;
    if (
      nextByteLength > RELAY_TRANSPORT_MAX_MESSAGE_BYTES ||
      this.#bufferedBytes + frame.payload.byteLength > RELAY_TRANSPORT_MAX_BUFFERED_MESSAGE_BYTES ||
      nextFragmentCount > RELAY_TRANSPORT_MAX_MESSAGE_FRAGMENTS
    ) {
      this.delete(frame.streamId);
      throw new RangeError("Relay transport fragmented-message buffer exceeds its limit.");
    }
    message.byteLength = nextByteLength;
    message.fragmentCount = nextFragmentCount;
    message.chunks.push(frame.payload.slice());
    if (!frame.endOfMessage) {
      this.#bufferedBytes += frame.payload.byteLength;
      this.#messages.set(frame.streamId, message);
      return null;
    }
    if (partial !== undefined) {
      this.#bufferedBytes -= partial.byteLength - frame.payload.byteLength;
      this.#messages.delete(frame.streamId);
    }
    const payload = new Uint8Array(message.byteLength);
    let offset = 0;
    for (const chunk of message.chunks) {
      payload.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: message.kind, payload };
  }

  delete(streamId: number): void {
    const message = this.#messages.get(streamId);
    if (message !== undefined) {
      this.#bufferedBytes -= message.byteLength;
      this.#messages.delete(streamId);
    }
  }

  clear(): void {
    this.#messages.clear();
    this.#bufferedBytes = 0;
  }
}

export class RelayTransportFrameDecodeError extends Schema.TaggedErrorClass<RelayTransportFrameDecodeError>()(
  "RelayTransportFrameDecodeError",
  {
    reason: Schema.Literals([
      "header_too_short",
      "invalid_magic",
      "invalid_version",
      "invalid_kind",
      "invalid_flags",
      "invalid_stream_id",
      "payload_too_large",
      "empty_non_final_payload",
    ]),
  },
) {}

export class RelayTransportControlDecodeError extends Schema.TaggedErrorClass<RelayTransportControlDecodeError>()(
  "RelayTransportControlDecodeError",
  {
    reason: Schema.Literals(["not_a_complete_control_frame", "invalid_control_message"]),
    streamId: Schema.Int,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

function isRelayTransportFrameKind(value: number): value is RelayTransportFrameKind {
  return (
    value === RelayTransportFrameKind.control ||
    value === RelayTransportFrameKind.httpRequestBody ||
    value === RelayTransportFrameKind.httpResponseBody ||
    value === RelayTransportFrameKind.websocketText ||
    value === RelayTransportFrameKind.websocketBinary
  );
}

export function encodeRelayTransportFrame(frame: RelayTransportFrame): Uint8Array {
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > 0xffff_ffff) {
    throw new RangeError("Relay transport stream id must be an unsigned 32-bit integer.");
  }
  if (frame.payload.byteLength > RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES) {
    throw new RangeError(
      `Relay transport frame payload exceeds ${RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES} bytes.`,
    );
  }

  const bytes = new Uint8Array(RELAY_TRANSPORT_FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, RELAY_TRANSPORT_FRAME_MAGIC);
  view.setUint8(4, RELAY_TRANSPORT_PROTOCOL_VERSION);
  view.setUint8(5, frame.kind);
  view.setUint16(6, frame.endOfMessage ? RELAY_TRANSPORT_END_OF_MESSAGE_FLAG : 0);
  view.setUint32(8, frame.streamId);
  bytes.set(frame.payload, RELAY_TRANSPORT_FRAME_HEADER_BYTES);
  return bytes;
}

export function encodeRelayTransportMessageFrames(
  frame: Omit<RelayTransportFrame, "endOfMessage">,
): ReadonlyArray<Uint8Array> {
  if (frame.payload.byteLength > RELAY_TRANSPORT_MAX_MESSAGE_BYTES) {
    throw new RangeError(
      `Relay transport message exceeds ${RELAY_TRANSPORT_MAX_MESSAGE_BYTES} bytes.`,
    );
  }
  if (frame.payload.byteLength === 0) {
    return [encodeRelayTransportFrame({ ...frame, endOfMessage: true })];
  }
  const frames: Array<Uint8Array> = [];
  for (
    let offset = 0;
    offset < frame.payload.byteLength;
    offset += RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES
  ) {
    const payload = frame.payload.subarray(
      offset,
      offset + RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES,
    );
    frames.push(
      encodeRelayTransportFrame({
        ...frame,
        endOfMessage: offset + payload.byteLength === frame.payload.byteLength,
        payload,
      }),
    );
  }
  return frames;
}

export function decodeRelayTransportFrame(
  input: ArrayBuffer | Uint8Array,
): Result.Result<RelayTransportFrame, RelayTransportFrameDecodeError> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < RELAY_TRANSPORT_FRAME_HEADER_BYTES) {
    return Result.fail(new RelayTransportFrameDecodeError({ reason: "header_too_short" }));
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== RELAY_TRANSPORT_FRAME_MAGIC) {
    return Result.fail(new RelayTransportFrameDecodeError({ reason: "invalid_magic" }));
  }
  if (view.getUint8(4) !== RELAY_TRANSPORT_PROTOCOL_VERSION) {
    return Result.fail(new RelayTransportFrameDecodeError({ reason: "invalid_version" }));
  }
  const kind = view.getUint8(5);
  if (!isRelayTransportFrameKind(kind)) {
    return Result.fail(new RelayTransportFrameDecodeError({ reason: "invalid_kind" }));
  }
  const flags = view.getUint16(6);
  if ((flags & ~RELAY_TRANSPORT_END_OF_MESSAGE_FLAG) !== 0) {
    return Result.fail(new RelayTransportFrameDecodeError({ reason: "invalid_flags" }));
  }
  const streamId = view.getUint32(8);
  if (kind !== RelayTransportFrameKind.control && streamId === 0) {
    return Result.fail(new RelayTransportFrameDecodeError({ reason: "invalid_stream_id" }));
  }
  const payload = bytes.subarray(RELAY_TRANSPORT_FRAME_HEADER_BYTES);
  if (payload.byteLength > RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES) {
    return Result.fail(new RelayTransportFrameDecodeError({ reason: "payload_too_large" }));
  }
  if (
    (kind === RelayTransportFrameKind.websocketText ||
      kind === RelayTransportFrameKind.websocketBinary) &&
    payload.byteLength === 0 &&
    (flags & RELAY_TRANSPORT_END_OF_MESSAGE_FLAG) === 0
  ) {
    return Result.fail(new RelayTransportFrameDecodeError({ reason: "empty_non_final_payload" }));
  }
  return Result.succeed({
    kind,
    streamId,
    endOfMessage: (flags & RELAY_TRANSPORT_END_OF_MESSAGE_FLAG) !== 0,
    payload,
  });
}

const RelayTransportControlMessageJson = Schema.fromJsonString(RelayTransportControlMessage);
const decodeControlJson = Schema.decodeUnknownResult(RelayTransportControlMessageJson);
const encodeControlJson = Schema.encodeSync(RelayTransportControlMessageJson);

export function encodeRelayTransportControlFrame(
  streamId: number,
  message: RelayTransportControlMessage,
): Uint8Array {
  return encodeRelayTransportFrame({
    kind: RelayTransportFrameKind.control,
    streamId,
    endOfMessage: true,
    payload: new TextEncoder().encode(encodeControlJson(message)),
  });
}

export function decodeRelayTransportControlFrame(
  frame: RelayTransportFrame,
): Result.Result<RelayTransportControlMessage, RelayTransportControlDecodeError> {
  if (frame.kind !== RelayTransportFrameKind.control || !frame.endOfMessage) {
    return Result.fail(
      new RelayTransportControlDecodeError({
        reason: "not_a_complete_control_frame",
        streamId: frame.streamId,
      }),
    );
  }
  const decoded = decodeControlJson(new TextDecoder().decode(frame.payload));
  return Result.isSuccess(decoded)
    ? Result.succeed(decoded.success)
    : Result.fail(
        new RelayTransportControlDecodeError({
          reason: "invalid_control_message",
          streamId: frame.streamId,
          cause: decoded.failure,
        }),
      );
}
