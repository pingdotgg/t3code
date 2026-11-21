import {
  RELAY_CHANNEL_MAX_BODY_BYTES,
  RELAY_CHANNEL_RESPONSE_TIMEOUT_MS,
  RelayChannelFrame,
} from "@t3tools/contracts/relay";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { request as undiciRequest, WebSocket, type Dispatcher } from "undici";

type HttpRequestFrame = Extract<RelayChannelFrame, { readonly type: "http-request" }>;
type WsOpenFrame = Extract<RelayChannelFrame, { readonly type: "ws-open" }>;

// The relay and this server each own their connection; these do not cross the channel.
const CONNECTION_HEADERS = new Set([
  "connection",
  "keep-alive",
  "upgrade",
  "transfer-encoding",
  "content-length",
  // The relay already holds the whole body, so there is nothing to wait for.
  "expect",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
]);
const KEEPALIVE_INTERVAL = "25 seconds";
const RECONNECT_DELAY = Duration.seconds(3);
const MAX_RECONNECT_DELAY = Duration.minutes(5);

const decodeFrame = Schema.decodeUnknownOption(RelayChannelFrame);

function parseFrame(data: unknown): RelayChannelFrame | null {
  try {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    return Option.getOrNull(decodeFrame(JSON.parse(text)));
  } catch {
    return null;
  }
}

/** Requests reach this server as they would through a TLS-terminating tunnel. */
function forwardedRequestHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const forwarded = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CONNECTION_HEADERS.has(name.toLowerCase())),
  );
  return {
    ...forwarded,
    "x-forwarded-proto": "https",
    ...(headers.host ? { "x-forwarded-host": headers.host } : {}),
  };
}

/**
 * The local URL for a forwarded path; anything but an origin-relative path is refused, and so is
 * a fragment, which a WebSocket URL may not carry.
 */
export function localTargetUrl(localOrigin: string, path: string): string | null {
  return /^\/(?!\/)[^#]*$/u.test(path) ? `${localOrigin.replace(/\/+$/u, "")}${path}` : null;
}

function flattenHeaders(headers: Readonly<Record<string, string | string[] | undefined>>) {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || CONNECTION_HEADERS.has(name)) continue;
    flat[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

// Concurrent downloads each hold their body until it is complete, so the cap covers all of them.
const MAX_IN_FLIGHT_BODY_BYTES = RELAY_CHANNEL_MAX_BODY_BYTES * 2;
let inFlightBodyBytes = 0;

async function forwardHttp(localOrigin: string, frame: HttpRequestFrame) {
  const failed = { type: "http-response", id: frame.id, status: 502, headers: {} } as const;
  const url = localTargetUrl(localOrigin, frame.path);
  if (url === null) return failed;
  try {
    const response = await undiciRequest(url, {
      method: frame.method as Dispatcher.HttpMethod,
      headers: forwardedRequestHeaders(frame.headers),
      ...(frame.body ? { body: Buffer.from(frame.body, "base64") } : {}),
      // The relay stops waiting then, so the work is dropped with it.
      signal: AbortSignal.timeout(RELAY_CHANNEL_RESPONSE_TIMEOUT_MS),
    });
    // shortcut: a response crosses the channel whole, so streams and bodies over the cap fail;
    // send bodies in chunked frames if streaming or large downloads must work over a relay.
    const chunks: Array<Buffer> = [];
    let size = 0;
    let body: Buffer;
    try {
      for await (const chunk of response.body) {
        const length = (chunk as Buffer).byteLength;
        if (
          size + length > RELAY_CHANNEL_MAX_BODY_BYTES ||
          inFlightBodyBytes + length > MAX_IN_FLIGHT_BODY_BYTES
        ) {
          response.body.destroy();
          return failed;
        }
        size += length;
        inFlightBodyBytes += length;
        chunks.push(chunk as Buffer);
      }
      body = Buffer.concat(chunks);
    } finally {
      inFlightBodyBytes -= size;
    }
    return {
      type: "http-response",
      id: frame.id,
      status: response.statusCode,
      headers: flattenHeaders(response.headers),
      ...(body.byteLength > 0 ? { body: body.toString("base64") } : {}),
    } as const;
  } catch {
    return failed;
  }
}

function openLocalSocket(
  localOrigin: string,
  frame: WsOpenFrame,
  send: (frame: RelayChannelFrame) => void,
): WebSocket | null {
  const url = localTargetUrl(localOrigin.replace(/^http/u, "ws"), frame.path);
  if (url === null) return null;
  // shortcut: WebSocket subprotocols are not negotiated; the environment's /ws authenticates by ticket.
  const {
    host: _host,
    "sec-websocket-protocol": _protocol,
    ...headers
  } = forwardedRequestHeaders(frame.headers);
  const socket = new WebSocket(url, { headers });
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => send({ type: "ws-opened", id: frame.id }));
  socket.addEventListener("message", (event) =>
    send(
      typeof event.data === "string"
        ? { type: "ws-message", id: frame.id, data: event.data }
        : {
            type: "ws-message",
            id: frame.id,
            data: Buffer.from(event.data as ArrayBuffer).toString("base64"),
            binary: true,
          },
    ),
  );
  socket.addEventListener("close", (event) =>
    send({ type: "ws-close", id: frame.id, code: event.code, reason: event.reason }),
  );
  return socket;
}

interface ChannelEnd {
  /** Whether the relay accepted the channel before it ended. */
  readonly opened: boolean;
  readonly reason: string;
}

function openChannel(input: RelayChannelInput) {
  const channel = new WebSocket(input.channelUrl, {
    headers: { authorization: `Bearer ${input.token}` },
  });
  const locals = new Map<number, WebSocket>();
  let opened = false;
  let heard = true;
  let end: (reason: string) => void = () => {};
  const send = (frame: RelayChannelFrame) => {
    if (channel.readyState === WebSocket.OPEN) channel.send(JSON.stringify(frame));
  };
  const closeLocals = () => {
    for (const socket of locals.values()) socket.close();
    locals.clear();
  };
  let disposed = false;
  channel.addEventListener("open", () => {
    opened = true;
    if (!disposed) input.onOpenChange?.(true);
  });
  const handleFrame = (frame: RelayChannelFrame | null) => {
    switch (frame?.type) {
      case "http-request":
        void forwardHttp(input.localOrigin, frame).then(send);
        return;
      case "ws-open": {
        const socket = openLocalSocket(input.localOrigin, frame, (reply) => {
          if (reply.type === "ws-close") locals.delete(frame.id);
          send(reply);
        });
        if (socket === null) send({ type: "ws-close", id: frame.id, code: 1008 });
        else locals.set(frame.id, socket);
        return;
      }
      case "ws-message": {
        const socket = locals.get(frame.id);
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(frame.binary ? Buffer.from(frame.data, "base64") : frame.data);
        }
        return;
      }
      case "ws-close":
        locals.get(frame.id)?.close();
        locals.delete(frame.id);
        return;
      default:
        return;
    }
  };
  channel.addEventListener("message", (event) => {
    heard = true;
    const frame = parseFrame(event.data);
    try {
      handleFrame(frame);
    } catch {
      // A listener's exception is rethrown as an uncaught one; one frame must not end this server.
      if (frame?.type === "ws-open") send({ type: "ws-close", id: frame.id, code: 1011 });
    }
  });
  const closed = new Promise<ChannelEnd>((resolve) => {
    end = (reason) => resolve({ opened, reason });
    channel.addEventListener("close", (event) => {
      closeLocals();
      end(opened ? `closed with code ${event.code}` : "could not connect");
    });
  });
  return {
    send,
    closed,
    // After a sleep the socket can look open long after the relay dropped it; the relay answers
    // every ping, so a silent interval means the channel is gone.
    ping: () => {
      if (!heard) return end("the relay stopped answering");
      heard = false;
      send({ type: "ping" });
    },
    dispose: () => {
      if (!disposed) input.onOpenChange?.(false);
      disposed = true;
      closeLocals();
      channel.close();
    },
  };
}

/** One channel connection; succeeds with why it ended. */
const connectOnce = Effect.fn("RelayChannelClient.connectOnce")(function* (
  input: RelayChannelInput,
) {
  const channel = yield* Effect.acquireRelease(
    Effect.sync(() => openChannel(input)),
    (opened) => Effect.sync(opened.dispose),
  );
  // Proxies drop idle WebSockets; a ping keeps the channel open between requests.
  yield* Effect.sync(channel.ping).pipe(
    Effect.repeat(Schedule.spaced(KEEPALIVE_INTERVAL)),
    Effect.forkScoped,
  );
  return yield* Effect.promise(() => channel.closed);
}, Effect.scoped);

export interface RelayChannelInput {
  readonly channelUrl: string;
  /** The environment credential the relay issued for this link. */
  readonly token: string;
  /** Where this server listens, e.g. `http://127.0.0.1:3773`. */
  readonly localOrigin: string;
  /** Told when the relay accepts a channel and when that channel ends. */
  readonly onOpenChange?: (open: boolean) => void;
}

/** Keeps this environment reachable through its relay channel until interrupted. */
export const runRelayChannel = Effect.fn("RelayChannelClient.run")(function* (
  input: RelayChannelInput,
) {
  // The URL can carry a query string or credentials; only its host is safe to log.
  yield* Effect.logInfo("Connecting the T3 Connect relay channel", {
    relayHost: URL.canParse(input.channelUrl) ? new URL(input.channelUrl).host : "invalid",
  });
  let failures = 0;
  return yield* connectOnce(input).pipe(
    // The WebSocket constructor throws on a malformed URL; retry instead of ending the fiber.
    Effect.catchDefect(() =>
      Effect.succeed({ opened: false, reason: "invalid channel configuration" }),
    ),
    Effect.tap((ended) => {
      failures = ended.opened ? 0 : failures + 1;
      return Effect.logWarning("T3 Connect relay channel ended", { reason: ended.reason });
    }),
    Effect.andThen(() => reconnectDelay(failures)),
    Effect.flatMap(Effect.sleep),
    Effect.forever,
  );
});

/**
 * Doubles after each attempt the relay refused, up to a cap, so a revoked or unreachable channel
 * is not retried every few seconds; jitter spreads environments out after a relay restart.
 */
const reconnectDelay = (failures: number) =>
  Effect.map(Random.next, (jitter) =>
    Duration.times(
      Duration.min(
        Duration.times(RECONNECT_DELAY, 2 ** Math.min(failures, 10)),
        MAX_RECONNECT_DELAY,
      ),
      0.5 + jitter / 2,
    ),
  );
