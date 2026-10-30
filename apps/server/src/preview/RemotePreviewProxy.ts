// A desktop renders a remote preview locally and reaches the environment's loopback dev servers
// through these byte tunnels. A grant names the ports one session approved; it never carries the
// session's own credential, so application traffic cannot replay it against the environment API.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { AuthSessionId, PreviewProxyGrantError, type PreviewProxyGrant } from "@t3tools/contracts";
import {
  REMOTE_PREVIEW_PROXY_GRANT_HEADER,
  REMOTE_PREVIEW_PROXY_RENEW_PATH,
  REMOTE_PREVIEW_PROXY_REVOKE_PATH,
  REMOTE_PREVIEW_PROXY_TUNNEL_PATH,
  isRemotePreviewProxyDialHost,
} from "@t3tools/shared/remotePreviewProxy";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";

const SIGNING_SECRET_NAME = "preview-proxy-signing-key";
const GRANT_TTL = Duration.minutes(10);
const CONNECT_TIMEOUT = Duration.seconds(10);
const MAX_GRANT_LENGTH = 4_096;

const GrantClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("preview-proxy"),
  gid: Schema.String,
  sid: AuthSessionId,
  ports: Schema.Array(Schema.Int),
  exp: Schema.Number,
});
type GrantClaims = typeof GrantClaims.Type;
const GrantClaimsJson = Schema.fromJsonString(GrantClaims);
const decodeClaims = Schema.decodeUnknownOption(GrantClaimsJson);
const encodeClaims = Schema.encodeSync(GrantClaimsJson);

export class RemotePreviewProxy extends Context.Service<
  RemotePreviewProxy,
  {
    readonly issueGrant: (
      sessionId: AuthSessionId,
      ports: ReadonlyArray<number>,
    ) => Effect.Effect<PreviewProxyGrant, PreviewProxyGrantError>;
    /** The claims of a signed, unexpired, unrevoked grant whose session is still active. */
    readonly verifyGrant: (grant: string) => Effect.Effect<Option.Option<GrantClaims>>;
    readonly renewGrant: (grant: string) => Effect.Effect<Option.Option<PreviewProxyGrant>>;
    readonly revokeGrant: (grant: string) => Effect.Effect<void>;
    /** Completes when the grant is revoked or its session is invalidated. */
    readonly awaitRevocation: (claims: GrantClaims) => Effect.Effect<void>;
  }
>()("t3/preview/RemotePreviewProxy") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = yield* SessionStore.SessionStore;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  // Revocation only needs to outlive the grant's TTL, so memory is enough.
  const revoked = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const revocations = new Map<string, Deferred.Deferred<void>>();

  const secret = secrets
    .getOrCreateRandom(SIGNING_SECRET_NAME, 32)
    .pipe(
      Effect.mapError((cause) => new PreviewProxyGrantError({ reason: "issue-failed", cause })),
    );

  const sign = Effect.fn("RemotePreviewProxy.sign")(function* (claims: GrantClaims) {
    const payload = base64UrlEncode(encodeClaims(claims));
    return `${payload}.${signPayload(payload, yield* secret)}`;
  });

  const toGrant = (claims: GrantClaims, grant: string): PreviewProxyGrant => ({
    grant,
    expiresAt: DateTime.makeUnsafe(claims.exp),
    ports: claims.ports,
  });

  const issueGrant = Effect.fn("RemotePreviewProxy.issueGrant")(function* (
    sessionId: AuthSessionId,
    ports: ReadonlyArray<number>,
  ) {
    // The server's own port answers loopback callers more permissively than remote ones.
    if (ports.includes(config.port)) {
      return yield* new PreviewProxyGrantError({ reason: "port-reserved", port: config.port });
    }
    const gid = Hex.encode(
      yield* crypto
        .randomBytes(16)
        .pipe(
          Effect.mapError((cause) => new PreviewProxyGrantError({ reason: "issue-failed", cause })),
        ),
    );
    const now = yield* DateTime.now;
    const claims: GrantClaims = {
      v: 1,
      kind: "preview-proxy",
      gid,
      sid: sessionId,
      ports: [...new Set(ports)].toSorted((a, b) => a - b),
      exp: now.epochMilliseconds + Duration.toMillis(GRANT_TTL),
    };
    return toGrant(claims, yield* sign(claims));
  });

  const verifyGrant = Effect.fn("RemotePreviewProxy.verifyGrant")(function* (grant: string) {
    if (grant.length === 0 || grant.length > MAX_GRANT_LENGTH) return Option.none();
    const [payload, signature, extra] = grant.split(".");
    if (!payload || !signature || extra !== undefined) return Option.none();
    const key = yield* secret.pipe(Effect.option);
    if (Option.isNone(key)) return Option.none();
    if (!timingSafeEqualBase64Url(signature, signPayload(payload, key.value))) {
      return Option.none();
    }
    const claims = (() => {
      try {
        return decodeClaims(base64UrlDecodeUtf8(payload));
      } catch {
        return Option.none<GrantClaims>();
      }
    })();
    if (Option.isNone(claims)) return claims;
    const now = yield* DateTime.now;
    if (claims.value.exp <= now.epochMilliseconds) return Option.none();
    if ((yield* Ref.get(revoked)).has(claims.value.gid)) return Option.none();
    const active = yield* sessions
      .isActive(claims.value.sid)
      .pipe(Effect.orElseSucceed(() => false));
    return active ? claims : Option.none();
  });

  const revocationFor = Effect.fnUntraced(function* (gid: string) {
    const existing = revocations.get(gid);
    if (existing) return existing;
    const created = yield* Deferred.make<void>();
    revocations.set(gid, created);
    return created;
  });

  return RemotePreviewProxy.of({
    issueGrant,
    verifyGrant,
    renewGrant: Effect.fn("RemotePreviewProxy.renewGrant")(function* (grant: string) {
      const claims = yield* verifyGrant(grant);
      if (Option.isNone(claims)) return Option.none();
      const now = yield* DateTime.now;
      const renewed: GrantClaims = {
        ...claims.value,
        exp: now.epochMilliseconds + Duration.toMillis(GRANT_TTL),
      };
      return yield* sign(renewed).pipe(
        Effect.map((signed) => Option.some(toGrant(renewed, signed))),
        Effect.orElseSucceed(() => Option.none()),
      );
    }),
    revokeGrant: Effect.fn("RemotePreviewProxy.revokeGrant")(function* (grant: string) {
      const claims = yield* verifyGrant(grant);
      if (Option.isNone(claims)) return;
      const now = yield* DateTime.now;
      const { gid } = claims.value;
      yield* Ref.update(revoked, (current) => {
        const next = new Map(
          [...current].filter(([, expiresAt]) => expiresAt > now.epochMilliseconds),
        );
        // Renewal keeps the gid, so block it for a full TTL past now.
        next.set(gid, now.epochMilliseconds + Duration.toMillis(GRANT_TTL));
        return next;
      });
      yield* Deferred.succeed(yield* revocationFor(gid), undefined);
      // Open tunnels already hold the completed deferred; new ones are refused by `revoked`.
      revocations.delete(gid);
    }),
    awaitRevocation: Effect.fn("RemotePreviewProxy.awaitRevocation")(function* (claims) {
      // A tunnel verified just before a revocation must still see it.
      if ((yield* Ref.get(revoked)).has(claims.gid)) return;
      yield* Effect.raceFirst(
        Effect.flatMap(revocationFor(claims.gid), Deferred.await),
        sessions.awaitInvalidation(claims.sid).pipe(Effect.ignore),
      );
    }),
  });
});

export const layer = Layer.effect(RemotePreviewProxy, make);

const grantFromRequest = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers[REMOTE_PREVIEW_PROXY_GRANT_HEADER]?.trim() ?? "";

const deny = (status: number, code: string) =>
  HttpServerResponse.text(code, { status, headers: { "cache-control": "no-store" } });

const pump =
  /* Byte pumping runs for the tunnel's lifetime; a span per pull adds nothing. */
  Effect.fnUntraced(function* (
    pull: Effect.Effect<ReadonlyArray<Uint8Array | string>, Socket.SocketError>,
    sink: Socket.Writer,
  ) {
    while (true) {
      const chunks = yield* pull;
      const [first, ...rest] = chunks;
      if (first !== undefined) yield* sink.writeAll([first, ...rest]);
    }
  });

// Request middleware owns tracing, including long-lived tunnels.
const tunnel = Effect.fnUntraced(function* (proxy: RemotePreviewProxy["Service"]) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url) || request.headers.upgrade?.toLowerCase() !== "websocket") {
    return deny(400, "websocket-required");
  }
  const claims = yield* proxy.verifyGrant(grantFromRequest(request));
  if (Option.isNone(claims)) return deny(401, "grant-invalid");
  const host = url.value.searchParams.get("host") ?? "";
  const port = Number(url.value.searchParams.get("port"));
  if (!isRemotePreviewProxyDialHost(host) || !Number.isInteger(port)) {
    return deny(400, "destination-invalid");
  }
  if (!claims.value.ports.includes(port)) return deny(403, "port-not-approved");

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const upstream = yield* NodeSocket.makeNet({ host, port, openTimeout: CONNECT_TIMEOUT });
      // Connect before upgrading so an unreachable port is an HTTP status, not a dropped tunnel.
      const upstreamReader = yield* upstream.reader.pipe(Effect.option);
      if (Option.isNone(upstreamReader)) return deny(502, "upstream-unreachable");
      const client = yield* request.upgrade;
      const clientPull = yield* Socket.readerBytes(client);
      const toClient = yield* client.writer;
      const toUpstream = yield* upstream.writer;
      // Each side ends by failing its pull; whichever ends first tears down both sockets.
      yield* Effect.raceAll([
        pump(upstreamReader.value.pull, toClient).pipe(Effect.ignore),
        pump(clientPull, toUpstream).pipe(Effect.ignore),
        proxy.awaitRevocation(claims.value),
      ]);
      return HttpServerResponse.empty();
    }),
  );
});

const renew = Effect.fnUntraced(function* (proxy: RemotePreviewProxy["Service"]) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const renewed = yield* proxy.renewGrant(grantFromRequest(request));
  if (Option.isNone(renewed)) return deny(401, "grant-invalid");
  return HttpServerResponse.jsonUnsafe(
    {
      grant: renewed.value.grant,
      expiresAt: DateTime.formatIso(renewed.value.expiresAt),
      ports: renewed.value.ports,
    },
    { headers: { "cache-control": "no-store" } },
  );
});

const revoke = Effect.fnUntraced(function* (proxy: RemotePreviewProxy["Service"]) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  yield* proxy.revokeGrant(grantFromRequest(request));
  return HttpServerResponse.empty({ status: 204 });
});

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const proxy = yield* RemotePreviewProxy;
    yield* router.add("GET", REMOTE_PREVIEW_PROXY_TUNNEL_PATH, tunnel(proxy));
    yield* router.add("POST", REMOTE_PREVIEW_PROXY_RENEW_PATH, renew(proxy));
    yield* router.add("POST", REMOTE_PREVIEW_PROXY_REVOKE_PATH, revoke(proxy));
  }),
);
