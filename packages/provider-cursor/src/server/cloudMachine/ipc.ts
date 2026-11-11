/** VS Code's remote-server wire format: 13-byte message headers and its IPC value encoding. */

export const MessageType = {
  Regular: 1,
  Control: 2,
  Ack: 3,
  Disconnect: 5,
  ReplayRequest: 6,
  Pause: 7,
  Resume: 8,
  KeepAlive: 9,
} as const;

export const RequestType = {
  Promise: 100,
  PromiseCancel: 101,
  EventListen: 102,
  EventDispose: 103,
};
export const ResponseType = {
  Initialize: 200,
  PromiseSuccess: 201,
  PromiseError: 202,
  PromiseErrorObj: 203,
  EventFire: 204,
};

const HEADER_LENGTH = 13;

export interface Frame {
  readonly type: number;
  readonly id: number;
  readonly ack: number;
  readonly body: Uint8Array;
}

export function encodeFrame(frame: Frame): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_LENGTH + frame.body.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, frame.type);
  view.setUint32(1, frame.id);
  view.setUint32(5, frame.ack);
  view.setUint32(9, frame.body.byteLength);
  out.set(frame.body, HEADER_LENGTH);
  return out;
}

/** Accumulates socket chunks and yields complete frames. */
export class FrameReader {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;
    const frames: Frame[] = [];
    while (this.buffer.byteLength >= HEADER_LENGTH) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
      const length = view.getUint32(9);
      if (this.buffer.byteLength < HEADER_LENGTH + length) break;
      frames.push({
        type: view.getUint8(0),
        id: view.getUint32(1),
        ack: view.getUint32(5),
        body: this.buffer.slice(HEADER_LENGTH, HEADER_LENGTH + length),
      });
      this.buffer = this.buffer.slice(HEADER_LENGTH + length);
    }
    return frames;
  }
}

const DataType = { Undefined: 0, String: 1, Buffer: 2, VSBuffer: 3, Array: 4, Object: 5, Int: 6 };
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeVql(parts: Uint8Array[], value: number) {
  if (value === 0) {
    parts.push(Uint8Array.of(0));
    return;
  }
  const bytes: number[] = [];
  for (let rest = value; rest !== 0;) {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  }
  parts.push(Uint8Array.from(bytes));
}

function writeValue(parts: Uint8Array[], value: unknown) {
  if (value === undefined) {
    parts.push(Uint8Array.of(DataType.Undefined));
  } else if (typeof value === "string") {
    const bytes = textEncoder.encode(value);
    parts.push(Uint8Array.of(DataType.String));
    writeVql(parts, bytes.byteLength);
    parts.push(bytes);
  } else if (value instanceof Uint8Array) {
    parts.push(Uint8Array.of(DataType.VSBuffer));
    writeVql(parts, value.byteLength);
    parts.push(value);
  } else if (Array.isArray(value)) {
    parts.push(Uint8Array.of(DataType.Array));
    writeVql(parts, value.length);
    for (const item of value) writeValue(parts, item);
  } else if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < 2 ** 31
  ) {
    parts.push(Uint8Array.of(DataType.Int));
    writeVql(parts, value);
  } else {
    const bytes = textEncoder.encode(JSON.stringify(value));
    parts.push(Uint8Array.of(DataType.Object));
    writeVql(parts, bytes.byteLength);
    parts.push(bytes);
  }
}

export function serialize(...values: ReadonlyArray<unknown>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const value of values) writeValue(parts, value);
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Reads consecutive serialized values; `done` reports whether bytes remain. */
export class ValueReader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done() {
    return this.offset >= this.bytes.byteLength;
  }

  private vql(): number {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = this.bytes[this.offset++];
      if (byte === undefined) throw new Error("Truncated IPC value");
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value >>> 0;
    }
  }

  private slice(length: number) {
    const out = this.bytes.slice(this.offset, this.offset + length);
    if (out.byteLength !== length) throw new Error("Truncated IPC value");
    this.offset += length;
    return out;
  }

  read(): unknown {
    const type = this.bytes[this.offset++];
    switch (type) {
      case DataType.Undefined:
        return undefined;
      case DataType.String:
        return textDecoder.decode(this.slice(this.vql()));
      case DataType.Buffer:
      case DataType.VSBuffer:
        return this.slice(this.vql());
      case DataType.Array: {
        const length = this.vql();
        const items: unknown[] = [];
        for (let index = 0; index < length; index++) items.push(this.read());
        return items;
      }
      case DataType.Object:
        return JSON.parse(textDecoder.decode(this.slice(this.vql())));
      case DataType.Int:
        return this.vql();
      default:
        throw new Error(`Unknown IPC value type ${String(type)}`);
    }
  }
}
