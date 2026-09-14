// @effect-diagnostics returnEffectInGen:off -- Alchemy Durable Objects use a documented two-phase nested Effect initializer.
import * as Cloudflare from "alchemy/Cloudflare";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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
  RELAY_TRANSPORT_MAX_OBJECT_CONNECTORS,
  RELAY_TRANSPORT_MAX_OBJECT_STREAMS,
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
  relayHttpResponseIdleWatchdog,
  type RelayHttpResponseBodyEvent,
} from "./httpResponseBody.ts";
import { isRelayRouteKey } from "./routing.ts";

// Every hibernatable socket names the endpoint it belongs to, so a wake-up
// can rebuild the per-endpoint tables from the attachments alone.
type SocketAttachment =
  | ({ readonly role: "connector"; readonly endpointKey: string } & ConnectorSessionIdentity)
  | { readonly role: "client"; readonly endpointKey: string; readonly streamId: number };

interface PendingHttpResponse {
  readonly metadata: Deferred.Deferred<{
    readonly status: number;
    readonly headers: ReadonlyArray<readonly [string, string]>;
  } | null>;
  readonly body: Queue.Queue<RelayHttpResponseBodyEvent>;
  readonly connector: Cloudflare.WebSocket;
  completed: boolean;
}

/**
 * In-memory state of one environment endpoint inside the hub. Stream ids are
 * scoped to the endpoint because every frame travels over that endpoint's
 * own connector socket.
 */
interface EndpointRuntime {
  readonly key: string;
  connector: Cloudflare.WebSocket | null;
  readonly clients: Map<number, Cloudflare.WebSocket>;
  // Active HTTP requests keep a Durable Object invocation alive, so only
  // WebSocket identities need durable restoration across hibernation.
  readonly pendingHttp: Map<number, PendingHttpResponse>;
  readonly connectorMessages: RelayTransportMessageAssembler;
  nextStreamId: number;
}

const CONNECTOR_TOKEN_HEADER = "x-t3-relay-connector-token";
const CONNECTOR_TICKET_HEADER = "x-t3-relay-connector-ticket";
const CONNECTION_ROLE_HEADER = "x-t3-relay-connection-role";
const ENDPOINT_KEY_HEADER = "x-t3-relay-endpoint-key";
const PUBLIC_URL_HEADER = "x-t3-relay-public-url";
const STORAGE_PREFIX = "endpoint:";
// Managed relay endpoints currently carry T3 RPC clients only, so their fixed
// heartbeat can stay at the edge instead of waking the object and host.
const EFFECT_RPC_PING = '{"_tag":"Ping"}';
const EFFECT_RPC_PONG = '{"_tag":"Pong"}';

interface StoredConnectorConfiguration {
  readonly token: string;
  readonly leaseId: string;
}

export interface RelayEndpointDiagnostics {
  readonly connectorConnected: boolean;
  readonly clientCount: number;
  readonly pendingHttpCount: number;
}

export interface RelayHubDiagnostics {
  readonly activationId: string;
  readonly configuredEndpointCount: number;
  readonly endpoints: Record<string, RelayEndpointDiagnostics>;
}

function storageKeys(endpointKey: string) {
  return {
    configuration: `${STORAGE_PREFIX}${endpointKey}:configuration`,
    ticket: `${STORAGE_PREFIX}${endpointKey}:ticket`,
    activeSession: `${STORAGE_PREFIX}${endpointKey}:activeSession`,
  } as const;
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

function responseStatusForbidsBody(status: number): boolean {
  return status < 200 || status === 204 || status === 205 || status === 304;
}

function tryOrUndefined<A>(operation: () => A): A | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

function forwardedHeaders(headers: Record<string, string>): Array<[string, string]> {
  return Object.entries(headers).filter(
    ([name]) => name !== PUBLIC_URL_HEADER && name !== ENDPOINT_KEY_HEADER,
  );
}

/**
 * One hibernating Durable Object per user (or per shard of users). It owns
 * every relay endpoint of its users: each endpoint has its own connector
 * credential, connector socket, and public client streams, isolated from the
 * others by the endpoint key the edge Worker resolves from the hostname.
 */
export default class RelayHub extends Cloudflare.DurableObject<RelayHub>()(
  "RelayHubs",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const crypto = yield* Crypto.Crypto;

    return Effect.gen(function* () {
      yield* state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(EFFECT_RPC_PING, EFFECT_RPC_PONG),
      );
      const activationId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const endpoints = new Map<string, EndpointRuntime>();

      const endpointRuntime = (endpointKey: string): EndpointRuntime => {
        const existing = endpoints.get(endpointKey);
        if (existing !== undefined) return existing;
        const created: EndpointRuntime = {
          key: endpointKey,
          connector: null,
          clients: new Map(),
          pendingHttp: new Map(),
          connectorMessages: new RelayTransportMessageAssembler(),
          nextStreamId: 1,
        };
        endpoints.set(endpointKey, created);
        return created;
      };

      // Drop the table for an endpoint once nothing references it, so an
      // object that serves many users does not retain every endpoint it has
      // ever seen. A late cleanup from a superseded table must not remove the
      // table a newer connector has since created under the same key.
      const pruneEndpoint = (endpoint: EndpointRuntime) => {
        if (
          endpoint.connector === null &&
          endpoint.clients.size === 0 &&
          endpoint.pendingHttp.size === 0 &&
          endpoints.get(endpoint.key) === endpoint
        ) {
          endpoints.delete(endpoint.key);
        }
      };

      const isActiveConnector = (
        endpoint: EndpointRuntime,
        socket: Cloudflare.WebSocket,
      ): boolean => {
        if (endpoint.connector === null) return false;
        const active = endpoint.connector.deserializeAttachment<SocketAttachment>();
        const presented = socket.deserializeAttachment<SocketAttachment>();
        return (
          active?.role === "connector" &&
          presented?.role === "connector" &&
          active.endpointKey === endpoint.key &&
          presented.endpointKey === endpoint.key &&
          connectorSessionIsCurrent(active.leaseId, active, presented)
        );
      };

      const allocateStreamId = (endpoint: EndpointRuntime) => {
        const firstCandidate = endpoint.nextStreamId;
        do {
          const streamId = endpoint.nextStreamId;
          endpoint.nextStreamId =
            endpoint.nextStreamId === 0xffff_ffff ? 1 : endpoint.nextStreamId + 1;
          if (!endpoint.clients.has(streamId) && !endpoint.pendingHttp.has(streamId)) {
            return streamId;
          }
        } while (endpoint.nextStreamId !== firstCandidate);
        throw new Error("Relay transport has exhausted its stream identifiers.");
      };

      const totalStreams = () => {
        let count = 0;
        for (const endpoint of endpoints.values()) {
          count += endpoint.clients.size + endpoint.pendingHttp.size;
        }
        return count;
      };

      const connectedConnectors = () => {
        let count = 0;
        for (const endpoint of endpoints.values()) {
          if (endpoint.connector !== null) count += 1;
        }
        return count;
      };

      const closeClient = (
        endpoint: EndpointRuntime,
        streamId: number,
        code: number,
        reason: string,
      ) =>
        Effect.gen(function* () {
          const client = endpoint.clients.get(streamId);
          endpoint.clients.delete(streamId);
          endpoint.connectorMessages.delete(streamId);
          if (client !== undefined) {
            yield* client.close(code, reason);
          }
          pruneEndpoint(endpoint);
        });

      const failConnectorStreams = (endpoint: EndpointRuntime, reason: string) =>
        Effect.gen(function* () {
          for (const streamId of endpoint.clients.keys()) {
            yield* closeClient(endpoint, streamId, 1013, reason);
          }
          for (const pending of endpoint.pendingHttp.values()) {
            pending.completed = true;
            yield* Deferred.succeed(pending.metadata, null);
            yield* Queue.offer(pending.body, { type: "abort", reason });
          }
          pruneEndpoint(endpoint);
        });

      const disconnectConnector = (endpoint: EndpointRuntime, code: number, reason: string) =>
        Effect.gen(function* () {
          const activeConnector = endpoint.connector;
          endpoint.connector = null;
          if (activeConnector !== null) {
            yield* activeConnector.close(code, reason);
          }
          yield* failConnectorStreams(endpoint, reason);
        });

      // Restore connector and client roles from the hibernated sockets. Only
      // the endpoints that still hold a connector socket need their stored
      // lease read, so a wake-up costs one batched read however many
      // endpoints the object has configured.
      const sockets = yield* state.getWebSockets();
      const attachments = sockets.map((socket) => ({
        socket,
        attachment: socket.deserializeAttachment<SocketAttachment>(),
      }));
      const restoreKeys = new Set<string>();
      for (const { attachment } of attachments) {
        if (attachment?.role === "connector") {
          const keys = storageKeys(attachment.endpointKey);
          restoreKeys.add(keys.configuration);
          restoreKeys.add(keys.activeSession);
        }
      }
      // Durable Object storage reads at most 128 keys per call.
      const stored = new Map<string, unknown>();
      const restoreKeyList = [...restoreKeys];
      for (let offset = 0; offset < restoreKeyList.length; offset += 128) {
        const batch = yield* state.storage.get<unknown>(restoreKeyList.slice(offset, offset + 128));
        for (const [key, value] of batch) stored.set(key, value);
      }
      const staleConnectors: Array<Cloudflare.WebSocket> = [];
      for (const { socket, attachment } of attachments) {
        if (attachment?.role === "connector") {
          const keys = storageKeys(attachment.endpointKey);
          const configuration = stored.get(keys.configuration) as
            | StoredConnectorConfiguration
            | undefined;
          const activeSession = stored.get(keys.activeSession) as
            | ConnectorSessionIdentity
            | undefined;
          const endpoint = endpointRuntime(attachment.endpointKey);
          if (
            endpoint.connector === null &&
            connectorSessionIsCurrent(configuration?.leaseId, activeSession, attachment)
          ) {
            endpoint.connector = socket;
          } else {
            staleConnectors.push(socket);
          }
        } else if (attachment?.role === "client") {
          const endpoint = endpointRuntime(attachment.endpointKey);
          endpoint.clients.set(attachment.streamId, socket);
          endpoint.nextStreamId = Math.max(endpoint.nextStreamId, attachment.streamId + 1);
        }
      }
      for (const stale of staleConnectors) {
        yield* stale.close(4000, "Superseded connector session");
      }
      for (const endpoint of endpoints.values()) {
        if (endpoint.nextStreamId > 0xffff_ffff) endpoint.nextStreamId = 1;
        if (endpoint.connector === null) {
          yield* state.storage.delete(storageKeys(endpoint.key).activeSession);
          yield* failConnectorStreams(endpoint, "Environment connector session was not restored");
        }
      }

      return {
        diagnostics: () =>
          Effect.gen(function* () {
            const configured = yield* state.storage.list({ prefix: STORAGE_PREFIX });
            let configuredEndpointCount = 0;
            for (const key of configured.keys()) {
              if (key.endsWith(":configuration")) configuredEndpointCount += 1;
            }
            const report: Record<string, RelayEndpointDiagnostics> = {};
            for (const endpoint of endpoints.values()) {
              report[endpoint.key] = {
                connectorConnected: endpoint.connector !== null,
                clientCount: endpoint.clients.size,
                pendingHttpCount: endpoint.pendingHttp.size,
              };
            }
            return {
              activationId,
              configuredEndpointCount,
              endpoints: report,
            } satisfies RelayHubDiagnostics;
          }),
        setConnectorConfiguration: (endpointKey: string, token: string, leaseId: string) =>
          Effect.gen(function* () {
            const keys = storageKeys(endpointKey);
            const previous = yield* state.storage.get<StoredConnectorConfiguration>(
              keys.configuration,
            );
            yield* state.storage.put(keys.configuration, { token, leaseId });
            yield* state.storage.delete(keys.ticket);
            if (previous?.leaseId !== leaseId) {
              yield* state.storage.delete(keys.activeSession);
              const endpoint = endpoints.get(endpointKey);
              if (endpoint?.connector) {
                yield* disconnectConnector(endpoint, 4000, "Connector lease superseded");
              }
            }
          }),
        revokeConnector: (endpointKey: string, expectedLeaseId?: string) =>
          Effect.gen(function* () {
            const keys = storageKeys(endpointKey);
            const configuration = yield* state.storage.get<StoredConnectorConfiguration>(
              keys.configuration,
            );
            if (!connectorLeaseCanBeRevoked(configuration?.leaseId, expectedLeaseId)) {
              return false;
            }
            yield* state.storage.delete([keys.configuration, keys.ticket, keys.activeSession]);
            const endpoint = endpoints.get(endpointKey);
            if (endpoint?.connector) {
              yield* disconnectConnector(endpoint, 4001, "Connector revoked");
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
          if (
            role !== "connector_ticket" &&
            role !== "connector" &&
            role !== "client" &&
            role !== "http"
          ) {
            return HttpServerResponse.text("Unknown relay connection role", { status: 400 });
          }
          const endpointKey = request.headers[ENDPOINT_KEY_HEADER];
          if (endpointKey === undefined || !isRelayRouteKey(endpointKey)) {
            return HttpServerResponse.text("Unknown relay endpoint", { status: 400 });
          }
          const keys = storageKeys(endpointKey);
          let connectingSession: ConnectorSessionIdentity | null = null;

          if (role === "connector_ticket") {
            const configuration = yield* state.storage.get<StoredConnectorConfiguration>(
              keys.configuration,
            );
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
            yield* state.storage.put(keys.ticket, {
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
            const storedTicket = yield* state.storage.get<ConnectorTicketRecord>(keys.ticket);
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
              yield* state.storage.delete(keys.ticket);
              return HttpServerResponse.text("Invalid connector ticket", { status: 401 });
            }
            // Refuse before consuming the ticket so a host that hits the cap
            // can retry the same ticket once capacity frees up.
            if (
              (endpoints.get(endpointKey)?.connector ?? null) === null &&
              connectedConnectors() >= RELAY_TRANSPORT_MAX_OBJECT_CONNECTORS
            ) {
              return HttpServerResponse.text("Relay object is at connector capacity", {
                status: 503,
              });
            }
            yield* state.storage.delete(keys.ticket);
            const configuration = yield* state.storage.get<StoredConnectorConfiguration>(
              keys.configuration,
            );
            if (configuration === undefined || presentedTicket === undefined) {
              return HttpServerResponse.text("Connector configuration is unavailable", {
                status: 401,
              });
            }
            connectingSession = {
              leaseId: configuration.leaseId,
              sessionId: presentedTicket,
            };
          }

          const endpoint = endpoints.get(endpointKey);
          if (role !== "connector") {
            if (endpoint?.connector == null) {
              return HttpServerResponse.text("Environment connector is offline", { status: 503 });
            }
            if (
              endpoint.clients.size + endpoint.pendingHttp.size >=
                RELAY_TRANSPORT_MAX_CONCURRENT_STREAMS ||
              totalStreams() >= RELAY_TRANSPORT_MAX_OBJECT_STREAMS
            ) {
              return HttpServerResponse.text("Environment relay is at stream capacity", {
                status: 503,
              });
            }
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
            const httpEndpoint = endpoint!;
            const streamId = allocateStreamId(httpEndpoint);
            const requestConnector = httpEndpoint.connector!;
            const requestStartFrame = tryOrUndefined(() =>
              encodeRelayTransportControlFrame(streamId, {
                type: "http_request_start",
                method: request.method,
                url: publicRequestUrl,
                headers: forwardedHeaders(request.headers),
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
            httpEndpoint.pendingHttp.set(streamId, pending);
            const releasePending = Effect.sync(() => {
              httpEndpoint.pendingHttp.delete(streamId);
              pruneEndpoint(httpEndpoint);
            });
            yield* requestConnector
              .send(requestStartFrame)
              .pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? releasePending : Effect.void)));
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
                yield* releasePending;
                return HttpServerResponse.text("HTTP request body exceeds the relay limit", {
                  status: 413,
                });
              }
              if (Result.isFailure(streamed)) {
                yield* releasePending;
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
              yield* releasePending;
              if (isActiveConnector(httpEndpoint, requestConnector)) {
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
              yield* releasePending;
              return HttpServerResponse.text("Environment request failed", { status: 502 });
            }
            // The body stream cannot see a client that stopped reading, so a
            // watchdog on its own fiber shuts the queue when no chunk has been
            // handed out for the idle window. The stream then fails on its next
            // pull, its ensuring cleanup runs, and the object can hibernate
            // instead of staying awake and billed for an abandoned download.
            const progress = { lastChunkAt: (yield* DateTime.now).epochMilliseconds };
            const idleWatchdog = yield* relayHttpResponseIdleWatchdog(progress).pipe(
              Effect.andThen(Queue.shutdown(body)),
              Effect.forkDetach,
            );
            const responseStream = relayHttpResponseBodyStream(body, progress).pipe(
              Stream.tap((chunk) =>
                !isActiveConnector(httpEndpoint, pending.connector)
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
                  yield* Fiber.interrupt(idleWatchdog);
                  yield* releasePending;
                  if (!pending.completed && isActiveConnector(httpEndpoint, pending.connector)) {
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
            // The Fetch API rejects a body on 1xx, 204, 205, and 304. The
            // host never sends body frames for those, so drain the queue
            // rather than handing the runtime a stream it cannot attach.
            if (responseStatusForbidsBody(response.status)) {
              // Bounded so a connector that never sends http_response_end
              // cannot pin this invocation; the timeout runs the stream's
              // ensuring cleanup, which aborts the request on the host.
              yield* Stream.runDrain(responseStream).pipe(Effect.timeoutOption("30 seconds"));
              return HttpServerResponse.empty({
                status: response.status,
                headers: response.headers,
              });
            }
            return HttpServerResponse.stream(responseStream, {
              status: response.status,
              headers: response.headers,
            });
          }

          const publicWebSocket =
            role === "connector"
              ? null
              : (() => {
                  const streamId = allocateStreamId(endpoint!);
                  const openFrame = tryOrUndefined(() =>
                    encodeRelayTransportControlFrame(streamId, {
                      type: "websocket_open",
                      url: publicRequestUrl,
                      headers: forwardedHeaders(request.headers),
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
          const upgradeConnector = role === "connector" ? null : endpoint!.connector;
          const [response, socket] = yield* Cloudflare.upgrade();
          if (role === "connector") {
            const superseded = endpoints.get(endpointKey);
            if (superseded?.connector) {
              yield* disconnectConnector(superseded, 4000, "Superseded by a newer connector");
            }
            // Disconnecting the old connector may have pruned its table, so
            // the new socket must attach to whatever table is live now.
            const connectorEndpoint = endpointRuntime(endpointKey);
            yield* state.storage.put(keys.activeSession, connectingSession!);
            socket.serializeAttachment({
              role: "connector",
              endpointKey,
              ...connectingSession!,
            } satisfies SocketAttachment);
            connectorEndpoint.connector = socket;
            yield* socket.send(
              encodeRelayTransportControlFrame(0, {
                type: "connector_ready",
                protocolVersion: RELAY_TRANSPORT_PROTOCOL_VERSION,
              }),
            );
          } else {
            const clientEndpoint = endpoint!;
            const { streamId, openFrame } = publicWebSocket!;
            if (upgradeConnector === null || !isActiveConnector(clientEndpoint, upgradeConnector)) {
              yield* socket.close(1013, "Environment connector changed during upgrade");
              return response;
            }
            socket.serializeAttachment({
              role: "client",
              endpointKey,
              streamId,
            } satisfies SocketAttachment);
            clientEndpoint.clients.set(streamId, socket);
            yield* upgradeConnector
              .send(openFrame)
              .pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? closeClient(
                        clientEndpoint,
                        streamId,
                        1013,
                        "Environment connector is offline",
                      )
                    : Effect.void,
                ),
              );
          }
          return response;
        }),
        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) {
          const attachment = socket.deserializeAttachment<SocketAttachment>();
          if (attachment === null || attachment === undefined) return;
          const endpoint = endpoints.get(attachment.endpointKey);
          if (attachment.role === "client") {
            if (endpoint === undefined) {
              yield* socket.close(1013, "Environment connector is offline");
              return;
            }
            if (endpoint.connector === null) {
              return yield* closeClient(
                endpoint,
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
                endpoint,
                attachment.streamId,
                1009,
                "WebSocket message exceeds the relay limit",
              );
            }
            for (const frame of frames) yield* endpoint.connector.send(frame);
            return;
          }
          if (
            endpoint === undefined ||
            !isActiveConnector(endpoint, socket) ||
            typeof message === "string"
          ) {
            return;
          }
          // Hibernation events may carry a fresh JavaScript handle for the
          // same persisted WebSocket. Keep sends pinned to the current handle.
          endpoint.connector = socket;

          const decoded = decodeRelayTransportFrame(message);
          if (Result.isFailure(decoded) || decoded.success.streamId === 0) {
            return;
          }
          const frame = decoded.success;
          const client = endpoint.clients.get(frame.streamId);
          const http = endpoint.pendingHttp.get(frame.streamId);
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
            const message = tryOrUndefined(() => endpoint.connectorMessages.append(frame));
            if (message === undefined) {
              yield* closeClient(
                endpoint,
                frame.streamId,
                1009,
                "Invalid fragmented relay message",
              );
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
              yield* closeClient(
                endpoint,
                frame.streamId,
                control.success.code,
                control.success.reason,
              );
            } else if (Result.isSuccess(control) && control.success.type === "websocket_reject") {
              yield* closeClient(endpoint, frame.streamId, 1011, control.success.reason);
            }
          }
        }),
        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string,
        ) {
          const attachment = socket.deserializeAttachment<SocketAttachment>();
          const endpoint =
            attachment === null || attachment === undefined
              ? undefined
              : endpoints.get(attachment.endpointKey);
          if (attachment?.role === "connector") {
            if (endpoint !== undefined && isActiveConnector(endpoint, socket)) {
              endpoint.connector = null;
              yield* state.storage.delete(storageKeys(endpoint.key).activeSession);
              yield* failConnectorStreams(endpoint, "Environment connector disconnected");
            }
          } else if (attachment?.role === "client" && endpoint !== undefined) {
            const wasActive = endpoint.clients.delete(attachment.streamId);
            endpoint.connectorMessages.delete(attachment.streamId);
            if (wasActive && endpoint.connector !== null) {
              yield* endpoint.connector.send(
                encodeRelayTransportControlFrame(attachment.streamId, {
                  type: "websocket_close",
                  code: normalizeRelayWebSocketCloseCode(code),
                  reason,
                }),
              );
            }
            pruneEndpoint(endpoint);
          }
          yield* socket.close(normalizeRelayWebSocketCloseCode(code), reason);
        }),
      };
    });
  }).pipe(Effect.provide(webcryptoLayer)),
) {}

export const relayConnectorTokenHeader = CONNECTOR_TOKEN_HEADER;
export const relayConnectorTicketHeader = CONNECTOR_TICKET_HEADER;
export const relayConnectionRoleHeader = CONNECTION_ROLE_HEADER;
export const relayEndpointKeyHeader = ENDPOINT_KEY_HEADER;
export const relayPublicUrlHeader = PUBLIC_URL_HEADER;
