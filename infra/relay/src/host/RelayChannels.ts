import { RelayChannelFrame } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import { channelKey, channelKeyForHost } from "../environments/RelayChannelEndpoint.ts";

type HttpResponseFrame = Extract<RelayChannelFrame, { readonly type: "http-response" }>;
type SocketFrame = Extract<
  RelayChannelFrame,
  { readonly type: "ws-opened" | "ws-message" | "ws-close" }
>;

interface Channel {
  readonly send: (frame: RelayChannelFrame) => Effect.Effect<void>;
  readonly responses: Map<number, Deferred.Deferred<HttpResponseFrame>>;
  readonly sockets: Map<number, Queue.Queue<SocketFrame>>;
}

const CHANNEL_PATH = /^\/v1\/environments\/([^/?]+)\/channel(?:\?.*)?$/u;
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

function withoutHopByHop(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
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

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

/**
 * Carries environments with no public address: each one dials `/v1/environments/:id/channel`,
 * and requests to its channel host (`RELAY_CHANNEL_HOST`) are forwarded over that socket.
 * Channels live in this process, so a relay serving them must run as a single replica.
 */
export const withRelayChannels = (channelHost: string) => {
  const channels = new Map<string, Channel>();
  let nextId = 0;

  const dispatch = (channel: Channel, chunk: string | Uint8Array) => {
    const frame = Option.getOrNull(parseFrame(chunk));
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
    const channel: Channel = {
      send: (frame) => writer.write(JSON.stringify(frame)).pipe(Effect.ignore),
      responses: new Map(),
      sockets: new Map(),
    };
    channels.set(key, channel);
    // Tells the environment its channel now receives traffic.
    yield* channel.send({ type: "ping" });
    yield* Effect.logInfo("Relay channel connected", { environmentId });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (channels.get(key) === channel) channels.delete(key);
        for (const [id, response] of channel.responses) {
          yield* Deferred.succeed(response, {
            type: "http-response",
            id,
            status: 502,
            headers: {},
          });
        }
        for (const [id, inbox] of channel.sockets) {
          yield* Queue.offer(inbox, { type: "ws-close", id, code: 1012 });
        }
        yield* Effect.logInfo("Relay channel disconnected", { environmentId });
      }),
    );
    // The environment pings every 25 seconds; a revoked credential closes its channel.
    const stillAuthorized = credentials.authenticate(token).pipe(
      Effect.map((current) =>
        Option.exists(current, (now) => now.credentialId === principal.credentialId),
      ),
      Effect.orElseSucceed(() => true),
    );
    yield* reader.pull.pipe(
      Effect.flatMap((chunks) =>
        Effect.forEach(
          chunks,
          (chunk) =>
            Option.getOrNull(parseFrame(chunk))?.type === "ping"
              ? stillAuthorized.pipe(
                  Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail("revoked" as const))),
                )
              : dispatch(channel, chunk),
          { discard: true },
        ),
      ),
      Effect.forever,
      Effect.ignore,
    );
    return HttpServerResponse.empty();
  }, Effect.scoped);

  const forwardHttp = Effect.fn("RelayChannels.forwardHttp")(function* (
    channel: Channel,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const id = ++nextId;
    const body = new Uint8Array(yield* request.arrayBuffer);
    const response = yield* Deferred.make<HttpResponseFrame>();
    channel.responses.set(id, response);
    yield* channel.send({
      type: "http-request",
      id,
      method: request.method,
      path: request.url,
      headers: withoutHopByHop(request.headers),
      ...(body.byteLength > 0 ? { body: Buffer.from(body).toString("base64") } : {}),
    });
    const result = yield* Deferred.await(response).pipe(
      Effect.timeoutOption("60 seconds"),
      Effect.ensuring(Effect.sync(() => channel.responses.delete(id))),
    );
    if (Option.isNone(result)) {
      return HttpServerResponse.text("The environment did not answer in time.", { status: 504 });
    }
    const { "content-type": contentType, ...headers } = withoutHopByHop(result.value.headers);
    return HttpServerResponse.uint8Array(
      result.value.body ? Buffer.from(result.value.body, "base64") : new Uint8Array(),
      { status: result.value.status, headers, ...(contentType ? { contentType } : {}) },
    );
  });

  const forwardWebSocket = Effect.fn("RelayChannels.forwardWebSocket")(function* (
    channel: Channel,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const id = ++nextId;
    const inbox = yield* Queue.unbounded<SocketFrame>();
    channel.sockets.set(id, inbox);
    yield* Effect.addFinalizer(() => Effect.sync(() => channel.sockets.delete(id)));
    yield* channel.send({
      type: "ws-open",
      id,
      path: request.url,
      headers: withoutHopByHop(request.headers),
    });
    const opened = yield* Queue.take(inbox).pipe(Effect.timeoutOption("15 seconds"));
    if (Option.isNone(opened) || opened.value.type !== "ws-opened") {
      yield* channel.send({ type: "ws-close", id });
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
    yield* channel.send({ type: "ws-close", id });
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
      const channelPath = CHANNEL_PATH.exec(request.url);
      if (channelPath?.[1] !== undefined && isWebSocketUpgrade(request)) {
        const authorized = yield* authenticateChannel(request, channelPath[1]);
        if (authorized === null) return HttpServerResponse.empty({ status: 401 });
        return yield* serveChannel(authorized.principal, authorized.token, request).pipe(
          Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 })),
        );
      }
      const key = channelKeyForHost(channelHost, request.headers.host ?? "");
      if (key === null) return yield* handler;
      const channel = channels.get(key);
      if (channel === undefined) {
        return HttpServerResponse.text("This environment is not connected to the relay.", {
          status: 502,
        });
      }
      return yield* (
        isWebSocketUpgrade(request)
          ? forwardWebSocket(channel, request)
          : forwardHttp(channel, request)
      ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 })));
    });
};
