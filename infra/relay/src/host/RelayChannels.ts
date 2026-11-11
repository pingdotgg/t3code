import {
  RELAY_CHANNEL_MAX_BODY_BYTES,
  RELAY_CHANNEL_RESPONSE_TIMEOUT_MS,
  RelayChannelFrame,
} from "@t3tools/contracts/relay";
import * as ByteSize from "effect/ByteSize";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import { channelKey, channelPathTarget } from "../environments/RelayChannelEndpoint.ts";

type HttpResponseFrame = Extract<RelayChannelFrame, { readonly type: "http-response" }>;
type SocketFrame = Extract<
  RelayChannelFrame,
  { readonly type: "ws-opened" | "ws-message" | "ws-close" }
>;

interface Channel {
  readonly send: (frame: RelayChannelFrame) => Effect.Effect<void>;
  readonly responses: Map<number, Deferred.Deferred<HttpResponseFrame>>;
  readonly sockets: Map<number, Queue.Queue<SocketFrame>>;
  /** Completed when a reconnect takes this channel's place. */
  readonly replaced: Deferred.Deferred<void>;
  /** Completed once the channel's socket is gone. */
  readonly ended: Deferred.Deferred<void>;
  /** Rechecks since the environment last sent a frame. */
  quietChecks: number;
}

const CREDENTIAL_RECHECK_INTERVAL = "25 seconds";
// Environments ping as often as the relay rechecks, so this much silence is a dead connection.
const MAX_QUIET_CHECKS = 2;
// The environment's own document sandbox: scripts run, but in an opaque origin, never the relay's.
const CARRIED_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-downloads";
const CHANNEL_SOCKET_PATH = /^\/v1\/environments\/([^/?]+)\/channel(?:\?.*)?$/u;
// Per-connection headers stay on their own side of the relay.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "upgrade",
  "transfer-encoding",
  "content-length",
]);

const decodeFrame = Schema.decodeUnknownOption(RelayChannelFrame);

function parseFrame(chunk: string | Uint8Array): Option.Option<RelayChannelFrame> {
  try {
    return decodeFrame(
      JSON.parse(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
    );
  } catch {
    return Option.none();
  }
}

// Response headers a carried environment may send through the relay's shared origin: content,
// caching, redirects, auth challenges and CORS. Anything else, such as cookies or site policies,
// would act on the relay origin itself.
const ALLOWED_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-range",
  "content-disposition",
  "content-encoding",
  "content-language",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "vary",
  "location",
  "www-authenticate",
  "retry-after",
  "dpop-nonce",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
]);

function withoutHopByHop(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

/** Lowercases names, which frames from an environment need not do, and keeps the allowlist. */
function allowedResponseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .filter(([name]) => ALLOWED_RESPONSE_HEADERS.has(name)),
  );
}

// Only these codes may be sent in a close frame; 1005 and 1006 only describe a close.
function sendableCloseCode(code: number | undefined): number {
  return code !== undefined &&
    (code === 1000 ||
      (code >= 1001 && code <= 1003) ||
      (code >= 1007 && code <= 1014) ||
      (code >= 3000 && code <= 4999))
    ? code
    : 1000;
}

type ChannelTarget = NonNullable<ReturnType<typeof channelPathTarget>>;

/** The client's headers, telling the environment which prefix the relay stripped. */
function forwardedHeaders(request: HttpServerRequest.HttpServerRequest, target: ChannelTarget) {
  return { ...withoutHopByHop(request.headers), "x-forwarded-prefix": target.prefix };
}

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

/**
 * Carries environments with no public address: each one dials `/v1/environments/:id/channel`,
 * and requests under its `/env/<key>/` path are forwarded over that socket, prefix stripped.
 * Channels live in this process, so a relay serving them must run as a single replica.
 */
export const makeRelayChannels = () => {
  const channels = new Map<string, Channel>();
  let nextId = 0;

  const dispatch = (channel: Channel, chunk: string | Uint8Array) => {
    const frame = Option.getOrNull(parseFrame(chunk));
    if (frame?.type === "ping") return channel.send({ type: "ping" });
    if (frame?.type === "http-response") {
      const response = channel.responses.get(frame.id);
      return response ? Deferred.succeed(response, frame).pipe(Effect.asVoid) : Effect.void;
    }
    if (frame?.type === "ws-opened" || frame?.type === "ws-message" || frame?.type === "ws-close") {
      const inbox = channel.sockets.get(frame.id);
      return inbox ? Queue.offer(inbox, frame).pipe(Effect.asVoid) : Effect.void;
    }
    return Effect.void;
  };

  const serveChannel = Effect.fn("RelayChannels.serveChannel")(function* (
    principal: EnvironmentCredentials.EnvironmentCredentialPrincipal,
    token: string,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const { environmentId } = principal;
    const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
    const key = yield* channelKey(environmentId, principal.environmentPublicKey);
    const socket = yield* request.upgrade;
    const writer = yield* socket.writer;
    const reader = yield* socket.reader;
    const socketEnded = yield* Deferred.make<void>();
    const channel: Channel = {
      // Once the socket closes, a write waits for it to reopen, which never happens.
      send: (frame) =>
        writer
          .write(JSON.stringify(frame))
          .pipe(Effect.raceFirst(Deferred.await(socketEnded)), Effect.ignore),
      responses: new Map(),
      sockets: new Map(),
      replaced: yield* Deferred.make<void>(),
      ended: socketEnded,
      quietChecks: 0,
    };
    const previous = channels.get(key);
    channels.set(key, channel);
    // The environment reconnected, so the old connection is dead even if its socket looks open.
    if (previous !== undefined) yield* Deferred.succeed(previous.replaced, undefined);
    yield* Effect.logInfo("Relay channel connected", { environmentId });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (channels.get(key) === channel) channels.delete(key);
        // Pending requests answer 502, and sends stop waiting on the closed socket.
        yield* Deferred.succeed(socketEnded, undefined);
        for (const [id, inbox] of channel.sockets) {
          yield* Queue.offer(inbox, { type: "ws-close", id, code: 1012 });
        }
        yield* Effect.logInfo("Relay channel disconnected", { environmentId });
      }),
    );
    const readFrames = reader.pull.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          channel.quietChecks = 0;
        }),
      ),
      Effect.flatMap((chunks) =>
        Effect.forEach(chunks, (chunk) => dispatch(channel, chunk), { discard: true }),
      ),
      Effect.forever,
    );
    // Revocation and silence end the channel on the relay's own clock, whatever the environment
    // sends. A failed lookup keeps the channel: a database hiccup should not drop every environment.
    const recheck = Effect.suspend(() => {
      channel.quietChecks += 1;
      if (channel.quietChecks > MAX_QUIET_CHECKS) return Effect.succeed(false);
      return credentials.authenticate(token).pipe(
        Effect.map((current) =>
          Option.exists(current, (now) => now.credentialId === principal.credentialId),
        ),
        Effect.orElseSucceed(() => true),
      );
    });
    const ended = yield* Effect.sleep(CREDENTIAL_RECHECK_INTERVAL).pipe(
      Effect.andThen(recheck),
      Effect.repeat({ while: (stillValid) => stillValid }),
      Effect.forkScoped({ startImmediately: true }),
    );
    // Tells the environment its channel now receives traffic.
    yield* channel.send({ type: "ping" });
    yield* Effect.raceFirst(
      readFrames,
      Effect.raceFirst(Fiber.join(ended), Deferred.await(channel.replaced)),
    ).pipe(Effect.ignore);
    return HttpServerResponse.empty();
  }, Effect.scoped);

  const forwardHttp = Effect.fn("RelayChannels.forwardHttp")(function* (
    channel: Channel,
    request: HttpServerRequest.HttpServerRequest,
    target: ChannelTarget,
  ) {
    const body = yield* request.arrayBuffer.pipe(
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        ByteSize.bytes(RELAY_CHANNEL_MAX_BODY_BYTES),
      ),
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.option,
    );
    if (Option.isNone(body)) {
      return HttpServerResponse.text("The request body is too large for the relay.", {
        status: 413,
      });
    }
    const id = ++nextId;
    const response = yield* Deferred.make<HttpResponseFrame>();
    channel.responses.set(id, response);
    const channelEnded = Deferred.await(channel.ended).pipe(
      Effect.as<HttpResponseFrame>({ type: "http-response", id, status: 502, headers: {} }),
    );
    const result = yield* channel
      .send({
        type: "http-request",
        id,
        method: request.method,
        path: target.path,
        headers: forwardedHeaders(request, target),
        ...(body.value.byteLength > 0 ? { body: Buffer.from(body.value).toString("base64") } : {}),
      })
      .pipe(
        Effect.andThen(Effect.raceFirst(Deferred.await(response), channelEnded)),
        Effect.timeoutOption(RELAY_CHANNEL_RESPONSE_TIMEOUT_MS),
        Effect.ensuring(Effect.sync(() => channel.responses.delete(id))),
      );
    if (Option.isNone(result)) {
      return HttpServerResponse.text("The environment did not answer in time.", { status: 504 });
    }
    const { "content-type": contentType, ...forwarded } = allowedResponseHeaders(
      result.value.headers,
    );
    // Every carried environment shares the relay's origin, and anyone can link one: its responses
    // may not run script with that origin or set cookies the relay and other environments would
    // see. PDFs stay sandboxed too, so a browser shows them only as downloads, not inline.
    const headers: Record<string, string> = {
      ...forwarded,
      "content-security-policy": CARRIED_CONTENT_SECURITY_POLICY,
      "x-content-type-options": "nosniff",
    };
    // A root-relative redirect from the environment stays under its prefix.
    if (headers.location?.startsWith("/") && !headers.location.startsWith("//")) {
      headers.location = `${target.prefix}${headers.location}`;
    }
    return HttpServerResponse.uint8Array(
      result.value.body ? Buffer.from(result.value.body, "base64") : new Uint8Array(),
      { status: result.value.status, headers, ...(contentType ? { contentType } : {}) },
    );
  });

  const forwardWebSocket = Effect.fn("RelayChannels.forwardWebSocket")(function* (
    channel: Channel,
    request: HttpServerRequest.HttpServerRequest,
    target: ChannelTarget,
  ) {
    const id = ++nextId;
    const inbox = yield* Queue.unbounded<SocketFrame>();
    channel.sockets.set(id, inbox);
    // However this ends, even when the client vanishes mid-handshake, the environment closes its
    // side: its local socket would otherwise stay open, sending into an inbox nobody reads.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => channel.sockets.delete(id)).pipe(
        Effect.andThen(channel.send({ type: "ws-close", id })),
      ),
    );
    yield* channel.send({
      type: "ws-open",
      id,
      path: target.path,
      headers: forwardedHeaders(request, target),
    });
    const opened = yield* Queue.take(inbox).pipe(Effect.timeoutOption("15 seconds"));
    if (Option.isNone(opened) || opened.value.type !== "ws-opened") {
      return HttpServerResponse.text("The environment refused the WebSocket.", { status: 502 });
    }
    const socket = yield* request.upgrade;
    const writer = yield* socket.writer;
    const reader = yield* socket.reader;
    const toClient = Queue.take(inbox).pipe(
      Effect.flatMap((frame) =>
        frame.type === "ws-message"
          ? writer.write(frame.binary ? Buffer.from(frame.data, "base64") : frame.data)
          : frame.type === "ws-close"
            ? writer
                .write(new Socket.CloseEvent(sendableCloseCode(frame.code), frame.reason))
                .pipe(Effect.andThen(Effect.fail("closed" as const)))
            : Effect.void,
      ),
      Effect.forever,
    );
    const toEnvironment = reader.pull.pipe(
      Effect.flatMap((chunks) =>
        Effect.forEach(
          chunks,
          (chunk) =>
            channel.send(
              typeof chunk === "string"
                ? { type: "ws-message", id, data: chunk }
                : {
                    type: "ws-message",
                    id,
                    data: Buffer.from(chunk).toString("base64"),
                    binary: true,
                  },
            ),
          { discard: true },
        ),
      ),
      Effect.forever,
    );
    yield* Effect.raceFirst(toClient, toEnvironment).pipe(Effect.ignore);
    return HttpServerResponse.empty();
  }, Effect.scoped);

  const authenticateChannel = Effect.fn("RelayChannels.authenticateChannel")(function* (
    request: HttpServerRequest.HttpServerRequest,
    pathId: string,
  ) {
    const token = /^Bearer +(.+)$/iu.exec(request.headers.authorization ?? "")?.[1];
    if (token === undefined) return null;
    const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
    const principal = yield* credentials
      .authenticate(token)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.isSome(principal) && principal.value.environmentId === decodeURIComponent(pathId)
      ? { principal: principal.value, token }
      : null;
  });

  return <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const channelPath = CHANNEL_SOCKET_PATH.exec(request.url);
      if (channelPath?.[1] !== undefined && isWebSocketUpgrade(request)) {
        const authorized = yield* authenticateChannel(request, channelPath[1]);
        if (authorized === null) return HttpServerResponse.empty({ status: 401 });
        return yield* serveChannel(authorized.principal, authorized.token, request).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 })),
        );
      }
      const target = channelPathTarget(request.url);
      if (target === null) return yield* handler;
      const channel = channels.get(target.key);
      if (channel === undefined) {
        return HttpServerResponse.text("This environment is not connected to the relay.", {
          status: 502,
        });
      }
      return yield* (
        isWebSocketUpgrade(request)
          ? forwardWebSocket(channel, request, target)
          : forwardHttp(channel, request, target)
      ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 })));
    });
};
