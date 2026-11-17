/**
 * The little of protobuf and grpc-web that boxd's API needs. boxd speaks gRPC only, and
 * grpc-web is the form `fetch` can carry, so the server and the phone share one client
 * with no generated code. Field numbers come from boxd's published `api.proto`.
 */

export type ProtoValue =
  | string
  | number
  | boolean
  | Uint8Array
  | ProtoMessage
  | ReadonlyArray<string>
  | Readonly<Record<string, string>>
  | undefined;

/** A message to encode: field number to value. Strings, maps and nested messages are length-delimited. */
export interface ProtoMessage {
  readonly fields: ReadonlyArray<readonly [number, ProtoValue]>;
}

export const message = (...fields: ReadonlyArray<readonly [number, ProtoValue]>): ProtoMessage => ({
  fields,
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function pushVarint(out: Array<number>, value: number) {
  let remaining = value;
  while (remaining >= 0x80) {
    out.push((remaining % 0x80) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  out.push(remaining);
}

function pushBytes(out: Array<number>, field: number, bytes: Uint8Array) {
  pushVarint(out, field * 8 + 2);
  pushVarint(out, bytes.length);
  for (const byte of bytes) out.push(byte);
}

const isMessage = (value: ProtoValue): value is ProtoMessage =>
  typeof value === "object" && value !== null && "fields" in value;

export function encode(input: ProtoMessage): Uint8Array {
  const out: Array<number> = [];
  for (const [field, value] of input.fields) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      // proto3 leaves defaults off the wire.
      if (value.length > 0) pushBytes(out, field, textEncoder.encode(value));
    } else if (typeof value === "number") {
      if (value !== 0) {
        pushVarint(out, field * 8);
        pushVarint(out, value);
      }
    } else if (typeof value === "boolean") {
      if (value) {
        pushVarint(out, field * 8);
        out.push(1);
      }
    } else if (value instanceof Uint8Array) {
      pushBytes(out, field, value);
    } else if (isMessage(value)) {
      pushBytes(out, field, encode(value));
    } else if (Array.isArray(value)) {
      for (const entry of value as ReadonlyArray<string>) {
        pushBytes(out, field, textEncoder.encode(entry));
      }
    } else {
      // A map is a repeated entry message: key is field 1, value field 2.
      for (const [key, entry] of Object.entries(value as Readonly<Record<string, string>>)) {
        pushBytes(out, field, encode(message([1, key], [2, entry])));
      }
    }
  }
  return Uint8Array.from(out);
}

/** A decoded message: each field number to its values, in wire order. */
export class ProtoReader {
  private readonly values = new Map<number, Array<number | Uint8Array>>();

  constructor(bytes: Uint8Array) {
    let offset = 0;
    const varint = () => {
      let result = 0;
      let scale = 1;
      for (;;) {
        if (offset >= bytes.length) throw new Error("Truncated protobuf varint.");
        const byte = bytes[offset++]!;
        result += (byte & 0x7f) * scale;
        if (byte < 0x80) return result;
        scale *= 0x80;
      }
    };
    while (offset < bytes.length) {
      const key = varint();
      const field = Math.floor(key / 8);
      const wireType = key % 8;
      let value: number | Uint8Array;
      if (wireType === 0) {
        value = varint();
      } else if (wireType === 2) {
        const length = varint();
        if (offset + length > bytes.length) throw new Error("Truncated protobuf field.");
        value = bytes.subarray(offset, offset + length);
        offset += length;
      } else if (wireType === 1) {
        value = 0;
        offset += 8;
      } else if (wireType === 5) {
        value = 0;
        offset += 4;
      } else {
        throw new Error(`Unsupported protobuf wire type ${wireType}.`);
      }
      const list = this.values.get(field);
      if (list) list.push(value);
      else this.values.set(field, [value]);
    }
  }

  private last(field: number) {
    return this.values.get(field)?.at(-1);
  }

  string(field: number): string {
    const value = this.last(field);
    return value instanceof Uint8Array ? textDecoder.decode(value) : "";
  }

  /** Varints only; 64-bit values above 2^53 lose precision, which no field here reaches. */
  number(field: number): number {
    const value = this.last(field);
    return typeof value === "number" ? value : 0;
  }

  bool(field: number): boolean {
    return this.number(field) !== 0;
  }

  bytes(field: number): Uint8Array {
    const value = this.last(field);
    return value instanceof Uint8Array ? value : new Uint8Array();
  }

  messages(field: number): Array<ProtoReader> {
    return (this.values.get(field) ?? []).flatMap((value) =>
      value instanceof Uint8Array ? [new ProtoReader(value)] : [],
    );
  }

  message(field: number): ProtoReader | null {
    return this.messages(field).at(-1) ?? null;
  }

  map(field: number): Record<string, string> {
    return Object.fromEntries(
      this.messages(field).map((entry) => [entry.string(1), entry.string(2)] as const),
    );
  }
}

/** One grpc-web data frame: a flag byte, a 4-byte big-endian length, the message. */
export function frame(payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(5 + payload.length);
  new DataView(framed.buffer).setUint32(1, payload.length, false);
  framed.set(payload, 5);
  return framed;
}

export interface GrpcWebResponse {
  readonly messages: ReadonlyArray<Uint8Array>;
  /** `grpc-status` from the trailer frame, or from the headers for a trailers-only reply. */
  readonly status: number | null;
  readonly message: string;
}

const parseTrailers = (text: string) => {
  const trailers = new Map<string, string>();
  for (const line of text.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0)
      trailers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return trailers;
};

const decodeGrpcMessage = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Splits a grpc-web body into its messages and the status its trailer frame carries. */
export function parseGrpcWebBody(body: Uint8Array): GrpcWebResponse {
  const messages: Array<Uint8Array> = [];
  let status: number | null = null;
  let statusMessage = "";
  let offset = 0;
  while (offset + 5 <= body.length) {
    const flag = body[offset]!;
    const length = new DataView(body.buffer, body.byteOffset + offset + 1, 4).getUint32(0, false);
    const payload = body.subarray(offset + 5, offset + 5 + length);
    offset += 5 + length;
    if ((flag & 0x80) === 0) {
      messages.push(payload);
      continue;
    }
    const trailers = parseTrailers(textDecoder.decode(payload));
    const code = trailers.get("grpc-status");
    if (code !== undefined) status = Number(code);
    statusMessage = decodeGrpcMessage(trailers.get("grpc-message") ?? "");
  }
  return { messages, status, message: statusMessage };
}

/** For a trailers-only reply, which puts the status in the HTTP headers. */
export function statusFromHeaders(headers: Readonly<Record<string, string | undefined>>) {
  const code = headers["grpc-status"];
  return code === undefined
    ? null
    : { status: Number(code), message: decodeGrpcMessage(headers["grpc-message"] ?? "") };
}
