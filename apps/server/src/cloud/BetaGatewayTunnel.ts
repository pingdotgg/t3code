// @effect-diagnostics nodeBuiltinImport:off - Gateway streams carry raw TCP bytes to this server's own listener.
import * as NodeNet from "node:net";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Socket from "effect/socket/Socket";

/** Subprotocol of the gateway's connector endpoint. */
const GATEWAY_PROTOCOL = "t3-connect-v1";
/** The gateway closes with this code when the relay does not grant the connector token. */
const CREDENTIAL_REJECTED_CLOSE_CODE = 4401;

export interface BetaGatewayConnection {
  readonly gatewayUrl: string;
  readonly connectorToken: string;
  /** This server's own HTTP listener. */
  readonly origin: { readonly host: string; readonly port: number };
  readonly onReadyChange: (ready: boolean) => Effect.Effect<void>;
}

export class BetaGatewayConnector extends Context.Service<
  BetaGatewayConnector,
  {
    /** Keeps this server attached to the gateway. Returns once the gateway rejects the token. */
    readonly run: (input: BetaGatewayConnection) => Effect.Effect<void>;
  }
>()("t3/cloud/BetaGatewayTunnel/BetaGatewayConnector") {}

// yamux framing (github.com/libp2p/go-yamux), the gateway's multiplexer.
const HEADER_BYTES = 12;
const TYPE_DATA = 0;
const TYPE_WINDOW_UPDATE = 1;
const TYPE_PING = 2;
const TYPE_GO_AWAY = 3;
const FLAG_SYN = 1;
const FLAG_ACK = 2;
const FLAG_FIN = 4;
const FLAG_RST = 8;
/** yamux's initial stream window. The host never grows its own. */
export const STREAM_WINDOW = 256 * 1024;
const MAX_FRAME_PAYLOAD = 32 * 1024;
// Above the gateway's 256 so streams that are still closing never refuse a new request.
const MAX_STREAMS = 512;
const CLOSED_STREAM_IDLE_MS = 30_000;

export function encodeFrame(
  type: number,
  flags: number,
  streamId: number,
  length: number,
  payload?: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(HEADER_BYTES + (payload?.byteLength ?? 0));
  const view = new DataView(frame.buffer);
  view.setUint8(1, type);
  view.setUint16(2, flags);
  view.setUint32(4, streamId);
  view.setUint32(8, length);
  if (payload) frame.set(payload, HEADER_BYTES);
  return frame;
}

function concat(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

interface TunnelStream {
  readonly socket: NodeNet.Socket;
  sendWindow: number;
  recvWindow: number;
  unacked: number;
  readonly queued: Array<Uint8Array>;
  originEnded: boolean;
  gatewayClosed: boolean;
}

export interface TunnelSession {
  readonly receive: (chunk: Uint8Array) => void;
  readonly ping: () => void;
  readonly framesReceived: () => number;
  readonly destroy: () => void;
}

/**
 * Host side of one gateway connection. The gateway opens every stream: the first confirms
 * admission and each later one carries one public request to a fresh `connect()` socket.
 * The gateway only closes whole streams, so its FIN ends both directions.
 */
export function makeTunnelSession(options: {
  readonly send: (frame: Uint8Array) => void;
  readonly connect: () => NodeNet.Socket;
  readonly onAdmitted: () => void;
  readonly onClose: (reason: string) => void;
}): TunnelSession {
  const streams = new Map<number, TunnelStream>();
  let admission: { readonly id: number; confirmed: boolean } | null = null;
  let buffered: Uint8Array = new Uint8Array(0);
  let received = 0;
  let pingId = 0;
  let closed = false;

  const send = (type: number, flags: number, id: number, length: number, payload?: Uint8Array) => {
    if (!closed) options.send(encodeFrame(type, flags, id, length, payload));
  };

  const destroy = () => {
    if (closed) return;
    closed = true;
    for (const stream of streams.values()) stream.socket.destroy();
    streams.clear();
  };

  const fail = (reason: string) => {
    if (closed) return;
    destroy();
    options.onClose(reason);
  };

  const flush = (id: number, stream: TunnelStream) => {
    if (stream.gatewayClosed) {
      stream.queued.length = 0;
      return;
    }
    while (stream.queued.length > 0 && stream.sendWindow > 0) {
      const chunk = stream.queued[0]!;
      const size = Math.min(chunk.byteLength, stream.sendWindow, MAX_FRAME_PAYLOAD);
      send(TYPE_DATA, 0, id, size, chunk.subarray(0, size));
      stream.sendWindow -= size;
      if (size === chunk.byteLength) stream.queued.shift();
      else stream.queued[0] = chunk.subarray(size);
    }
    if (stream.queued.length > 0) {
      stream.socket.pause();
    } else if (stream.originEnded) {
      send(TYPE_WINDOW_UPDATE, FLAG_FIN, id, 0);
      streams.delete(id);
      stream.socket.destroy();
    } else {
      stream.socket.resume();
    }
  };

  const open = (id: number, windowDelta: number) => {
    if (id % 2 === 0 || streams.has(id) || admission?.id === id) {
      return fail("gateway reused or misnumbered a stream");
    }
    if (admission === null) {
      admission = { id, confirmed: false };
      send(TYPE_WINDOW_UPDATE, FLAG_ACK, id, 0);
      return;
    }
    if (streams.size >= MAX_STREAMS) return send(TYPE_WINDOW_UPDATE, FLAG_RST, id, 0);
    const socket = options.connect();
    const stream: TunnelStream = {
      socket,
      sendWindow: STREAM_WINDOW + windowDelta,
      recvWindow: STREAM_WINDOW,
      unacked: 0,
      queued: [],
      originEnded: false,
      gatewayClosed: false,
    };
    streams.set(id, stream);
    send(TYPE_WINDOW_UPDATE, FLAG_ACK, id, 0);
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      stream.queued.push(chunk);
      flush(id, stream);
    });
    socket.on("end", () => {
      stream.originEnded = true;
      flush(id, stream);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (streams.get(id) !== stream) return;
      // An origin that ended cleanly may still be waiting for send window.
      if (stream.originEnded && !stream.gatewayClosed) return;
      streams.delete(id);
      if (!stream.gatewayClosed) send(TYPE_WINDOW_UPDATE, FLAG_RST, id, 0);
    });
  };

  const deliver = (id: number, payload: Uint8Array) => {
    if (admission?.id === id) {
      if (admission.confirmed) return;
      if (payload[0] !== 1) return fail("gateway did not confirm the route");
      admission.confirmed = true;
      return options.onAdmitted();
    }
    const stream = streams.get(id);
    if (!stream || stream.gatewayClosed) return;
    if (payload.byteLength > stream.recvWindow) return fail("gateway exceeded the stream window");
    stream.recvWindow -= payload.byteLength;
    stream.socket.write(payload, (error) => {
      if (error || streams.get(id) !== stream) return;
      stream.unacked += payload.byteLength;
      if (stream.unacked < STREAM_WINDOW / 2) return;
      stream.recvWindow += stream.unacked;
      send(TYPE_WINDOW_UPDATE, 0, id, stream.unacked);
      stream.unacked = 0;
    });
  };

  const closeStream = (id: number, reset: boolean) => {
    const stream = streams.get(id);
    if (!stream) return;
    if (reset || stream.socket.destroyed) {
      streams.delete(id);
      stream.socket.destroy();
      return;
    }
    // Let buffered writes reach the origin, but drop its reply: nothing reads this stream now.
    stream.gatewayClosed = true;
    stream.queued.length = 0;
    stream.socket.resume();
    stream.socket.end();
    stream.socket.setTimeout(CLOSED_STREAM_IDLE_MS, () => stream.socket.destroy());
  };

  const handle = (type: number, flags: number, id: number, length: number, payload: Uint8Array) => {
    if (type === TYPE_PING) {
      if (flags & FLAG_SYN) send(TYPE_PING, FLAG_ACK, 0, length);
      return;
    }
    if (type === TYPE_GO_AWAY) return fail("gateway is going away");
    const isWindowUpdate = type === TYPE_WINDOW_UPDATE;
    if (flags & FLAG_SYN) {
      open(id, isWindowUpdate ? length : 0);
    } else if (isWindowUpdate && !(flags & FLAG_RST)) {
      const stream = streams.get(id);
      if (stream) {
        stream.sendWindow += length;
        flush(id, stream);
      }
    }
    if (closed) return;
    if (!isWindowUpdate && length > 0) deliver(id, payload);
    if (flags & (FLAG_FIN | FLAG_RST)) closeStream(id, (flags & FLAG_RST) !== 0);
  };

  const receive = (chunk: Uint8Array) => {
    if (closed) return;
    buffered = buffered.byteLength === 0 ? chunk : concat([buffered, chunk]);
    let offset = 0;
    while (buffered.byteLength - offset >= HEADER_BYTES) {
      if (closed) return;
      const view = new DataView(buffered.buffer, buffered.byteOffset + offset, HEADER_BYTES);
      const type = view.getUint8(1);
      const length = view.getUint32(8);
      if (view.getUint8(0) !== 0 || type > TYPE_GO_AWAY) return fail("invalid frame from gateway");
      const payloadBytes = type === TYPE_DATA ? length : 0;
      if (payloadBytes > STREAM_WINDOW) return fail("gateway exceeded the stream window");
      if (buffered.byteLength - offset < HEADER_BYTES + payloadBytes) break;
      const start = offset + HEADER_BYTES;
      offset = start + payloadBytes;
      received += 1;
      handle(type, view.getUint16(2), view.getUint32(4), length, buffered.subarray(start, offset));
    }
    buffered = buffered.subarray(offset);
  };

  return {
    receive,
    ping: () => {
      pingId = (pingId + 1) >>> 0;
      send(TYPE_PING, FLAG_SYN, 0, pingId);
    },
    framesReceived: () => received,
    destroy,
  };
}

const KEEPALIVE_INTERVAL = Duration.seconds(30);
const ADMISSION_TIMEOUT = Duration.seconds(10);
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const STABLE_CONNECTION_MS = 30_000;

const isCredentialRejection = (error: unknown) =>
  Socket.isSocketError(error) &&
  error.reason._tag === "SocketCloseError" &&
  error.reason.code === CREDENTIAL_REJECTED_CLOSE_CODE;

const connectOnce = Effect.fn("BetaGatewayConnector.connect")(function* (
  input: BetaGatewayConnection,
) {
  const socket = yield* Socket.makeWebSocket(input.gatewayUrl, {
    openTimeout: ADMISSION_TIMEOUT,
    protocols: [GATEWAY_PROTOCOL],
    headers: { authorization: `Bearer ${input.connectorToken}` },
  });
  const outbound = yield* Queue.unbounded<Uint8Array>();
  const admitted = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<never, string>();
  const session = makeTunnelSession({
    send: (frame) => {
      Queue.offerUnsafe(outbound, frame);
    },
    connect: () => NodeNet.connect({ host: input.origin.host, port: input.origin.port }),
    onAdmitted: () => Deferred.doneUnsafe(admitted, Exit.void),
    onClose: (reason) => Deferred.doneUnsafe(closed, Exit.fail(reason)),
  });
  return yield* Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(session.destroy));
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    const writeFrames = Queue.takeAll(outbound).pipe(
      Effect.flatMap((frames) => writer.write(concat(frames))),
      Effect.forever,
    );
    const readFrames = reader.pull.pipe(
      Effect.flatMap((chunks) => {
        for (const chunk of chunks) {
          if (typeof chunk === "string") return Effect.fail("gateway sent a text frame");
          session.receive(chunk);
        }
        return Effect.void;
      }),
      Effect.forever,
    );
    // The gateway answers every ping, so a silent interval means the path is dead.
    const keepalive = Effect.gen(function* () {
      let seen = session.framesReceived();
      while (true) {
        session.ping();
        yield* Effect.sleep(KEEPALIVE_INTERVAL);
        if (session.framesReceived() === seen)
          return yield* Effect.fail("gateway stopped answering");
        seen = session.framesReceived();
      }
    });
    const ready = Deferred.await(admitted).pipe(
      Effect.timeoutOrElse({
        duration: ADMISSION_TIMEOUT,
        orElse: () => Effect.fail("gateway did not confirm the route"),
      }),
      Effect.andThen(input.onReadyChange(true)),
      Effect.andThen(Effect.never),
    );
    return yield* Effect.raceAllFirst([
      writeFrames,
      readFrames,
      keepalive,
      ready,
      Deferred.await(closed),
    ]);
  }).pipe(
    Effect.scoped,
    Effect.matchEffect({
      onFailure: (error) => {
        if (isCredentialRejection(error)) return Effect.succeed("rejected" as const);
        // Socket error messages carry peer and platform text; log only the kind and close code.
        const annotations = Socket.isSocketError(error)
          ? {
              reason: error.reason._tag,
              ...(error.reason._tag === "SocketCloseError" ? { closeCode: error.reason.code } : {}),
            }
          : { reason: error };
        return Effect.logInfo("T3 Connect beta gateway connection ended", annotations).pipe(
          Effect.as("disconnected" as const),
        );
      },
      onSuccess: () => Effect.succeed("disconnected" as const),
    }),
  );
});

const make = Effect.gen(function* () {
  const makeWebSocket = yield* Socket.WebSocketConstructor;
  // Lives as long as the link; each connection attempt gets its own span.
  const run = Effect.fnUntraced(function* (input: BetaGatewayConnection) {
    let delayMs = RECONNECT_MIN_MS;
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis;
      const outcome = yield* connectOnce(input).pipe(
        Effect.provideService(Socket.WebSocketConstructor, makeWebSocket),
      );
      yield* input.onReadyChange(false);
      if (outcome === "rejected") return;
      if ((yield* Clock.currentTimeMillis) - startedAt >= STABLE_CONNECTION_MS) {
        delayMs = RECONNECT_MIN_MS;
      }
      // Jitter spreads the reconnects after a gateway restart.
      const jitterMs = yield* Random.nextIntBetween(0, delayMs);
      yield* Effect.sleep(Duration.millis(delayMs / 2 + jitterMs / 2));
      delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
    }
  });
  return BetaGatewayConnector.of({ run });
});

export const layer = Layer.effect(BetaGatewayConnector, make).pipe(
  Layer.provide(NodeSocket.layerWebSocketConstructor),
);
