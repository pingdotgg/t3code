import type {
  WebSocket,
  WebSocketAttachmentError,
} from "@/Cloudflare/Workers/WebSocket.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

class DecodeAttachment extends Context.Service<DecodeAttachment, number>()(
  "DecodeAttachment",
) {}
class EncodeAttachment extends Context.Service<EncodeAttachment, number>()(
  "EncodeAttachment",
) {}

const WithServices = Schema.NumberFromString.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transformEffect((value: number) =>
      DecodeAttachment.pipe(Effect.as(value)),
    ),
    encode: SchemaGetter.transformEffect((value: number) =>
      EncodeAttachment.pipe(Effect.as(value)),
    ),
  }),
);

export const attachmentTypes = (socket: WebSocket) => {
  const read: Effect.Effect<number, WebSocketAttachmentError> =
    socket.getAttachment(Schema.NumberFromString);
  const write: Effect.Effect<void, WebSocketAttachmentError> =
    socket.setAttachment(Schema.NumberFromString, 42);
  const date: Effect.Effect<Date, WebSocketAttachmentError> =
    socket.getAttachment(Schema.DateFromString);
  const decodeServices: Effect.Effect<
    number,
    WebSocketAttachmentError,
    DecodeAttachment
  > = socket.getAttachment(WithServices);
  const encodeServices: Effect.Effect<
    void,
    WebSocketAttachmentError,
    EncodeAttachment
  > = socket.setAttachment(WithServices, 42);

  // @ts-expect-error The encoded string is not a decoded attachment value.
  socket.setAttachment(Schema.NumberFromString, "42");
  // @ts-expect-error The decoded Date must be supplied, not its encoded string.
  socket.setAttachment(Schema.DateFromString, "2026-01-02T03:04:05.000Z");
  // @ts-expect-error Reading returns the decoded number, not its encoded string.
  const encoded: Effect.Effect<string, WebSocketAttachmentError> =
    socket.getAttachment(Schema.NumberFromString);
  // @ts-expect-error Reading still requires the codec's decoding service.
  const missingDecode: Effect.Effect<number, WebSocketAttachmentError> =
    socket.getAttachment(WithServices);
  // @ts-expect-error Writing still requires the codec's encoding service.
  const missingEncode: Effect.Effect<void, WebSocketAttachmentError> =
    socket.setAttachment(WithServices, 42);
  // @ts-expect-error The encoding service cannot satisfy the decoding service.
  const wrongDecode: Effect.Effect<
    number,
    WebSocketAttachmentError,
    EncodeAttachment
  > = socket.getAttachment(WithServices);
  // @ts-expect-error The decoding service cannot satisfy the encoding service.
  const wrongEncode: Effect.Effect<
    void,
    WebSocketAttachmentError,
    DecodeAttachment
  > = socket.setAttachment(WithServices, 42);
  // @ts-expect-error Attachment failures are recoverable, not erased from the effect.
  const noError: Effect.Effect<number> = socket.getAttachment(
    Schema.NumberFromString,
  );

  const uncheckedWrite: void = socket.serializeAttachment({ count: "42" });
  const uncheckedRead: { count: string } | null = socket.deserializeAttachment<{
    count: string;
  }>();
  return {
    read,
    write,
    date,
    decodeServices,
    encodeServices,
    encoded,
    missingDecode,
    missingEncode,
    wrongDecode,
    wrongEncode,
    noError,
    uncheckedRead,
    uncheckedWrite,
  };
};
