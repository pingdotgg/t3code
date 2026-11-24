/**
 * Builders for `application/vnd.amazon.eventstream` frames, the binary framing
 * that Bedrock ConverseStream responses use.
 *
 * Adapted from the test helpers of `@wmaurer/effect-ai-amazon-bedrock`
 * (MIT, Copyright (c) 2026 Wayne Maurer), with CRC-32 checksums added so the
 * frames match what Bedrock sends.
 */

const textEncoder = new TextEncoder()

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

/** The CRC-32 (IEEE 802.3) of `bytes`, as used by the AWS event stream encoding. */
export const crc32 = (bytes: Uint8Array): number => {
  let crc = -1
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

export interface FrameOverrides {
  /** Replaces the total length in the prelude. */
  readonly totalLength?: number
  /** Replaces the prelude CRC. */
  readonly preludeCrc?: number
  /** Replaces the message CRC. */
  readonly messageCrc?: number
}

/**
 * Encodes one event-stream frame with string-typed headers and the given
 * payload bytes. Overrides corrupt the frame on purpose.
 */
export const encodeFrame = (
  headers: Record<string, string>,
  payload: Uint8Array,
  overrides: FrameOverrides = {}
): Uint8Array<ArrayBuffer> => encodeRawFrame(encodeHeaders(headers), payload, overrides)

/**
 * Encodes one event-stream frame around an already encoded headers block, so
 * a test can send a headers block the decoder must reject.
 */
export const encodeRawFrame = (
  headerBytes: Uint8Array,
  payload: Uint8Array,
  overrides: FrameOverrides = {}
): Uint8Array<ArrayBuffer> => {
  const headersLength = headerBytes.length
  const totalLength = 12 + headersLength + payload.length + 4

  const frame = new Uint8Array(totalLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, overrides.totalLength ?? totalLength, false)
  view.setUint32(4, headersLength, false)
  view.setUint32(8, overrides.preludeCrc ?? crc32(frame.subarray(0, 8)), false)
  frame.set(headerBytes, 12)
  frame.set(payload, 12 + headersLength)
  view.setUint32(totalLength - 4, overrides.messageCrc ?? crc32(frame.subarray(0, totalLength - 4)), false)
  return frame
}

const encodeHeaders = (headers: Record<string, string>): Uint8Array => {
  const headerChunks: Array<Uint8Array> = []
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = textEncoder.encode(name)
    const valueBytes = textEncoder.encode(value)
    const chunk = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length)
    const view = new DataView(chunk.buffer)
    let offset = 0
    view.setUint8(offset, nameBytes.length)
    offset += 1
    chunk.set(nameBytes, offset)
    offset += nameBytes.length
    view.setUint8(offset, 7) // string header value type
    offset += 1
    view.setUint16(offset, valueBytes.length, false)
    offset += 2
    chunk.set(valueBytes, offset)
    headerChunks.push(chunk)
  }
  return concat(headerChunks)
}

const jsonPayload = (payload: unknown): Uint8Array => textEncoder.encode(JSON.stringify(payload))

/** An `event` frame carrying a JSON payload. */
export const eventFrame = (eventType: string, payload: unknown, overrides?: FrameOverrides): Uint8Array<ArrayBuffer> =>
  encodeFrame(
    {
      ":message-type": "event",
      ":event-type": eventType,
      ":content-type": "application/json"
    },
    jsonPayload(payload),
    overrides
  )

/** An `exception` frame carrying a JSON payload. */
export const exceptionFrame = (exceptionType: string, payload: unknown): Uint8Array<ArrayBuffer> =>
  encodeFrame({
    ":message-type": "exception",
    ":exception-type": exceptionType,
    ":content-type": "application/json"
  }, jsonPayload(payload))

export const concat = (frames: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const total = frames.reduce((acc, frame) => acc + frame.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

/** The frames of a complete text reply. */
export const textReplyFrames = (text: string): ReadonlyArray<Uint8Array> => [
  eventFrame("messageStart", { role: "assistant" }),
  eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text } }),
  eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
  eventFrame("messageStop", { stopReason: "end_turn" }),
  eventFrame("metadata", {
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    metrics: { latencyMs: 123 }
  })
]
