/**
 * RESP2 + RESP3 codec. Commands are encoded as arrays of bulk strings.
 * Replies are parsed with a length-prefixed recursive reader so values
 * may contain CR/LF/`$`/`*` and may arrive split across TCP frames.
 *
 * Spec: https://github.com/redis/redis-specifications/blob/master/protocol/RESP2.md
 * Algorithm: the same as NodeRedis/node-redis-parser, reimplemented here
 * so alchemy does not take a Redis client dependency.
 */
import { ProtocolError, ReplyError } from "./Errors.ts";

export type Arg = string | number | Uint8Array;

/**
 * A decoded RESP value. Nested errors stay as {@link ReplyError} values
 * (arrays may contain them). Top-level errors fail the command.
 */
export type Reply =
  | string
  | number
  | boolean
  | bigint
  | null
  | ReplyError
  | readonly Reply[]
  | { readonly [key: string]: Reply };

export type ParseResult =
  | { readonly _tag: "Incomplete" }
  | { readonly _tag: "Reply"; readonly value: Reply }
  | { readonly _tag: "Error"; readonly error: ReplyError }
  | { readonly _tag: "Push"; readonly value: readonly Reply[] }
  | { readonly _tag: "Protocol"; readonly error: ProtocolError };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

const CR = 13;
const LF = 10;
const CRLF = new Uint8Array([CR, LF]);

const PLUS = 43;
const MINUS = 45;
const COLON = 58;
const DOLLAR = 36;
const STAR = 42;
const UNDERSCORE = 95;
const HASH = 35;
const COMMA = 44;
const LPAREN = 40;
const EQUALS = 61;
const PERCENT = 37;
const TILDE = 126;
const PIPE = 124;
const GT = 62;
const BANG = 33;
const DOT = 46;
const SEMICOLON = 59;
const QUESTION = 63;

/** Redis bulk strings are capped at 512 MB. */
const MAX_BULK = 512 * 1024 * 1024;
const MAX_AGGREGATE = 1_000_000;

export const Incomplete: Extract<ParseResult, { _tag: "Incomplete" }> = {
  _tag: "Incomplete",
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const bytesOf = (value: string): Uint8Array => encoder.encode(value);

const argBytes = (arg: Arg): Uint8Array => {
  if (typeof arg === "string") return bytesOf(arg);
  if (typeof arg === "number") return bytesOf(String(arg));
  return arg;
};

export const encodeSimpleString = (value: string): Uint8Array =>
  concat([bytesOf(`+${value}`), CRLF]);

export const encodeError = (value: string): Uint8Array =>
  concat([bytesOf(`-${value}`), CRLF]);

export const encodeInteger = (value: number | bigint): Uint8Array =>
  concat([bytesOf(`:${value}`), CRLF]);

export const encodeBoolean = (value: boolean): Uint8Array =>
  bytesOf(value ? "#t\r\n" : "#f\r\n");

export const encodeDouble = (value: number): Uint8Array => {
  if (Number.isNaN(value)) return bytesOf(",nan\r\n");
  if (value === Infinity) return bytesOf(",inf\r\n");
  if (value === -Infinity) return bytesOf(",-inf\r\n");
  return concat([bytesOf(`,${value}`), CRLF]);
};

export const encodeBigNumber = (value: bigint): Uint8Array =>
  concat([bytesOf(`(${value}`), CRLF]);

export const encodeNull = (): Uint8Array => bytesOf("$-1\r\n");

export const encodeNullArray = (): Uint8Array => bytesOf("*-1\r\n");

export const encodeBulk = (value: string | Uint8Array): Uint8Array => {
  const payload = typeof value === "string" ? bytesOf(value) : value;
  return concat([bytesOf(`$${payload.length}\r\n`), payload, CRLF]);
};

export const encodeArray = (items: readonly Uint8Array[]): Uint8Array =>
  concat([bytesOf(`*${items.length}\r\n`), ...items]);

/** Encode a client command as a RESP array of bulk strings. */
export const encodeCommand = (
  command: string,
  args: readonly Arg[] = [],
): Uint8Array => {
  const parts = [bytesOf(command), ...args.map(argBytes)];
  const chunks: Uint8Array[] = [bytesOf(`*${parts.length}\r\n`)];
  for (const part of parts) {
    chunks.push(bytesOf(`$${part.length}\r\n`), part, CRLF);
  }
  return concat(chunks);
};

export const encodeReply = (value: Reply): Uint8Array => {
  if (value === null) return encodeNull();
  if (typeof value === "string") return encodeBulk(value);
  if (typeof value === "boolean") return encodeBoolean(value);
  if (typeof value === "bigint") {
    if (
      value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return encodeInteger(Number(value));
    }
    return encodeBigNumber(value);
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? encodeInteger(value) : encodeDouble(value);
  }
  if (value instanceof ReplyError) return encodeError(value.message);
  if (Array.isArray(value)) {
    return encodeArray(value.map(encodeReply));
  }
  const entries = Object.entries(value);
  const encoded: Uint8Array[] = [bytesOf(`%${entries.length}\r\n`)];
  for (const [key, item] of entries) {
    encoded.push(encodeSimpleString(key), encodeReply(item));
  }
  return concat(encoded);
};

type Line = {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly next: number;
};

type Outcome =
  | {
      readonly ok: true;
      readonly frame: Exclude<ParseResult, { _tag: "Incomplete" | "Protocol" }>;
      readonly offset: number;
    }
  | { readonly ok: false; readonly incomplete: true }
  | { readonly ok: false; readonly error: ProtocolError };

const INCOMPLETE: Outcome = { ok: false, incomplete: true };

const fail = (message: string): Outcome => ({
  ok: false,
  error: new ProtocolError({ message }),
});

const ok = (
  frame: Exclude<ParseResult, { _tag: "Incomplete" | "Protocol" }>,
  offset: number,
): Outcome => ({ ok: true, frame, offset });

const parseLine = (
  buf: Uint8Array,
  offset: number,
): Line | undefined | ProtocolError => {
  for (let i = offset; i < buf.length; i++) {
    if (buf[i] === LF) {
      if (i === offset || buf[i - 1] !== CR) {
        return new ProtocolError({ message: "expected CRLF line terminator" });
      }
      const bytes = buf.subarray(offset, i - 1);
      return { text: decoder.decode(bytes), bytes, next: i + 1 };
    }
  }
  return undefined;
};

const parseCount = (
  buf: Uint8Array,
  offset: number,
):
  | { readonly kind: "null"; readonly next: number }
  | { readonly kind: "stream"; readonly next: number }
  | { readonly kind: "n"; readonly n: number; readonly next: number }
  | { readonly kind: "incomplete" }
  | { readonly kind: "error"; readonly error: ProtocolError } => {
  const line = parseLine(buf, offset);
  if (line === undefined) return { kind: "incomplete" };
  if (line instanceof ProtocolError) return { kind: "error", error: line };
  if (line.text === "?") return { kind: "stream", next: line.next };
  if (line.text === "-1") return { kind: "null", next: line.next };
  if (line.text.length === 0 || !/^-?\d+$/.test(line.text)) {
    return {
      kind: "error",
      error: new ProtocolError({
        message: `invalid length ${JSON.stringify(line.text)}`,
      }),
    };
  }
  const n = Number(line.text);
  if (!Number.isSafeInteger(n) || n < 0) {
    return {
      kind: "error",
      error: new ProtocolError({ message: `invalid length ${line.text}` }),
    };
  }
  if (n > MAX_BULK) {
    return {
      kind: "error",
      error: new ProtocolError({ message: `length ${n} exceeds ${MAX_BULK}` }),
    };
  }
  return { kind: "n", n, next: line.next };
};

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const parseIntegerValue = (text: string): number | bigint => {
  if (text.length === 0 || !/^-?\d+$/.test(text)) {
    throw new ProtocolError({
      message: `invalid integer ${JSON.stringify(text)}`,
    });
  }
  const value = BigInt(text);
  if (value >= MIN_SAFE && value <= MAX_SAFE) return Number(value);
  return value;
};

const parseErrorLine = (text: string): ReplyError => {
  const space = text.indexOf(" ");
  const code = space === -1 ? text : text.slice(0, space);
  return new ReplyError({ code, message: text });
};

const asElement = (
  frame: Exclude<ParseResult, { _tag: "Incomplete" | "Protocol" }>,
): Reply => {
  if (frame._tag === "Error") return frame.error;
  if (frame._tag === "Push") return frame.value;
  return frame.value;
};

const parseBulkBody = (buf: Uint8Array, offset: number, n: number): Outcome => {
  const end = offset + n + 2;
  if (end > buf.length) return INCOMPLETE;
  if (buf[offset + n] !== CR || buf[offset + n + 1] !== LF) {
    return fail("missing CRLF after bulk string");
  }
  return ok(
    { _tag: "Reply", value: decoder.decode(buf.subarray(offset, offset + n)) },
    end,
  );
};

const parseStreamedString = (buf: Uint8Array, offset: number): Outcome => {
  const chunks: Uint8Array[] = [];
  let cursor = offset;
  while (true) {
    if (cursor >= buf.length) return INCOMPLETE;
    if (buf[cursor] !== SEMICOLON) {
      return fail("expected streamed string chunk");
    }
    const count = parseCount(buf, cursor + 1);
    if (count.kind === "incomplete") return INCOMPLETE;
    if (count.kind === "error") return { ok: false, error: count.error };
    if (count.kind !== "n") return fail("invalid streamed string chunk length");
    if (count.n === 0) {
      return ok(
        { _tag: "Reply", value: decoder.decode(concat(chunks)) },
        count.next,
      );
    }
    const body = parseBulkBody(buf, count.next, count.n);
    if (!body.ok) return body;
    if (body.frame._tag !== "Reply" || typeof body.frame.value !== "string") {
      return fail("invalid streamed string chunk");
    }
    chunks.push(buf.subarray(count.next, count.next + count.n));
    cursor = body.offset;
  }
};

const parseVerbatim = (buf: Uint8Array, offset: number): Outcome => {
  const count = parseCount(buf, offset);
  if (count.kind === "incomplete") return INCOMPLETE;
  if (count.kind === "error") return { ok: false, error: count.error };
  if (count.kind !== "n") return fail("invalid verbatim string length");
  const body = parseBulkBody(buf, count.next, count.n);
  if (!body.ok) return body;
  if (body.frame._tag !== "Reply" || typeof body.frame.value !== "string") {
    return fail("invalid verbatim string");
  }
  const raw = body.frame.value;
  const value = raw.length >= 4 && raw[3] === ":" ? raw.slice(4) : raw;
  return ok({ _tag: "Reply", value }, body.offset);
};

const parseBlobError = (buf: Uint8Array, offset: number): Outcome => {
  const count = parseCount(buf, offset);
  if (count.kind === "incomplete") return INCOMPLETE;
  if (count.kind === "error") return { ok: false, error: count.error };
  if (count.kind !== "n") return fail("invalid blob error length");
  const body = parseBulkBody(buf, count.next, count.n);
  if (!body.ok) return body;
  if (body.frame._tag !== "Reply" || typeof body.frame.value !== "string") {
    return fail("invalid blob error");
  }
  return ok(
    { _tag: "Error", error: parseErrorLine(body.frame.value) },
    body.offset,
  );
};

const parseElements = (
  buf: Uint8Array,
  offset: number,
  n: number,
):
  | { readonly ok: true; readonly values: Reply[]; readonly offset: number }
  | Outcome => {
  if (n > MAX_AGGREGATE) {
    return fail(`aggregate length ${n} exceeds ${MAX_AGGREGATE}`);
  }
  const values: Reply[] = [];
  let cursor = offset;
  for (let i = 0; i < n; i++) {
    const next = parseFrame(buf, cursor);
    if (!next.ok) return next;
    values.push(asElement(next.frame));
    cursor = next.offset;
  }
  return { ok: true, values, offset: cursor };
};

const parseStreamedAggregate = (
  buf: Uint8Array,
  offset: number,
):
  | { readonly ok: true; readonly values: Reply[]; readonly offset: number }
  | Outcome => {
  const values: Reply[] = [];
  let cursor = offset;
  while (true) {
    if (cursor >= buf.length) return INCOMPLETE;
    if (buf[cursor] === DOT) {
      const line = parseLine(buf, cursor + 1);
      if (line === undefined) return INCOMPLETE;
      if (line instanceof ProtocolError) return { ok: false, error: line };
      if (line.text.length !== 0) return fail("invalid aggregate terminator");
      return { ok: true, values, offset: line.next };
    }
    const next = parseFrame(buf, cursor);
    if (!next.ok) return next;
    values.push(asElement(next.frame));
    cursor = next.offset;
    if (values.length > MAX_AGGREGATE) {
      return fail(`aggregate length exceeds ${MAX_AGGREGATE}`);
    }
  }
};

const pairsToReply = (values: readonly Reply[]): Reply => {
  if (values.length % 2 !== 0) {
    return values;
  }
  const entries: Array<[Reply, Reply]> = [];
  for (let i = 0; i < values.length; i += 2) {
    entries.push([values[i]!, values[i + 1]!]);
  }
  const out: Record<string, Reply> = {};
  for (const [key, value] of entries) {
    if (typeof key !== "string") return values;
    out[key] = value;
  }
  return out;
};

const parseAggregate = (
  buf: Uint8Array,
  offset: number,
  kind: "array" | "map" | "set" | "push",
): Outcome => {
  const count = parseCount(buf, offset);
  if (count.kind === "incomplete") return INCOMPLETE;
  if (count.kind === "error") return { ok: false, error: count.error };
  if (count.kind === "null") {
    return ok({ _tag: "Reply", value: null }, count.next);
  }

  const parsed =
    count.kind === "stream"
      ? parseStreamedAggregate(buf, count.next)
      : parseElements(buf, count.next, kind === "map" ? count.n * 2 : count.n);
  if (!("values" in parsed)) return parsed;

  if (kind === "push") {
    return ok({ _tag: "Push", value: parsed.values }, parsed.offset);
  }
  if (kind === "map") {
    return ok(
      { _tag: "Reply", value: pairsToReply(parsed.values) },
      parsed.offset,
    );
  }
  return ok({ _tag: "Reply", value: parsed.values }, parsed.offset);
};

const parseBulk = (buf: Uint8Array, offset: number): Outcome => {
  const count = parseCount(buf, offset);
  if (count.kind === "incomplete") return INCOMPLETE;
  if (count.kind === "error") return { ok: false, error: count.error };
  if (count.kind === "null") {
    return ok({ _tag: "Reply", value: null }, count.next);
  }
  if (count.kind === "stream") return parseStreamedString(buf, count.next);
  return parseBulkBody(buf, count.next, count.n);
};

function parseFrame(buf: Uint8Array, offset: number): Outcome {
  let cursor = offset;
  while (cursor < buf.length && buf[cursor] === PIPE) {
    const attrs = parseAggregate(buf, cursor + 1, "map");
    if (!attrs.ok) return attrs;
    cursor = attrs.offset;
  }
  if (cursor >= buf.length) return INCOMPLETE;

  const type = buf[cursor]!;
  const next = cursor + 1;
  switch (type) {
    case PLUS: {
      const line = parseLine(buf, next);
      if (line === undefined) return INCOMPLETE;
      if (line instanceof ProtocolError) return { ok: false, error: line };
      return ok({ _tag: "Reply", value: line.text }, line.next);
    }
    case MINUS: {
      const line = parseLine(buf, next);
      if (line === undefined) return INCOMPLETE;
      if (line instanceof ProtocolError) return { ok: false, error: line };
      return ok({ _tag: "Error", error: parseErrorLine(line.text) }, line.next);
    }
    case COLON: {
      const line = parseLine(buf, next);
      if (line === undefined) return INCOMPLETE;
      if (line instanceof ProtocolError) return { ok: false, error: line };
      try {
        return ok(
          { _tag: "Reply", value: parseIntegerValue(line.text) },
          line.next,
        );
      } catch (error) {
        return error instanceof ProtocolError
          ? { ok: false, error }
          : fail(String(error));
      }
    }
    case DOLLAR:
      return parseBulk(buf, next);
    case STAR:
      return parseAggregate(buf, next, "array");
    case UNDERSCORE: {
      const line = parseLine(buf, next);
      if (line === undefined) return INCOMPLETE;
      if (line instanceof ProtocolError) return { ok: false, error: line };
      if (line.text.length !== 0) return fail("invalid null");
      return ok({ _tag: "Reply", value: null }, line.next);
    }
    case HASH: {
      const line = parseLine(buf, next);
      if (line === undefined) return INCOMPLETE;
      if (line instanceof ProtocolError) return { ok: false, error: line };
      if (line.text === "t")
        return ok({ _tag: "Reply", value: true }, line.next);
      if (line.text === "f")
        return ok({ _tag: "Reply", value: false }, line.next);
      return fail(`invalid boolean ${JSON.stringify(line.text)}`);
    }
    case COMMA: {
      const line = parseLine(buf, next);
      if (line === undefined) return INCOMPLETE;
      if (line instanceof ProtocolError) return { ok: false, error: line };
      const text = line.text.toLowerCase();
      if (text === "nan" || text === "-nan") {
        return ok({ _tag: "Reply", value: Number.NaN }, line.next);
      }
      if (text === "inf")
        return ok({ _tag: "Reply", value: Infinity }, line.next);
      if (text === "-inf") {
        return ok({ _tag: "Reply", value: -Infinity }, line.next);
      }
      if (!/^-?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(line.text)) {
        return fail(`invalid double ${JSON.stringify(line.text)}`);
      }
      return ok({ _tag: "Reply", value: Number(line.text) }, line.next);
    }
    case LPAREN: {
      const line = parseLine(buf, next);
      if (line === undefined) return INCOMPLETE;
      if (line instanceof ProtocolError) return { ok: false, error: line };
      if (line.text.length === 0 || !/^-?\d+$/.test(line.text)) {
        return fail(`invalid big number ${JSON.stringify(line.text)}`);
      }
      return ok({ _tag: "Reply", value: BigInt(line.text) }, line.next);
    }
    case EQUALS:
      return parseVerbatim(buf, next);
    case PERCENT:
      return parseAggregate(buf, next, "map");
    case TILDE:
      return parseAggregate(buf, next, "set");
    case GT:
      return parseAggregate(buf, next, "push");
    case BANG:
      return parseBlobError(buf, next);
    case QUESTION:
      return fail("unexpected '?' type byte");
    default:
      return fail(
        `unexpected type byte ${JSON.stringify(String.fromCharCode(type))} (0x${type.toString(16)})`,
      );
  }
}

/**
 * Incremental RESP parser. Feed TCP chunks with {@link Parser.push} and
 * pull complete frames with {@link Parser.next}.
 */
export class Parser {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  #offset = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (this.#offset >= this.#buffer.length) {
      this.#buffer = chunk;
      this.#offset = 0;
      return;
    }
    const remaining = this.#buffer.subarray(this.#offset);
    const next = new Uint8Array(remaining.length + chunk.length);
    next.set(remaining, 0);
    next.set(chunk, remaining.length);
    this.#buffer = next;
    this.#offset = 0;
  }

  #compact(): void {
    if (this.#offset === 0) return;
    if (this.#offset >= this.#buffer.length) {
      this.#buffer = new Uint8Array(0);
      this.#offset = 0;
      return;
    }
    this.#buffer = this.#buffer.slice(this.#offset);
    this.#offset = 0;
  }

  /** Unparsed bytes still buffered. */
  get pending(): number {
    return this.#buffer.length - this.#offset;
  }

  next(): ParseResult {
    const result = parseFrame(this.#buffer, this.#offset);
    if (!result.ok) {
      if ("incomplete" in result) {
        this.#compact();
        return Incomplete;
      }
      return { _tag: "Protocol", error: result.error };
    }
    this.#offset = result.offset;
    this.#compact();
    return result.frame;
  }
}

/** Parse one complete frame. Incomplete or leftover bytes are protocol errors. */
export const decode = (bytes: Uint8Array | string): ParseResult => {
  const buf = typeof bytes === "string" ? bytesOf(bytes) : bytes;
  const parser = new Parser();
  parser.push(buf);
  const result = parser.next();
  if (result._tag === "Incomplete") {
    return {
      _tag: "Protocol",
      error: new ProtocolError({ message: "incomplete RESP value" }),
    };
  }
  if (parser.pending > 0 && result._tag !== "Protocol") {
    return {
      _tag: "Protocol",
      error: new ProtocolError({ message: "unexpected trailing RESP bytes" }),
    };
  }
  return result;
};

/** Parse every complete frame in `bytes`. Trailing incomplete data errors. */
export const decodeAll = (bytes: Uint8Array | string): ParseResult[] => {
  const buf = typeof bytes === "string" ? bytesOf(bytes) : bytes;
  const parser = new Parser();
  parser.push(buf);
  const frames: ParseResult[] = [];
  while (true) {
    const result = parser.next();
    if (result._tag === "Incomplete") {
      if (parser.pending > 0 || frames.length === 0) {
        frames.push({
          _tag: "Protocol",
          error: new ProtocolError({ message: "incomplete RESP value" }),
        });
      }
      return frames;
    }
    frames.push(result);
    if (result._tag === "Protocol") return frames;
  }
};
