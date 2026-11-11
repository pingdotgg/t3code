// `zcode serve` hosts a daemon that owns CLI credentials and multiplexes sessions over a
// binary WebSocket channel protocol. This module is the wire half: frame codec plus a
// request/event client. The frame layout was reverse-engineered from the shipped desktop
// client (runtime 3.17.2); it is undocumented and pinned to that runtime.
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

import { ZcodeProtocolError, ZcodeProtocolTimeoutError } from "./zcodeProtocol.ts";

/** 1 byte frame kind, u32 request id, u32 ack, u32 body length. */
const FRAME_HEADER_BYTES = 13;
const FRAME_KIND_MESSAGE = 1;

const CALL = 100;
const LISTEN = 102;
const INITIALIZED = 200;
const RESULT = 201;
const ERROR = 202;
const REJECTED = 203;
const EVENT = 204;

const TAG_UNDEFINED = 0;
const TAG_STRING = 1;
const TAG_BUFFER = 2;
const TAG_ARRAY = 4;
const TAG_OBJECT = 5;
const TAG_INT = 6;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const writeVarint = (bytes: number[], value: number): void => {
  if (value === 0) {
    bytes.push(0);
    return;
  }
  for (let rest = value; rest !== 0; rest = Math.floor(rest / 128)) {
    const byte = rest & 0x7f;
    bytes.push(rest > 0x7f ? byte | 0x80 : byte);
  }
};

const appendBytes = (bytes: number[], chunk: Uint8Array): void => {
  for (const byte of chunk) bytes.push(byte);
};

const serializeInto = (bytes: number[], value: unknown): void => {
  if (value === undefined) {
    bytes.push(TAG_UNDEFINED);
    return;
  }
  if (typeof value === "string") {
    const encoded = textEncoder.encode(value);
    bytes.push(TAG_STRING);
    writeVarint(bytes, encoded.byteLength);
    appendBytes(bytes, encoded);
    return;
  }
  if (value instanceof Uint8Array) {
    bytes.push(TAG_BUFFER);
    writeVarint(bytes, value.byteLength);
    appendBytes(bytes, value);
    return;
  }
  if (Array.isArray(value)) {
    bytes.push(TAG_ARRAY);
    writeVarint(bytes, value.length);
    for (const element of value) serializeInto(bytes, element);
    return;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    bytes.push(TAG_INT);
    writeVarint(bytes, value);
    return;
  }
  const encoded = textEncoder.encode(JSON.stringify(value) ?? "null");
  bytes.push(TAG_OBJECT);
  writeVarint(bytes, encoded.byteLength);
  appendBytes(bytes, encoded);
};

class Reader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  read(count: number): Uint8Array {
    const out = this.bytes.subarray(this.offset, this.offset + count);
    if (out.byteLength !== count) throw new Error("zcode channel frame truncated");
    this.offset += count;
    return out;
  }
}

const readVarint = (reader: Reader): number => {
  let value = 0;
  for (let shift = 0; ; shift += 7) {
    const [byte = 0] = reader.read(1);
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
  }
};

const deserializeFrom = (reader: Reader): unknown => {
  const [tag = -1] = reader.read(1);
  switch (tag) {
    case TAG_UNDEFINED:
      return undefined;
    case TAG_STRING:
      return textDecoder.decode(reader.read(readVarint(reader)));
    case TAG_BUFFER:
      return reader.read(readVarint(reader));
    case TAG_ARRAY: {
      const length = readVarint(reader);
      return Array.from({ length }, () => deserializeFrom(reader));
    }
    case TAG_OBJECT:
      return JSON.parse(textDecoder.decode(reader.read(readVarint(reader))));
    case TAG_INT:
      return readVarint(reader);
    default:
      throw new Error(`zcode channel frame has unknown tag ${tag}`);
  }
};

/** One outbound message frame: `<kind><id><ack><length>` then the serialized body. */
export function encodeChannelFrame(
  header: ReadonlyArray<unknown>,
  arg: unknown,
): Uint8Array<ArrayBuffer> {
  const body: number[] = [];
  serializeInto(body, header);
  serializeInto(body, arg);
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + body.length);
  const frame = new Uint8Array(buffer);
  frame[0] = FRAME_KIND_MESSAGE;
  const view = new DataView(buffer);
  view.setUint32(1, 0);
  view.setUint32(5, 0);
  view.setUint32(9, body.length);
  frame.set(Uint8Array.from(body), FRAME_HEADER_BYTES);
  return frame;
}

export interface ZcodeChannelFrame {
  readonly type: number;
  readonly id: number;
  readonly data: unknown;
}

/** Parses a message body; frames other than messages carry nothing we consume. */
export function decodeChannelFrameBody(body: Uint8Array): ZcodeChannelFrame | undefined {
  const reader = new Reader(body);
  const header = deserializeFrom(reader);
  if (!Array.isArray(header)) return undefined;
  const [type, id] = header;
  if (typeof type !== "number") return undefined;
  if (type === INITIALIZED) return { type, id: 0, data: undefined };
  return { type, id: typeof id === "number" ? id : 0, data: deserializeFrom(reader) };
}

/** Reassembles WebSocket frames into channel message bodies. */
export function makeChannelFramer(): (chunk: Uint8Array) => ReadonlyArray<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;

  const take = (count: number): Uint8Array => {
    const out = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      const slice = chunk.subarray(0, Math.min(chunk.byteLength, count - offset));
      out.set(slice, offset);
      offset += slice.byteLength;
      if (offset === count) break;
    }
    let remaining = count;
    while (remaining > 0) {
      const head = chunks[0];
      if (head === undefined) break;
      if (head.byteLength <= remaining) {
        remaining -= head.byteLength;
        chunks.shift();
      } else {
        chunks[0] = head.subarray(remaining);
        remaining = 0;
      }
    }
    length -= count;
    return out;
  };

  const peekHeader = (): Uint8Array => {
    const out = new Uint8Array(FRAME_HEADER_BYTES);
    let offset = 0;
    for (const chunk of chunks) {
      const slice = chunk.subarray(0, Math.min(chunk.byteLength, FRAME_HEADER_BYTES - offset));
      out.set(slice, offset);
      offset += slice.byteLength;
      if (offset === FRAME_HEADER_BYTES) break;
    }
    return out;
  };

  return (chunk) => {
    if (chunk.byteLength > 0) {
      chunks.push(chunk);
      length += chunk.byteLength;
    }
    const bodies: Uint8Array[] = [];
    for (;;) {
      if (length < FRAME_HEADER_BYTES) break;
      const header = peekHeader();
      const bodyLength =
        ((header[9] ?? 0) * 0x1000000 +
          ((header[10] ?? 0) << 16) +
          ((header[11] ?? 0) << 8) +
          (header[12] ?? 0)) >>>
        0;
      if (length < FRAME_HEADER_BYTES + bodyLength) break;
      take(FRAME_HEADER_BYTES);
      const body = bodyLength === 0 ? new Uint8Array(0) : take(bodyLength);
      if (header[0] === FRAME_KIND_MESSAGE) bodies.push(body);
    }
    return bodies;
  };
}

export interface ZcodeChannelClient {
  readonly call: (
    channel: string,
    method: string,
    arg: unknown,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, ZcodeProtocolError | ZcodeProtocolTimeoutError>;
  readonly listen: (
    channel: string,
    event: string,
    arg: unknown,
    onEvent: (payload: unknown) => void,
  ) => Effect.Effect<void, ZcodeProtocolError>;
  /** Resolves when the socket closes; never fails, so finalizers stay quiet. */
  readonly closed: Effect.Effect<void>;
}

export interface ZcodeChannelClientOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

interface PendingCall {
  readonly deferred: Deferred.Deferred<unknown, ZcodeProtocolError>;
  readonly method: string;
}

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const INITIALIZE_TIMEOUT_MS = 15_000;

/**
 * Node's global WebSocket (undici) accepts request headers; the DOM lib typing does not.
 * `/ws/host` rejects the handshake without the capability header, so the cast is required.
 */
const openSocket = (url: string, headers: Readonly<Record<string, string>>): WebSocket =>
  new (WebSocket as unknown as new (
    url: string,
    init: { headers: Record<string, string> },
  ) => WebSocket)(url, { headers: { ...headers } });

export const makeZcodeChannelClient = Effect.fnUntraced(function* (
  options: ZcodeChannelClientOptions,
) {
  const scope = yield* Effect.scope;
  const pending = new Map<number, PendingCall>();
  const listeners = new Map<number, (payload: unknown) => void>();
  const initialized = yield* Deferred.make<boolean, ZcodeProtocolError>();
  const closed = yield* Deferred.make<void>();
  const initQueue = yield* Queue.unbounded<void>();
  const results = yield* Queue.unbounded<{
    readonly call: PendingCall;
    readonly data: unknown;
    readonly failed: boolean;
  }>();
  const failures = yield* Queue.unbounded<unknown>();
  const socketClosures = yield* Queue.unbounded<string>();
  const frame = makeChannelFramer();
  let nextId = 0;

  const transportError = (operation: string, cause: unknown) =>
    new ZcodeProtocolError({ operation, cause });

  const failAll = Effect.fn("ZcodeChannel.failAll")(function* (error: ZcodeProtocolError) {
    yield* Deferred.fail(initialized, error).pipe(Effect.ignore);
    for (const [id, call] of pending) {
      pending.delete(id);
      yield* Deferred.fail(call.deferred, error).pipe(Effect.ignore);
    }
    yield* Deferred.succeed(closed, undefined).pipe(Effect.ignore);
  });

  const socket = openSocket(options.url, options.headers ?? {});
  socket.binaryType = "arraybuffer";

  const route = (parsed: ZcodeChannelFrame): void => {
    if (parsed.type === INITIALIZED) {
      Queue.offerUnsafe(initQueue, undefined);
      return;
    }
    if (parsed.type === EVENT) {
      listeners.get(parsed.id)?.(parsed.data);
      return;
    }
    const call = pending.get(parsed.id);
    if (call === undefined) return;
    pending.delete(parsed.id);
    if (parsed.type === RESULT) {
      Queue.offerUnsafe(results, { call, data: parsed.data, failed: false });
      return;
    }
    if (parsed.type === ERROR || parsed.type === REJECTED) {
      Queue.offerUnsafe(results, { call, data: parsed.data, failed: true });
    }
  };

  const onMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : undefined;
    if (bytes === undefined) return;
    for (const body of frame(bytes)) {
      try {
        const parsed = decodeChannelFrameBody(body);
        if (parsed !== undefined) route(parsed);
      } catch (cause) {
        Queue.offerUnsafe(failures, cause);
      }
    }
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", (event) =>
    Queue.offerUnsafe(socketClosures, `code ${event.code}`),
  );
  socket.addEventListener("error", () => Queue.offerUnsafe(socketClosures, "socket error"));

  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      socket.removeEventListener("message", onMessage);
      socket.close();
    }),
  );

  // Settlement and closure handling run off the callback path so socket callbacks stay cheap.
  yield* Effect.gen(function* () {
    for (;;) {
      const settled = yield* Queue.take(results);
      yield* settled.failed
        ? Deferred.fail(
            settled.call.deferred,
            transportError(settled.call.method, settled.data),
          ).pipe(Effect.ignore)
        : Deferred.succeed(settled.call.deferred, settled.data).pipe(Effect.ignore);
    }
  }).pipe(Effect.forkIn(scope), Effect.asVoid);

  yield* Effect.gen(function* () {
    for (;;) {
      const reason = yield* Queue.take(socketClosures);
      yield* failAll(transportError("connect", `zcode server channel closed (${reason})`));
    }
  }).pipe(Effect.forkIn(scope), Effect.asVoid);

  yield* Effect.gen(function* () {
    for (;;) {
      const cause = yield* Queue.take(failures);
      yield* failAll(transportError("decode", cause));
    }
  }).pipe(Effect.forkIn(scope), Effect.asVoid);

  yield* Effect.raceFirst(
    Queue.take(initQueue).pipe(
      Effect.timeoutOption(Duration.millis(INITIALIZE_TIMEOUT_MS)),
      Effect.flatMap((ready) =>
        Option.isSome(ready)
          ? Deferred.succeed(initialized, true).pipe(Effect.ignore)
          : failAll(transportError("initialize", "zcode server channel handshake timed out")),
      ),
    ),
    Deferred.await(closed),
  ).pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid);

  const awaitInitialized = Deferred.await(initialized);

  const send = (header: ReadonlyArray<unknown>, arg: unknown) =>
    Effect.suspend(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        return Effect.fail(transportError("send", "zcode server channel is not open"));
      }
      socket.send(encodeChannelFrame(header, arg));
      return Effect.void;
    });

  const call = Effect.fn("ZcodeChannel.call")(function* (
    channel: string,
    method: string,
    arg: unknown,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Effect.fn.Return<unknown, ZcodeProtocolError | ZcodeProtocolTimeoutError> {
    yield* awaitInitialized;
    const id = nextId++;
    const deferred = yield* Deferred.make<unknown, ZcodeProtocolError>();
    pending.set(id, { deferred, method: `${channel}.${method}` });
    yield* send([CALL, id, channel, method], [arg]).pipe(
      Effect.onError(() => Effect.sync(() => pending.delete(id))),
    );
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.fail(
            new ZcodeProtocolTimeoutError({ operation: `${channel}.${method}`, timeoutMs }),
          ),
      }),
      Effect.onInterrupt(() => Effect.sync(() => pending.delete(id))),
      Effect.onError(() => Effect.sync(() => pending.delete(id))),
    );
  });

  const listen = Effect.fn("ZcodeChannel.listen")(function* (
    channel: string,
    event: string,
    arg: unknown,
    onEvent: (payload: unknown) => void,
  ) {
    yield* awaitInitialized;
    const id = nextId++;
    listeners.set(id, onEvent);
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => void listeners.delete(id)),
    );
    yield* send([LISTEN, id, channel, event], arg);
  });

  return {
    call,
    listen,
    closed: Deferred.await(closed),
  } satisfies ZcodeChannelClient;
});
