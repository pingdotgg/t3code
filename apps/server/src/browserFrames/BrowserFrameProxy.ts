/**
 * Same-origin authenticated proxy in front of the desktop browser-frame hub
 * (`t3.browser/frames@1.0.0`).
 *
 * The hub binds loopback inside the engine host and is never reachable
 * directly, so every frame stream, snapshot, config read, and input socket
 * crosses this route. Reusing the T3 origin is what makes remote viewing work
 * unchanged — Tailscale and T3 Connect already carry `/api/*` and WebSocket
 * upgrades.
 *
 * Authentication mirrors DeviceHubProxy: cookie sessions and `wsTicket` go
 * through the upgrade authenticator at read scope; extension viewers redeem
 * a lease-bound `frameTicket`/`inputTicket` minted through `t3.browser/frames`
 * instead. Input upgrades require an input lease — authority is minted, never
 * asserted. Tickets are stripped before upstream forwarding; the proxy
 * re-asserts the verified session tuple and lease binding on the upstream
 * request and authenticates the hop with the hub's own secret, so the hub
 * never trusts client-supplied identity fields.
 *
 * Redeem re-validates the record's authority (session still live, caller
 * installations still enabled with unchanged content, grants and project
 * scope still held), and the route layer subscribes lease invalidations,
 * session removals, catalogue changes, and host disconnects into active
 * channel termination — a bound socket dies with its authority, not just
 * future verifies.
 *
 * Actions do not ride this surface — `/sessions` metadata, frames, and the
 * input socket only.
 */
import {
  AuthOrchestrationReadScope,
  BROWSER_FRAMES_ROUTE_PREFIX,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type BrowserFrameSessionTuple,
  type ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { SessionStore, type SessionCredentialChange } from "../auth/SessionStore.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { EnvironmentExtensions } from "../extensions/EnvironmentExtensions.ts";
import { ExtensionCatalogueChanges } from "../extensions/catalogueChanges.ts";
import {
  canonicalizeFrameHubOrigin,
  type FrameHubConnectionEvent,
  PreviewAutomationBroker,
  type BrowserFrameHubEndpoint,
} from "../mcp/PreviewAutomationBroker.ts";
import {
  authorityRidesOnSession,
  BrowserFrameLeases,
  browserFrameAuthorityKey,
  type BrowserFrameAuthority,
  type BrowserFrameLeaseInvalidation,
  type BrowserFrameTicketRecord,
} from "./BrowserFrameLeases.ts";

export { BROWSER_FRAMES_ROUTE_PREFIX };

const SESSION_PATH = /^\/sessions$/;
const SESSION_GET_PATH = /^\/sessions\/[^/]+\/(stream\.mjpeg|snapshot|config)$/;
const SESSION_INPUT_PATH = /^\/sessions\/([^/]+)\/input$/;

/** Stream deadline when the credential mode carries no expiry of its own. */
const DEFAULT_STREAM_AUTHORITY_TTL_MS = 5 * 60 * 1000;

/** Hop-by-hop and credential headers that must not cross the proxy. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  "x-t3-hub-auth",
  "x-t3-session",
  "x-t3-engine-generation",
  "x-t3-input-lease",
  "x-t3-lease",
  "x-t3-lease-expires",
]);

/** Params the proxy owns; clients may not assert them upstream. */
const STRIPPED_UPSTREAM_PARAMS = new Set([
  "wsTicket",
  "frameTicket",
  "inputTicket",
  "hostId",
  "x-t3-session",
  "x-t3-engine-generation",
  "x-t3-lease",
  "x-t3-lease-expires",
  "x-t3-ticket-seq",
]);

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

/**
 * The runtime tab id the hub fences on is the JSON serialization of
 * `[environmentId, threadId, serverEpoch, tabId]` — same compact encoding the
 * engine host produces in `previewRuntimeTabId`.
 */
const encodeRuntimeTabId = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.String])),
);

/**
 * `/sessions` for a ticket-bound caller returns only the bound tuple's row —
 * a tab-A ticket must not enumerate other threads or environments.
 */
const proxySessionsScoped = Effect.fn("BrowserFrameProxy.proxySessionsScoped")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  hubOrigin: string,
  injected: Record<string, string>,
  bound: BrowserFrameSessionTuple,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const upstreamRequest = HttpClientRequest.make("GET")(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(forwardHeaders(request, hubOrigin, injected)),
  );
  const response = yield* httpClient
    .execute(upstreamRequest)
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  if (response.status < 200 || response.status >= 300) {
    return HttpServerResponse.text("Bad Gateway", { status: 502 });
  }
  const body: unknown = yield* response.json;
  const rows = Array.isArray(body) ? body : [];
  const filtered = rows.filter(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      (row as { environmentId?: unknown }).environmentId === bound.environmentId &&
      (row as { threadId?: unknown }).threadId === bound.threadId &&
      (row as { serverEpoch?: unknown }).serverEpoch === bound.serverEpoch &&
      (row as { tabId?: unknown }).tabId === bound.tabId,
  );
  return yield* HttpServerResponse.json(filtered, {
    headers: { "cache-control": "no-store" },
  });
});

const authenticateSessionRead = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (EnvironmentAuth.isServerAuthCredentialError(error)) {
          return yield* failEnvironmentAuthInvalid(
            EnvironmentAuth.serverAuthCredentialReason(error),
            EnvironmentAuth.serverAuthDpopFailureReason(error),
          );
        }
        return yield* failEnvironmentInternal("internal_error", error);
      }),
    ),
  );
  if (!session.scopes.includes(AuthOrchestrationReadScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
  }
  return session;
});

/**
 * Session tuple from request query params. Only used for session-credential
 * requests — ticket-authenticated requests take the tuple from the verified
 * record, and the hub independently fences every route against it.
 */
const tupleFromQuery = (params: URLSearchParams, pathTabId: string | null) => {
  const environmentId = params.get("environmentId");
  const threadId = params.get("threadId");
  const serverEpoch = params.get("serverEpoch");
  const tabId = pathTabId ?? params.get("tabId");
  if (!environmentId || !threadId || !serverEpoch || !tabId) return Option.none();
  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({
      environmentId: Schema.String.check(Schema.isNonEmpty()),
      threadId: Schema.String.check(Schema.isNonEmpty()),
      serverEpoch: Schema.String.check(Schema.isNonEmpty()),
      tabId: Schema.String.check(Schema.isNonEmpty()),
    }),
  )({ environmentId, threadId, serverEpoch, tabId });
  return Option.flatMap(decoded, (tuple) => Option.some(tuple as BrowserFrameSessionTuple));
};

const forwardHeaders = (
  request: HttpServerRequest.HttpServerRequest,
  origin: string,
  injected: Record<string, string>,
) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  if (request.headers.origin !== undefined) headers.origin = origin;
  Object.assign(headers, injected);
  return headers;
};

const proxyHttp = Effect.fn("BrowserFrameProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  hubOrigin: string,
  injected: Record<string, string>,
  interrupt: Effect.Effect<unknown>,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const upstreamRequest = HttpClientRequest.make("GET")(upstreamUrl).pipe(
    HttpClientRequest.setHeaders(forwardHeaders(request, hubOrigin, injected)),
  );
  // Redirects are never followed upstream: a 3xx to a non-hub target would
  // smuggle the hub secret to an arbitrary origin.
  const response = yield* httpClient
    .execute(upstreamRequest)
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  if (response.status >= 300 && response.status < 400) {
    return HttpServerResponse.text("Bad Gateway", { status: 502 });
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (name === "content-encoding" || name === "transfer-encoding" || name === "connection") {
      continue;
    }
    if (value !== undefined) headers[name] = value;
  }
  // Long-lived MJPEG responses must not be buffered by compression or cached.
  headers["cache-control"] = "no-store, no-transform";
  return HttpServerResponse.stream(response.stream.pipe(Stream.interruptWhen(interrupt)), {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

/** Pipe the client input socket to the hub's opaquely. */
const proxyWebSocket = Effect.fn("BrowserFrameProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  interrupt: Effect.Effect<unknown>,
) {
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      // Whichever side closes first ends the other via scope teardown: a close
      // fails that side's pull with a SocketError, which loses the race. The
      // interrupt effect is the third racer: lease invalidation ends both.
      return yield* Effect.raceFirst(
        Effect.raceFirst(pumpFrames(upstream, writeToClient), pumpFrames(client, writeToUpstream)),
        interrupt,
      );
    }),
  ).pipe(Effect.catchCause(() => Effect.void));
  return HttpServerResponse.empty();
});

const pumpFrames = (source: Socket.Socket, sink: Socket.Writer) =>
  Effect.gen(function* () {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const upstreamParams = (
  params: URLSearchParams,
  session: BrowserFrameSessionTuple,
  engineGeneration: string | null,
  leaseBinding?: { leaseId?: string; expiresAt?: number; ticketSeq?: number },
): string => {
  const upstream = new URLSearchParams();
  for (const [name, value] of params) {
    if (STRIPPED_UPSTREAM_PARAMS.has(name)) continue;
    upstream.append(name, value);
  }
  // The proxy re-asserts the verified tuple and lease binding: the hub treats
  // these as server-asserted identity on the authenticated loopback hop.
  upstream.set(
    "x-t3-session",
    encodeRuntimeTabId([
      session.environmentId,
      session.threadId,
      session.serverEpoch,
      session.tabId,
    ]),
  );
  if (engineGeneration !== null) upstream.set("x-t3-engine-generation", engineGeneration);
  if (leaseBinding?.leaseId !== undefined) upstream.set("x-t3-lease", leaseBinding.leaseId);
  // The credential's expiry rides along as the stream/socket floor: the hub
  // ends the response or closes the socket when it passes, so open-time auth
  // never leaves pixels or input flowing past a dead ticket.
  if (leaseBinding?.expiresAt !== undefined) {
    upstream.set("x-t3-lease-expires", String(leaseBinding.expiresAt));
  }
  // The ticket sequence rides along so the hub can refuse a bind from an
  // older verified ticket than the one already holding the socket.
  if (leaseBinding?.ticketSeq !== undefined) {
    upstream.set("x-t3-ticket-seq", String(leaseBinding.ticketSeq));
  }
  return upstream.toString();
};

/**
 * Replay the mint-time authority checks against live state. Session-backed
 * records revalidate their session; extension records additionally re-resolve
 * the caller chain — every captured installation must still be enabled with
 * unchanged content, and the leaf must still hold the minted grants and
 * project scope. `EnvironmentExtensions` is not ambient to route handlers, so
 * the service is captured at layer construction and closed over.
 */
const makeAuthorityStillValid = (extensions: EnvironmentExtensions["Service"]) =>
  Effect.fn("BrowserFrameProxy.authorityStillValid")(function* (authority: BrowserFrameAuthority) {
    const sessions = yield* SessionStore;
    const sessionId =
      authority.kind === "session"
        ? authority.sessionId
        : authority.principalKind === "environment-session"
          ? (authority.principalId as AuthSessionId)
          : undefined;
    if (sessionId !== undefined) {
      const current = yield* sessions.revalidate(sessionId).pipe(Effect.option);
      if (Option.isNone(current)) return false;
      if (authority.subject !== undefined && current.value.subject !== authority.subject) {
        return false;
      }
      if (
        authority.kind === "session" &&
        !authority.grants.every((scope) =>
          current.value.scopes.includes(scope as AuthEnvironmentScope),
        )
      ) {
        return false;
      }
    }
    if (authority.kind !== "extension") return true;
    const installations = yield* extensions.list.pipe(Effect.option);
    if (Option.isNone(installations)) return false;
    const projectId =
      typeof authority.context === "object" && authority.context !== null
        ? (authority.context as { resource?: { projectId?: ProjectId } }).resource?.projectId
        : undefined;
    for (const caller of authority.callerGenerations) {
      const entry = installations.value.find((item) => item.id === caller.pluginId);
      if (!entry || !entry.enabled || entry.contentHash !== caller.contentHash) return false;
    }
    const leaf = installations.value.find((item) => item.id === authority.callerId);
    if (!leaf || !leaf.enabled) return false;
    if (!authority.grants.every((grant) => leaf.grants.capabilities.includes(grant))) return false;
    if (projectId !== undefined && !leaf.grants.projectIds.includes(projectId)) return false;
    return true;
  });

/**
 * Arm the interrupt for one bound channel on subscriptions the caller opened
 * BEFORE the ticket was verified: completes when the record's lease is
 * revoked/superseded, its authority dies, or its engine-host connection goes
 * away. Because the subscriptions predate verification, a revocation racing
 * the redeem is either caught by the post-check re-verify or already queued
 * on these streams — never missed in the gap.
 */
const armChannelInterrupt = Effect.fn("BrowserFrameProxy.armChannelInterrupt")(function* (
  record: BrowserFrameTicketRecord,
  invalidations: Stream.Stream<BrowserFrameLeaseInvalidation>,
  hubEvents: Stream.Stream<FrameHubConnectionEvent>,
) {
  const fired = yield* Deferred.make<void>();
  const matches = (leaseId: string | undefined) =>
    record.leaseId !== undefined && leaseId === record.leaseId;
  const authorityKey = browserFrameAuthorityKey(record.authority);
  yield* Effect.forkScoped(
    Stream.runForEach(invalidations, (event) => {
      const hit =
        (event.type === "lease" && matches(event.leaseId)) ||
        (event.type === "authority" && event.authorityKey === authorityKey) ||
        (event.type === "session" && authorityRidesOnSession(record.authority, event.sessionId));
      return hit ? Deferred.succeed(fired, undefined) : Effect.void;
    }),
  );
  if (record.hostConnectionId !== null) {
    yield* Effect.forkScoped(
      Stream.runForEach(hubEvents, (event) =>
        event.connectionId === record.hostConnectionId
          ? Deferred.succeed(fired, undefined)
          : Effect.void,
      ),
    );
  }
  return Deferred.await(fired);
});

/**
 * Session-credential GET channels get the same treatment: the subscription is
 * opened before authentication, the session is revalidated after it, and this
 * drain fires the interrupt when a later removal lands.
 */
const armSessionInterrupt = Effect.fn("BrowserFrameProxy.armSessionInterrupt")(function* (
  sessionId: AuthSessionId,
  watched: Stream.Stream<SessionCredentialChange>,
) {
  const fired = yield* Deferred.make<void>();
  yield* Effect.forkScoped(
    Stream.runForEach(watched, (change) =>
      change.type === "clientRemoved" && change.sessionId === sessionId
        ? Deferred.succeed(fired, undefined)
        : Effect.void,
    ),
  );
  return Deferred.await(fired);
});

const makeHandler = (
  authorityStillValid: (
    authority: BrowserFrameAuthority,
  ) => Effect.Effect<boolean, never, SessionStore>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const hubPath = url.value.pathname.slice(BROWSER_FRAMES_ROUTE_PREFIX.length) || "/";
    const params = url.value.searchParams;
    const upgrade = isWebSocketUpgrade(request);
    const inputMatch = SESSION_INPUT_PATH.exec(hubPath);
    const getAllowed =
      request.method === "GET" && (SESSION_PATH.test(hubPath) || SESSION_GET_PATH.test(hubPath));

    if (upgrade) {
      if (inputMatch === null) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
    } else if (!getAllowed) {
      return SESSION_PATH.test(hubPath) || SESSION_GET_PATH.test(hubPath) || inputMatch !== null
        ? HttpServerResponse.text("Method Not Allowed", { status: 405 })
        : HttpServerResponse.text("Not Found", { status: 404 });
    }

    const leases = yield* BrowserFrameLeases;
    const broker = yield* PreviewAutomationBroker;

    if (upgrade && inputMatch !== null) {
      // Input is lease-gated: a minted ticket is the only credential, and it is
      // verified — with its authority — before the upgrade is accepted.
      const tabId = inputMatch[1];
      const ticket = params.get("inputTicket");
      // Subscribe BEFORE verifying: a revocation landing anywhere in the
      // verify→authority→re-verify window is already queued on these streams,
      // so the channel can never miss its own death.
      const invalidations = yield* leases.watchInvalidations();
      const hubEvents = yield* broker.watchFrameHubEvents();
      const record =
        ticket === null || tabId === undefined ? Option.none() : yield* leases.verify(ticket);
      if (
        ticket === null ||
        tabId === undefined ||
        Option.isNone(record) ||
        record.value.kind !== "input" ||
        record.value.session.tabId !== decodeURIComponent(tabId)
      ) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
      if (!(yield* authorityStillValid(record.value.authority))) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
      // Re-verify after the authority wait — catches a revocation that landed
      // between the first verify and now; anything later hits the armed drains.
      if (Option.isNone(yield* leases.verify(ticket))) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
      const session = record.value.session;
      const endpoints = yield* broker.frameHubs;
      const hub =
        record.value.hostClientId === null
          ? undefined
          : endpoints.find(
              (endpoint) =>
                endpoint.clientId === record.value.hostClientId &&
                canonicalizeFrameHubOrigin(endpoint.origin) === endpoint.origin,
            );
      if (!hub || hub.connectionId !== record.value.hostConnectionId) {
        return HttpServerResponse.text("Browser frame hub is not running", { status: 503 });
      }
      const search = upstreamParams(params, session, record.value.engineGeneration, {
        ...(record.value.leaseId !== undefined ? { leaseId: record.value.leaseId } : {}),
        expiresAt: record.value.expiresAt,
        ticketSeq: record.value.ticketSeq,
      });
      // Node's WebSocket cannot set upgrade headers — the hub secret rides the
      // query, which the hub accepts only on this loopback hop.
      const upstream = `${hub.origin.replace(/^http/, "ws")}${hubPath}?${search}&x-t3-hub-auth=${encodeURIComponent(hub.secret)}`;
      const interrupt = yield* armChannelInterrupt(record.value, invalidations, hubEvents);
      return yield* proxyWebSocket(request, upstream, interrupt);
    }

    // GET routes: a frameTicket authorizes extension viewers; otherwise the
    // request must carry an environment session at read scope.
    const frameTicket = params.get("frameTicket");
    // Subscribe BEFORE verifying under either credential mode — same
    // subscribe-first guarantee as the input upgrade path.
    const invalidations = yield* leases.watchInvalidations();
    const hubEvents = yield* broker.watchFrameHubEvents();
    let sessionTuple: Option.Option<BrowserFrameSessionTuple>;
    let engineGeneration: string | null = null;
    let boundHostClientId: string | null = null;
    let boundHostConnectionId: string | null = null;
    let credentialExpiresAt: number | undefined;
    let ticketRecord: BrowserFrameTicketRecord | undefined;
    let sessionInterrupt: Effect.Effect<unknown> | undefined;
    if (frameTicket !== null) {
      const record = yield* leases.verify(frameTicket);
      if (Option.isNone(record) || record.value.kind !== "stream") {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
      if (!(yield* authorityStillValid(record.value.authority))) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
      // Re-verify after the authority wait: a revocation landing mid-check is
      // caught here; anything later is already queued on the subscriptions.
      if (Option.isNone(yield* leases.verify(frameTicket))) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
      ticketRecord = record.value;
      sessionTuple = Option.some(record.value.session);
      engineGeneration = record.value.engineGeneration;
      boundHostClientId = record.value.hostClientId;
      boundHostConnectionId = record.value.hostConnectionId;
      credentialExpiresAt = record.value.expiresAt;
    } else {
      const sessions = yield* SessionStore;
      const watched = yield* sessions.watchChanges();
      const sessionAuth = yield* authenticateSessionRead;
      // The session could have been removed between subscription and auth —
      // revalidate closes that window; later removals hit the armed drain.
      const revalidated = yield* sessions.revalidate(sessionAuth.sessionId).pipe(Effect.option);
      if (Option.isNone(revalidated)) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
      sessionInterrupt = yield* armSessionInterrupt(sessionAuth.sessionId, watched);
      const pathTabId = SESSION_GET_PATH.test(hubPath)
        ? decodeURIComponent(hubPath.split("/")[2] ?? "")
        : null;
      sessionTuple = tupleFromQuery(params, pathTabId);
      engineGeneration = params.get("engineGeneration");
      // Effective credential deadline: the wsTicket claim expiry when present,
      // capped by the session row; a finite floor even for credential modes
      // that carry no expiry of their own.
      credentialExpiresAt =
        sessionAuth.credentialExpiresAt?.epochMilliseconds ??
        sessionAuth.expiresAt?.epochMilliseconds ??
        (yield* Clock.currentTimeMillis) + DEFAULT_STREAM_AUTHORITY_TTL_MS;
    }
    if (Option.isNone(sessionTuple)) {
      return HttpServerResponse.text("Missing session identity", { status: 400 });
    }
    const session = sessionTuple.value;
    const endpoints = yield* broker.frameHubs;
    const candidates = endpoints.filter(
      (endpoint) =>
        endpoint.environmentId === session.environmentId &&
        canonicalizeFrameHubOrigin(endpoint.origin) === endpoint.origin,
    );
    let hub: BrowserFrameHubEndpoint | undefined;
    if (boundHostClientId !== null) {
      // Ticket-bound: the mint's host binding is authoritative; a query hostId
      // can never redirect the upstream.
      hub = candidates.find((endpoint) => endpoint.clientId === boundHostClientId);
    } else {
      // Session-credential requests may name a hub, or take the sole candidate.
      const requested = params.get("hostId");
      hub =
        requested !== null
          ? candidates.find((endpoint) => endpoint.clientId === requested)
          : candidates.length === 1
            ? candidates[0]
            : undefined;
    }
    if (!hub || (boundHostConnectionId !== null && hub.connectionId !== boundHostConnectionId)) {
      return HttpServerResponse.text("Browser frame hub is not running", { status: 503 });
    }
    const search = upstreamParams(params, session, engineGeneration, {
      ...(credentialExpiresAt !== undefined ? { expiresAt: credentialExpiresAt } : {}),
    });
    const injected: Record<string, string> = {
      "x-t3-hub-auth": hub.secret,
      "x-t3-session": encodeRuntimeTabId([
        session.environmentId,
        session.threadId,
        session.serverEpoch,
        session.tabId,
      ]),
    };
    if (engineGeneration !== null) injected["x-t3-engine-generation"] = engineGeneration;
    const upstreamUrl = `${hub.origin}${hubPath}${search ? `?${search}` : ""}`;
    if (ticketRecord !== undefined && SESSION_PATH.test(hubPath)) {
      return yield* proxySessionsScoped(request, upstreamUrl, hub.origin, injected, session);
    }
    const interrupt =
      ticketRecord !== undefined
        ? yield* armChannelInterrupt(ticketRecord, invalidations, hubEvents)
        : (sessionInterrupt ?? Effect.never);
    return yield* proxyHttp(request, upstreamUrl, hub.origin, injected, interrupt);
  });

const invalidationWatchers = Effect.gen(function* () {
  const leases = yield* BrowserFrameLeases;
  const sessions = yield* SessionStore;
  const extensions = yield* EnvironmentExtensions;
  const catalogueChanges = yield* ExtensionCatalogueChanges;

  // Session removal sweeps every record riding on it — the invalidation
  // events then reach open channels via channelInterrupt.
  const watched = yield* sessions.watchChanges();
  yield* Stream.runForEach(watched, (change) =>
    change.type === "clientRemoved" ? leases.revokeSession(change.sessionId) : Effect.void,
  ).pipe(Effect.forkScoped);

  // Catalogue churn (uninstall, grant change, replacement) re-validates
  // every extension authority; revoked callers lose live channels, not just
  // future mints.
  yield* Stream.runForEach(catalogueChanges.changes, () =>
    Effect.gen(function* () {
      const installations = yield* extensions.list.pipe(Effect.option);
      if (Option.isNone(installations)) return;
      yield* leases.revokeWhere((record) => {
        const authority = record.authority;
        if (authority.kind !== "extension") return false;
        const stale = authority.callerGenerations.some((caller) => {
          const entry = installations.value.find((item) => item.id === caller.pluginId);
          return !entry || !entry.enabled || entry.contentHash !== caller.contentHash;
        });
        if (stale) return true;
        const leaf = installations.value.find((item) => item.id === authority.callerId);
        if (!leaf || !leaf.enabled) return true;
        if (!authority.grants.every((grant) => leaf.grants.capabilities.includes(grant))) {
          return true;
        }
        // A caller whose project scope shrank loses mints made under the old
        // context — same wall `authorityStillValid` enforces at redeem.
        const projectId =
          typeof authority.context === "object" && authority.context !== null
            ? (authority.context as { resource?: { projectId?: ProjectId } }).resource?.projectId
            : undefined;
        return projectId !== undefined && !leaf.grants.projectIds.includes(projectId);
      });
    }),
  ).pipe(Effect.forkScoped);
});

export const browserFrameProxyRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const extensions = yield* EnvironmentExtensions;
    yield* invalidationWatchers;
    return HttpRouter.add(
      "*",
      `${BROWSER_FRAMES_ROUTE_PREFIX}/*`,
      makeHandler(makeAuthorityStillValid(extensions)),
    );
  }),
);
