import { RelayChannelFrame } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
]);
const KEEPALIVE_INTERVAL = "25 seconds";
const RECONNECT_DELAY = "3 seconds";

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
export function forwardedRequestHeaders(
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

/** The local URL for a forwarded path; anything but an origin-relative path is refused. */
export function localTargetUrl(localOrigin: string, path: string): string | null {
  return /^\/(?!\/)/u.test(path) ? `${localOrigin.replace(/\/+$/u, "")}${path}` : null;
}

function flattenHeaders(headers: Readonly<Record<string, string | string[] | undefined>>) {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || CONNECTION_HEADERS.has(name)) continue;
    flat[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

async function forwardHttp(localOrigin: string, frame: HttpRequestFrame) {
  const failed = { type: "http-response", id: frame.id, status: 502, headers: {} } as const;
  const url = localTargetUrl(localOrigin, frame.path);
  if (url === null) return failed;
  try {
    const response = await undiciRequest(url, {
      method: frame.method as Dispatcher.HttpMethod,
      headers: forwardedRequestHeaders(frame.headers),
      ...(frame.body ? { body: Buffer.from(frame.body, "base64") } : {}),
    });
    const body = Buffer.from(await response.body.arrayBuffer());
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

function openChannel(input: RelayChannelInput) {
  const channel = new WebSocket(input.channelUrl, {
    headers: { authorization: `Bearer ${input.token}` },
  });
  const locals = new Map<number, WebSocket>();
  let opened = false;
  const send = (frame: RelayChannelFrame) => {
    if (channel.readyState === WebSocket.OPEN) channel.send(JSON.stringify(frame));
  };
  const closeLocals = () => {
    for (const socket of locals.values()) socket.close();
    locals.clear();
  };
  channel.addEventListener("open", () => {
    opened = true;
  });
  channel.addEventListener("message", (event) => {
    const frame = parseFrame(event.data);
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
  });
  const closed = new Promise<string>((resolve) =>
    channel.addEventListener("close", (event) => {
      closeLocals();
      resolve(opened ? `closed with code ${event.code}` : "could not connect");
    }),
  );
  return {
    send,
    closed,
    dispose: () => {
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
  yield* Effect.sync(() => channel.send({ type: "ping" })).pipe(
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
}

/** Keeps this environment reachable through its relay channel until interrupted. */
export const runRelayChannel = Effect.fn("RelayChannelClient.run")(function* (
  input: RelayChannelInput,
) {
  yield* Effect.logInfo("Connecting the T3 Connect relay channel", {
    channelUrl: input.channelUrl,
  });
  return yield* connectOnce(input).pipe(
    Effect.tap((reason) => Effect.logWarning("T3 Connect relay channel ended", { reason })),
    Effect.andThen(Effect.sleep(RECONNECT_DELAY)),
    Effect.forever,
  );
});
