/**
 * Decodes the `application/vnd.amazon.eventstream` binary framing that the
 * Bedrock ConverseStream endpoint uses.
 *
 * **Wire format**
 *
 * Each frame is laid out as
 * `[totalLength u32][headersLength u32][preludeCrc u32][headers][payload][messageCrc u32]`,
 * all big-endian. The prelude CRC covers the first 8 bytes and the message
 * CRC covers everything before it. Headers are a sequence of
 * `[nameLength u8][name][valueType u8][value]` entries; only string headers
 * (`:message-type`, `:event-type`, `:exception-type`, ...) matter here.
 *
 * Adapted from the decoder of `@wmaurer/effect-ai-amazon-bedrock` (MIT,
 * Copyright (c) 2026 Wayne Maurer), with CRC validation added.
 *
 * @see https://docs.aws.amazon.com/lexv2/latest/dg/event-stream-encoding.html
 */
import * as Bytes from "effect/Bytes"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

/**
 * A frame that cannot be decoded.
 *
 * @internal
 */
export class EventStreamError extends Schema.TaggedError<EventStreamError>(
  "@effect/ai-amazon-bedrock/internal/eventStream/EventStreamError"
)("EventStreamError", {
  description: Schema.String
}) {}

/**
 * A decoded frame: its string headers and its raw payload.
 *
 * @internal
 */
export interface Frame {
  readonly headers: Record<string, string>
  readonly payload: Uint8Array
}

const textDecoder = new TextDecoder()

const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

const crc32 = (bytes: Uint8Array): number => {
  let crc = -1
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

const malformed = (description: string) => new EventStreamError({ description })

/** Prelude (12 bytes) plus message CRC (4 bytes). */
const minimumFrameLength = 16

/** The byte length of each fixed-size header value type, by type code. */
const fixedHeaderValueLengths: Record<number, number> = {
  0: 0, // bool true
  1: 0, // bool false
  2: 1, // byte
  3: 2, // short
  4: 4, // integer
  5: 8, // long
  8: 8, // timestamp
  9: 16 // uuid
}

const decodeHeaders = (bytes: Uint8Array): Record<string, string> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headers: Record<string, string> = {}
  let offset = 0
  // Claims the next `length` bytes and returns where they start.
  const take = (length: number): number => {
    if (offset + length > bytes.length) {
      throw malformed("An event stream header runs past the end of the headers block")
    }
    const start = offset
    offset += length
    return start
  }
  while (offset < bytes.length) {
    const nameLength = view.getUint8(take(1))
    const nameStart = take(nameLength)
    const name = textDecoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    const valueType = view.getUint8(take(1))
    switch (valueType) {
      // byte array
      case 6: {
        take(view.getUint16(take(2), false))
        break
      }
      // string
      case 7: {
        const valueLength = view.getUint16(take(2), false)
        const valueStart = take(valueLength)
        headers[name] = textDecoder.decode(bytes.subarray(valueStart, valueStart + valueLength))
        break
      }
      default: {
        const length = fixedHeaderValueLengths[valueType]
        if (length === undefined) {
          throw malformed(`An event stream header has the unknown value type ${valueType}`)
        }
        take(length)
      }
    }
  }
  return headers
}

/**
 * Takes every complete frame off the front of `buffer`. Returns the frames and
 * the bytes left over, or throws an `EventStreamError`.
 */
const takeFrames = (buffer: Uint8Array): [frames: Array<Frame>, rest: Uint8Array] => {
  const frames: Array<Frame> = []
  while (buffer.length >= 4) {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const totalLength = view.getUint32(0, false)
    if (totalLength < minimumFrameLength) {
      throw malformed(`An event stream frame declares a total length of ${totalLength} bytes, below the minimum of 16`)
    }
    if (buffer.length < totalLength) {
      break
    }
    const headersLength = view.getUint32(4, false)
    if (minimumFrameLength + headersLength > totalLength) {
      throw malformed(
        `An event stream frame declares ${headersLength} bytes of headers in a frame of ${totalLength} bytes`
      )
    }
    if (crc32(buffer.subarray(0, 8)) !== view.getUint32(8, false)) {
      throw malformed("The prelude CRC of an event stream frame does not match")
    }
    if (crc32(buffer.subarray(0, totalLength - 4)) !== view.getUint32(totalLength - 4, false)) {
      throw malformed("The message CRC of an event stream frame does not match")
    }
    const headersEnd = 12 + headersLength
    frames.push({
      headers: decodeHeaders(buffer.subarray(12, headersEnd)),
      payload: buffer.slice(headersEnd, totalLength - 4)
    })
    buffer = buffer.subarray(totalLength)
  }
  return [frames, buffer]
}

/**
 * Decodes a stream of bytes into event stream frames. A stream that ends in
 * the middle of a frame fails with an `EventStreamError`.
 *
 * @internal
 */
export const decode = <E>(bytes: Stream.Stream<Uint8Array, E>): Stream.Stream<Frame, E | EventStreamError> =>
  Stream.suspend(() => {
    let buffer: Uint8Array = new Uint8Array(0)
    const frames = bytes.pipe(
      Stream.mapEffect((chunk) =>
        Effect.try({
          try: () => {
            const [frames, rest] = takeFrames(buffer.length === 0 ? chunk : Bytes.concat([buffer, chunk]))
            buffer = rest
            return frames
          },
          catch: (error) =>
            error instanceof EventStreamError
              ? error
              : malformed(
                `An event stream frame could not be decoded: ${error instanceof Error ? error.message : String(error)}`
              )
        })
      ),
      Stream.flattenIterable
    )
    const trailing = Stream.suspend(() =>
      buffer.length === 0
        ? Stream.empty
        : Stream.fail(malformed(`The event stream ended with ${buffer.length} bytes of an incomplete frame`))
    )
    return Stream.concat(frames, trailing)
  })

/**
 * Parses the JSON payload of a frame.
 *
 * @internal
 */
export const parseJsonPayload = (frame: Frame): Effect.Effect<unknown, EventStreamError> =>
  Effect.try({
    try: () => JSON.parse(textDecoder.decode(frame.payload)) as unknown,
    catch: () => malformed(`The payload of an event stream frame is not JSON: ${textDecoder.decode(frame.payload)}`)
  })
