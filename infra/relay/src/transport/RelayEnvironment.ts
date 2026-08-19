// @effect-diagnostics returnEffectInGen:off -- Alchemy Durable Objects use a documented two-phase nested Effect initializer.
import * as Cloudflare from "alchemy/Cloudflare";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  decodeRelayTransportControlFrame,
  decodeRelayTransportFrame,
  encodeRelayTransportControlFrame,
  encodeRelayTransportFrame,
  encodeRelayTransportMessageFrames,
  normalizeRelayWebSocketCloseCode,
  RELAY_CONNECTOR_TICKET_TTL_MILLIS,
  RELAY_TRANSPORT_INITIAL_WINDOW_BYTES,
  RELAY_TRANSPORT_MAX_CONCURRENT_STREAMS,
  RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES,
  RELAY_TRANSPORT_MAX_HTTP_REQUEST_BYTES,
  RELAY_TRANSPORT_PROTOCOL_VERSION,
  RelayTransportFrameKind,
  RelayTransportMessageAssembler,
} from "@t3tools/contracts/relayTransport";
import {
  connectorLeaseCanBeRevoked,
  connectorSessionIsCurrent,
  type ConnectorSessionIdentity,
} from "./connectorLease.ts";
import {
  connectorTicketDisposition,
  constantTimeStringEqual,
  type ConnectorTicketRecord,
} from "./connectorTicket.ts";
import { relayPublicRequestUrl } from "./publicRequestUrl.ts";
import {
  relayHttpResponseBodyStream,
  type RelayHttpResponseBodyEvent,
} from "./httpResponseBody.ts";

type SocketAttachment =
  | ({ readonly role: "connector" } & ConnectorSessionIdentity)
  | { readonly role: "client"; readonly streamId: number };

interface PendingHttpResponse {
  readonly metadata: Deferred.Deferred<{
    readonly status: number;
    readonly headers: ReadonlyArray<readonly [string, string]>;
  } | null>;
  readonly body: Queue.Queue<RelayHttpResponseBodyEvent>;
  readonly connector: Cloudflare.WebSocket;
  completed: boolean;
}

const CONNECTOR_TOKEN_HEADER = "x-t3-relay-connector-token";
const CONNECTOR_TICKET_HEADER = "x-t3-relay-connector-ticket";
const CONNECTION_ROLE_HEADER = "x-t3-relay-connection-role";
const PUBLIC_URL_HEADER = "x-t3-relay-public-url";
// Managed relay endpoints currently carry T3 RPC clients only, so their fixed
// heartbeat can stay at the edge instead of waking the object and host.
const EFFECT_RPC_PING = '{"_tag":"Ping"}';
const EFFECT_RPC_PONG = '{"_tag":"Pong"}';

interface StoredConnectorConfiguration {
  readonly token: string;
  readonly leaseId: string;
}

export interface RelayEnvironmentDiagnostics {
  readonly activationId: string;
  readonly connectorConnected: boolean;
  readonly clientCount: number;
  readonly pendingHttpCount: number;
}

const webcryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

function tryOrUndefined<A>(operation: () => A): A | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

export default class RelayEnvironment extends Cloudflare.DurableObject<RelayEnvironment>()(
  "RelayEnvironments",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const crypto = yield* Crypto.Crypto;

    return Effect.gen(function* () {
      yield* state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(EFFECT_RPC_PING, EFFECT_RPC_PONG),
      );
      const activationId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const clients = new Map<number, Cloudflare.WebSocket>();
      // Active HTTP requests keep a Durable Object invocation alive, so only
      // WebSocket identities need durable restoration across hibernation.
      const pendingHttp = new Map<number, PendingHttpResponse>();
      const connectorMessages = new RelayTransportMessageAssembler();
      let connector: Cloudflare.WebSocket | null = null;
      let nextStreamId = 1;

      const isActiveConnector = (socket: Cloudflare.WebSocket): boolean => {
        if (connector === null) return false;
        const active = connector.deserializeAttachment<SocketAttachment>();
        const presented = socket.deserializeAttachment<SocketAttachment>();
        return (
          active?.role === "connector" &&
          presented?.role === "connector" &&
          connectorSessionIsCurrent(active.leaseId, active, presented)
        );
      };

      const allocateStreamId = () => {
        const firstCandidate = nextStreamId;
        do {
          const streamId = nextStreamId;
          nextStreamId = nextStreamId === 0xffff_ffff ? 1 : nextStreamId + 1;
          if (!clients.has(streamId) && !pendingHttp.has(streamId)) return streamId;
        } while (nextStreamId !== firstCandidate);
        throw new Error("Relay transport has exhausted its stream identifiers.");
      };

      const closeClient = (streamId: number, code: number, reason: string) =>
        Effect.gen(function* () {
          const client = clients.get(streamId);
          clients.delete(streamId);
          connectorMessages.delete(streamId);
          if (client !== undefined) {
            yield* client.close(code, reason);
          }
        });

      const failConnectorStreams = (reason: string) =>
        Effect.gen(function* () {
          for (const streamId of clients.keys()) {
            yield* closeClient(streamId, 1013, reason);
          }
          for (const pending of pendingHttp.values()) {
            pending.completed = true;
            yield* Deferred.succeed(pending.metadata, null);
            yield* Queue.offer(pending.body, { type: "abort", reason });
          }
        });

      const disconnectConnector = (code: number, reason: string) =>
        Effect.gen(function* () {
          const activeConnector = connector;
          connector = null;
          if (activeConnector !== null) {
            yield* activeConnector.close(code, reason);
          }
          yield* failConnectorStreams(reason);
        });

      const restoredConfiguration =
        yield* state.storage.get<StoredConnectorConfiguration>("connectorConfiguration");
      const restoredActiveSession =
        yield* state.storage.get<ConnectorSessionIdentity>("activeConnectorSession");
      const staleConnectors: Array<Cloudflare.WebSocket> = [];
      let highestRestoredStreamId = 0;
      for (const socket of yield* state.getWebSockets()) {
        const attachment = socket.deserializeAttachment<SocketAttachment>();
        if (attachment?.role === "connector") {
          if (
            connector === null &&
            connectorSessionIsCurrent(
              restoredConfiguration?.leaseId,
              restoredActiveSession,
              attachment,
            )
          ) {
            connector = socket;
          } else {
            staleConnectors.push(socket);
          }
        } else if (attachment?.role === "client") {
          clients.set(attachment.streamId, socket);
          highestRestoredStreamId = Math.max(highestRestoredStreamId, attachment.streamId);
        }
      }
      nextStreamId = highestRestoredStreamId === 0xffff_ffff ? 1 : highestRestoredStreamId + 1;
      for (const stale of staleConnectors) {
        yield* stale.close(4000, "Superseded connector session");
      }
      if (connector === null) {
        if (restoredActiveSession !== undefined) {
          yield* state.storage.delete("activeConnectorSession");
        }
        if (clients.size > 0) {
          yield* failConnectorStreams("Environment connector session was not restored");
        }
      }

      return {
        diagnostics: () =>
          Effect.sync(
            (): RelayEnvironmentDiagnostics => ({
              activationId,
              connectorConnected: connector !== null,
              clientCount: clients.size,
              pendingHttpCount: pendingHttp.size,
            }),
          ),
        setConnectorConfiguration: (token: string, leaseId: string) =>
          Effect.gen(function* () {
            const previous =
              yield* state.storage.get<StoredConnectorConfiguration>("connectorConfiguration");
            yield* state.storage.put("connectorConfiguration", { token, leaseId });
            yield* state.storage.delete("connectorTicket");
            if (previous?.leaseId !== leaseId) {
              yield* state.storage.delete("activeConnectorSession");
              if (connector !== null) {
                yield* disconnectConnector(4000, "Connector lease superseded");
              }
            }
          }),
        revokeConnector: (expectedLeaseId?: string) =>
          Effect.gen(function* () {
            const configuration =
              yield* state.storage.get<StoredConnectorConfiguration>("connectorConfiguration");
            if (!connectorLeaseCanBeRevoked(configuration?.leaseId, expectedLeaseId)) {
              return false;
            }
            yield* state.storage.delete("connectorConfiguration");
            yield* state.storage.delete("connectorTicket");
            yield* state.storage.delete("activeConnectorSession");
            if (connector !== null) {
              yield* disconnectConnector(4001, "Connector revoked");
            }
            return true;
          }),
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const forwardedUrl = request.headers[PUBLIC_URL_HEADER];
          const publicRequestUrl = relayPublicRequestUrl({
            url: request.url,
            source: request.source,
            ...(forwardedUrl === undefined ? {} : { forwardedUrl }),
          });
          const role = request.headers[CONNECTION_ROLE_HEADER];
          let connectingSession: ConnectorSessionIdentity | null = null;
          if (
            role !== "connector_ticket" &&
            role !== "connector" &&
            role !== "client" &&
            role !== "http"
          ) {
            return HttpServerResponse.text("Unknown relay connection role", { status: 400 });
          }

          if (role === "connector_ticket") {
            const configuration =
              yield* state.storage.get<StoredConnectorConfiguration>("connectorConfiguration");
            const presentedToken = request.headers[CONNECTOR_TOKEN_HEADER];
            if (
              configuration === undefined ||
              presentedToken === undefined ||
              !constantTimeStringEqual(configuration.token, presentedToken)
            ) {
              return HttpServerResponse.text("Invalid connector token", { status: 401 });
            }
            const ticket = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
            const now = yield* DateTime.now;
            const expiresAt = DateTime.add(now, {
              milliseconds: RELAY_CONNECTOR_TICKET_TTL_MILLIS,
            });
            const expiresAtEpochMillis = expiresAt.epochMilliseconds;
            yield* state.storage.put("connectorTicket", {
              ticket,
              expiresAtEpochMillis,
            } satisfies ConnectorTicketRecord);
            return HttpServerResponse.json(
              { ticket, expiresAt: DateTime.formatIso(expiresAt) },
              {
                status: 201,
                headers: { "cache-control": "no-store" },
              },
            );
          }

          if (role === "connector") {
            const storedTicket = yield* state.storage.get<ConnectorTicketRecord>("connectorTicket");
            const presentedTicket = request.headers[CONNECTOR_TICKET_HEADER];
            const disposition = connectorTicketDisposition({
              stored: storedTicket,
              presented: presentedTicket,
              nowEpochMillis: (yield* DateTime.now).epochMilliseconds,
            });
            if (disposition === "invalid") {
              return HttpServerResponse.text("Invalid connector ticket", { status: 401 });
            }
            if (disposition === "expired") {
              yield* state.storage.delete("connectorTicket");
              return HttpServerResponse.text("Invalid connector ticket", { status: 401 });
            }
            yield* state.storage.delete("connectorTicket");
            const configuration =
              yield* state.storage.get<StoredConnectorConfiguration>("connectorConfiguration");
            if (configuration === undefined || presentedTicket === undefined) {
              return HttpServerResponse.text("Connector configuration is unavailable", {
                status: 401,
              });
            }
            connectingSession = {
              leaseId: configuration.leaseId,
              sessionId: presentedTicket,
            };
          } else if (connector === null) {
            return HttpServerResponse.text("Environment connector is offline", { status: 503 });
          }

          if (
            role !== "connector" &&
            clients.size + pendingHttp.size >= RELAY_TRANSPORT_MAX_CONCURRENT_STREAMS
          ) {
            return HttpServerResponse.text("Environment relay is at stream capacity", {
              status: 503,
            });
          }

          if (role === "http") {
            const contentLength = Number(request.headers["content-length"]);
            if (
              Number.isFinite(contentLength) &&
              contentLength > RELAY_TRANSPORT_MAX_HTTP_REQUEST_BYTES
            ) {
              return HttpServerResponse.text("HTTP request body exceeds the relay limit", {
                status: 413,
              });
            }
            const streamId = allocateStreamId();
            const requestConnector = connector!;
            const requestStartFrame = tryOrUndefined(() =>
              encodeRelayTransportControlFrame(streamId, {
                type: "http_request_start",
                method: request.method,
                url: publicRequestUrl,
                headers: Object.entries(request.headers).filter(
                  ([name]) => name !== PUBLIC_URL_HEADER,
                ),
              }),
            );
            if (requestStartFrame === undefined) {
              return HttpServerResponse.text("HTTP request metadata exceeds the relay limit", {
                status: 431,
              });
            }
            const metadata = yield* Deferred.make<{
              readonly status: number;
              readonly headers: ReadonlyArray<readonly [string, string]>;
            } | null>();
            const body = yield* Queue.unbounded<RelayHttpResponseBodyEvent>();
            const pending = {
              metadata,
              body,
              connector: requestConnector,
              completed: false,
            } satisfies PendingHttpResponse;
            pendingHttp.set(streamId, pending);
            yield* requestConnector
              .send(requestStartFrame)
              .pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? Effect.sync(() => pendingHttp.delete(streamId))
                    : Effect.void,
                ),
              );
            let requestBodyBytes = 0;
            let oversized = false;
            if (request.method !== "GET" && request.method !== "HEAD") {
              const streamed = yield* request.stream.pipe(
                Stream.runForEach((chunk) =>
                  Effect.gen(function* () {
                    if (oversized) return;
                    requestBodyBytes += chunk.byteLength;
                    if (requestBodyBytes > RELAY_TRANSPORT_MAX_HTTP_REQUEST_BYTES) {
                      oversized = true;
                      yield* requestConnector.send(
                        encodeRelayTransportControlFrame(streamId, {
                          type: "http_request_abort",
                          reason: "HTTP request body exceeds the relay limit",
                        }),
                      );
                      return;
                    }
                    for (
                      let offset = 0;
                      offset < chunk.byteLength;
                      offset += RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES
                    ) {
                      yield* requestConnector.send(
                        encodeRelayTransportFrame({
                          kind: RelayTransportFrameKind.httpRequestBody,
                          streamId,
                          endOfMessage: false,
                          payload: chunk.subarray(
                            offset,
                            offset + RELAY_TRANSPORT_MAX_FRAME_PAYLOAD_BYTES,
                          ),
                        }),
                      );
                    }
                  }),
                ),
                Effect.result,
              );
              if (oversized) {
                pendingHttp.delete(streamId);
                return HttpServerResponse.text("HTTP request body exceeds the relay limit", {
                  status: 413,
                });
              }
              if (Result.isFailure(streamed)) {
                pendingHttp.delete(streamId);
                yield* requestConnector.send(
                  encodeRelayTransportControlFrame(streamId, {
                    type: "http_request_abort",
                    reason: "Public HTTP request body failed",
                  }),
                );
                return HttpServerResponse.text("Public HTTP request body failed", { status: 400 });
              }
            }
            yield* requestConnector.send(
              encodeRelayTransportControlFrame(streamId, { type: "http_request_end" }),
            );
            const responseOption = yield* Deferred.await(metadata).pipe(
              Effect.timeoutOption("30 seconds"),
            );
            if (Option.isNone(responseOption)) {
              pendingHttp.delete(streamId);
              if (isActiveConnector(requestConnector)) {
                yield* requestConnector.send(
                  encodeRelayTransportControlFrame(streamId, {
                    type: "http_request_abort",
                    reason: "Environment response timed out",
                  }),
                );
              }
              return HttpServerResponse.text("Environment response timed out", { status: 504 });
            }
            const response = responseOption.value;
            if (response === null) {
              pendingHttp.delete(streamId);
              return HttpServerResponse.text("Environment request failed", { status: 502 });
            }
            const responseStream = relayHttpResponseBodyStream(body).pipe(
              Stream.tap((chunk) =>
                !isActiveConnector(pending.connector)
                  ? Effect.void
                  : pending.connector.send(
                      encodeRelayTransportControlFrame(streamId, {
                        type: "window_update",
                        creditBytes: chunk.byteLength,
                      }),
                    ),
              ),
              Stream.ensuring(
                Effect.gen(function* () {
                  pendingHttp.delete(streamId);
                  if (!pending.completed && isActiveConnector(pending.connector)) {
                    yield* pending.connector.send(
                      encodeRelayTransportControlFrame(streamId, {
                        type: "http_request_abort",
                        reason: "Public HTTP request disconnected",
                      }),
                    );
                  }
                }),
              ),
            );
            return HttpServerResponse.stream(responseStream, {
              status: response.status,
              headers: response.headers,
            });
          }

          const publicWebSocket =
            role === "connector"
              ? null
              : (() => {
                  const streamId = allocateStreamId();
                  const openFrame = tryOrUndefined(() =>
                    encodeRelayTransportControlFrame(streamId, {
                      type: "websocket_open",
                      url: publicRequestUrl,
                      headers: Object.entries(request.headers).filter(
                        ([name]) => name !== PUBLIC_URL_HEADER,
                      ),
                      protocols: [],
                    }),
                  );
                  return openFrame === undefined ? null : { streamId, openFrame };
                })();
          if (role !== "connector" && publicWebSocket === null) {
            return HttpServerResponse.text("WebSocket metadata exceeds the relay limit", {
              status: 431,
            });
          }
          const [response, socket] = yield* Cloudflare.upgrade();
          if (role === "connector") {
            if (connector !== null) {
              yield* disconnectConnector(4000, "Superseded by a newer connector");
            }
            yield* state.storage.put("activeConnectorSession", connectingSession!);
            socket.serializeAttachment({
              role: "connector",
              ...connectingSession!,
            } satisfies SocketAttachment);
            connector = socket;
            yield* socket.send(
              encodeRelayTransportControlFrame(0, {
                type: "connector_ready",
                protocolVersion: RELAY_TRANSPORT_PROTOCOL_VERSION,
              }),
            );
          } else {
            const { streamId, openFrame } = publicWebSocket!;
            socket.serializeAttachment({ role: "client", streamId } satisfies SocketAttachment);
            clients.set(streamId, socket);
            yield* connector!.send(openFrame);
          }
          return response;
        }),
        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) {
          const attachment = socket.deserializeAttachment<SocketAttachment>();
          if (attachment?.role === "client") {
            if (connector === null) {
              return yield* closeClient(
                attachment.streamId,
                1013,
                "Environment connector is offline",
              );
            }
            const binary = typeof message !== "string";
            const payload = binary ? new Uint8Array(message) : new TextEncoder().encode(message);
            const frames = tryOrUndefined(() =>
              encodeRelayTransportMessageFrames({
                kind: binary
                  ? RelayTransportFrameKind.websocketBinary
                  : RelayTransportFrameKind.websocketText,
                streamId: attachment.streamId,
                payload,
              }),
            );
            if (frames === undefined) {
              return yield* closeClient(
                attachment.streamId,
                1009,
                "WebSocket message exceeds the relay limit",
              );
            }
            for (const frame of frames) yield* connector.send(frame);
            return;
          }
          if (
            attachment?.role !== "connector" ||
            !isActiveConnector(socket) ||
            typeof message === "string"
          ) {
            return;
          }
          // Hibernation events may carry a fresh JavaScript handle for the
          // same persisted WebSocket. Keep sends pinned to the current handle.
          connector = socket;

          const decoded = decodeRelayTransportFrame(message);
          if (Result.isFailure(decoded) || decoded.success.streamId === 0) {
            return;
          }
          const frame = decoded.success;
          const client = clients.get(frame.streamId);
          const http = pendingHttp.get(frame.streamId);
          if (frame.kind === RelayTransportFrameKind.httpResponseBody && http !== undefined) {
            yield* Queue.offer(http.body, { type: "chunk", bytes: frame.payload.slice() });
            return;
          }
          if (frame.kind === RelayTransportFrameKind.control && http !== undefined) {
            const control = decodeRelayTransportControlFrame(frame);
            if (Result.isSuccess(control)) {
              if (control.success.type === "http_response_start") {
                yield* Deferred.succeed(http.metadata, {
                  status: control.success.status,
                  headers: control.success.headers,
                });
                yield* socket.send(
                  encodeRelayTransportControlFrame(frame.streamId, {
                    type: "window_update",
                    creditBytes: RELAY_TRANSPORT_INITIAL_WINDOW_BYTES,
                  }),
                );
              } else if (control.success.type === "http_response_end") {
                http.completed = true;
                yield* Queue.offer(http.body, { type: "end" });
              } else if (control.success.type === "http_response_abort") {
                http.completed = true;
                yield* Deferred.succeed(http.metadata, null);
                yield* Queue.offer(http.body, {
                  type: "abort",
                  reason: control.success.reason,
                });
              }
            }
            return;
          }
          if (client === undefined) return;
          if (
            frame.kind === RelayTransportFrameKind.websocketText ||
            frame.kind === RelayTransportFrameKind.websocketBinary
          ) {
            const message = tryOrUndefined(() => connectorMessages.append(frame));
            if (message === undefined) {
              yield* closeClient(frame.streamId, 1009, "Invalid fragmented relay message");
            } else if (message !== null) {
              if (message.kind === RelayTransportFrameKind.websocketText) {
                yield* client.send(new TextDecoder().decode(message.payload));
              } else {
                yield* client.send(message.payload);
              }
            }
          } else if (frame.kind === RelayTransportFrameKind.control) {
            const control = decodeRelayTransportControlFrame(frame);
            if (Result.isSuccess(control) && control.success.type === "websocket_close") {
              yield* closeClient(frame.streamId, control.success.code, control.success.reason);
            } else if (Result.isSuccess(control) && control.success.type === "websocket_reject") {
              yield* closeClient(frame.streamId, 1011, control.success.reason);
            }
          }
        }),
        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string,
        ) {
          const attachment = socket.deserializeAttachment<SocketAttachment>();
          if (attachment?.role === "connector") {
            if (isActiveConnector(socket)) {
              connector = null;
              yield* state.storage.delete("activeConnectorSession");
              yield* failConnectorStreams("Environment connector disconnected");
            }
          } else if (attachment?.role === "client") {
            const wasActive = clients.delete(attachment.streamId);
            connectorMessages.delete(attachment.streamId);
            if (wasActive && connector !== null) {
              yield* connector.send(
                encodeRelayTransportControlFrame(attachment.streamId, {
                  type: "websocket_close",
                  code: normalizeRelayWebSocketCloseCode(code),
                  reason,
                }),
              );
            }
          }
          yield* socket.close(code, reason);
        }),
      };
    });
  }).pipe(Effect.provide(webcryptoLayer)),
) {}

export const relayConnectorTokenHeader = CONNECTOR_TOKEN_HEADER;
export const relayConnectorTicketHeader = CONNECTOR_TICKET_HEADER;
export const relayConnectionRoleHeader = CONNECTION_ROLE_HEADER;
export const relayPublicUrlHeader = PUBLIC_URL_HEADER;
