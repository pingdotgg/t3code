import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  RelayEnvironmentLinkProofPayload,
  type RelayLinkProofRequest,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpServer } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as NetAddress from "effect/net/NetAddress";
import { decodeRelayJwt, RELAY_LINK_PROOF_TYP, verifyRelayJwt } from "@t3tools/shared/relayJwt";

import * as EnvironmentKeys from "./environmentKeys.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectHttp from "./http.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const DESKTOP_BOOTSTRAP_TOKEN = "test-desktop-bootstrap-token";
const NON_LOOPBACK_ORIGIN = "http://172.24.162.233:3773";
const LOOPBACK_ORIGIN = "http://127.0.0.1:3773";
const proofRequest: RelayLinkProofRequest = {
  challenge: "test-challenge",
  relayIssuer: "https://relay.example.test",
  endpoint: {
    providerKind: "cloudflare_tunnel",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  },
  origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
};
const decodeLinkProofPayload = Schema.decodeUnknownEffect(RelayEnvironmentLinkProofPayload);

class LinkProofTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.auth,
  EnvironmentHttpApi.groups.connect,
) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "desktop" as const,
      host: "0.0.0.0",
      port: 3773,
      desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN,
    };
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-link-proof-test-" })));

// Real credential issuance, verification, origin checks and signing; no relay or tunnel is started.
const layerLinkProofRoutes = HttpApiBuilder.layer(LinkProofTestApi).pipe(
  Layer.provide([AuthHttp.layer, ConnectHttp.layer]),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provide(CloudLink.layer),
  Layer.provide(EnvironmentKeys.layer),
  Layer.provide(
    Layer.mock(ConnectReachability.ConnectReachability)({ latest: Effect.succeedNone }),
  ),
  Layer.provide(EnvironmentAuth.layer),
  Layer.provide([
    ManagedPolicy.layerTest(),
    SqlitePersistence.layerMemory,
    ServerEnvironment.layerIdentity,
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make("wsl-environment"),
        label: "WSL",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: false },
      }),
    }),
    Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({}),
    Layer.mock(CliTokenManager.CloudCliTokenManager)({}),
    Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({}),
    Layer.mock(HttpServer.HttpServer)({
      address: NetAddress.inetAddressFromIpStringUnsafe("0.0.0.0", 3773),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected relay call")),
    ),
  ]),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(layerConfig),
  Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const responseJson = (response: Response) => Effect.promise(() => response.json());

// Scoped: the web handler and its layer are disposed when the test's scope closes.
const linkProofClient = Effect.gen(function* () {
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layerLinkProofRoutes, { disableLogger: true })),
    (web) => Effect.promise(() => web.dispose()),
  );
  const post = (
    path: string,
    payload: unknown,
    headers?: Record<string, string>,
    origin = NON_LOOPBACK_ORIGIN,
  ) =>
    Effect.promise(() =>
      handler(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(payload),
        }),
      ),
    );
  const exchange = Effect.fnUntraced(function* (credential: string, scope?: string) {
    const response = yield* Effect.promise(() =>
      handler(
        new Request(`${NON_LOOPBACK_ORIGIN}/oauth/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: credential,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
            ...(scope ? { scope } : {}),
          }),
        }),
      ),
    );
    expect(response.status).toBe(200);
    const payload = (yield* responseJson(response)) as { access_token: string };
    return payload.access_token;
  });
  const linkableHere = (token: string, origin = NON_LOOPBACK_ORIGIN) =>
    Effect.promise(() =>
      handler(
        new Request(`${origin}/api/connect/link-state`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).pipe(
      Effect.flatMap(responseJson),
      Effect.map((state) => (state as { linkableHere?: boolean }).linkableHere),
    );
  return { post, exchange, linkableHere };
});

describe("link proof over a non-loopback desktop transport", () => {
  it.effect(
    "signs a loopback tunnel origin after desktop bootstrap token exchange over a non-loopback host",
    () =>
      Effect.gen(function* () {
        const { post, exchange } = yield* linkProofClient;
        const token = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN);
        const response = yield* post("/api/connect/link-proof", proofRequest, {
          authorization: `Bearer ${token}`,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const proof = (yield* responseJson(response)) as string;
        const unverified = yield* decodeRelayJwt(proof).pipe(
          Effect.flatMap(decodeLinkProofPayload),
        );
        yield* TestClock.setTime(unverified.iat * 1_000);
        const verified = yield* verifyRelayJwt(RelayEnvironmentLinkProofPayload, {
          publicKey: unverified.environmentPublicKey,
          token: proof,
          typ: RELAY_LINK_PROOF_TYP,
          issuer: "t3-env:wsl-environment",
          audience: proofRequest.relayIssuer,
        });
        expect(verified).toMatchObject({
          origin: proofRequest.origin,
          endpoint: proofRequest.endpoint,
          challenge: proofRequest.challenge,
        });
      }).pipe(Effect.provide(NodeCrypto.layerSignature)),
  );

  it.effect(
    "does not pass desktop trust to a paired client or accept client-supplied provenance",
    () =>
      Effect.gen(function* () {
        const { post, exchange, linkableHere } = yield* linkProofClient;
        const desktop = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN);
        const paired = yield* post(
          "/api/auth/pairing-token",
          {
            scopes: ["relay:read", "relay:write"],
            label: "desktop-bootstrap",
            subject: "desktop-bootstrap",
          },
          { authorization: `Bearer ${desktop}` },
        );
        expect(paired.status).toBe(200);
        const { credential } = (yield* responseJson(paired)) as { credential: string };
        const token = yield* exchange(credential);
        const headers = { authorization: `Bearer ${token}`, "x-desktop-bootstrap": "true" };
        const payload = {
          ...proofRequest,
          allowNonLoopbackRequestHost: true,
          subject: "desktop-bootstrap",
        };
        const rejected = yield* post("/api/connect/link-proof", payload, headers);
        expect(rejected.status).toBe(400);
        expect(yield* responseJson(rejected)).toMatchObject({
          message: "Invalid managed endpoint origin.",
        });
        const loopback = yield* post(
          "/api/connect/link-proof",
          proofRequest,
          headers,
          LOOPBACK_ORIGIN,
        );
        expect(loopback.status).toBe(200);
        // Link state tells clients the same, so Turn on shows only where linking works.
        expect(yield* linkableHere(desktop)).toBe(true);
        expect(yield* linkableHere(token)).toBe(false);
        expect(yield* linkableHere(token, LOOPBACK_ORIGIN)).toBe(true);
      }),
  );

  it.effect.each([
    {
      name: "non-loopback tunnel origin",
      origin: { localHttpHost: "172.24.162.233", localHttpPort: 3773 },
      headers: {},
    },
    {
      name: "mismatched port",
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 3774 },
      headers: {},
    },
    {
      name: "forwarded host",
      origin: proofRequest.origin,
      headers: { "x-forwarded-host": "127.0.0.1:3773" },
    },
    {
      name: "forwarded protocol",
      origin: proofRequest.origin,
      headers: { "x-forwarded-proto": "http" },
    },
  ])("rejects $name even for desktop bootstrap", ({ origin, headers }) =>
    Effect.gen(function* () {
      const { post, exchange } = yield* linkProofClient;
      const token = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN);
      const response = yield* post(
        "/api/connect/link-proof",
        { ...proofRequest, origin },
        { ...headers, authorization: `Bearer ${token}` },
      );
      expect(response.status).toBe(400);
      expect(yield* responseJson(response)).toMatchObject({
        message: "Invalid managed endpoint origin.",
      });
    }),
  );

  it.effect("requires relay-write scope even for desktop bootstrap", () =>
    Effect.gen(function* () {
      const { post, exchange } = yield* linkProofClient;
      const token = yield* exchange(DESKTOP_BOOTSTRAP_TOKEN, "relay:read");
      const response = yield* post("/api/connect/link-proof", proofRequest, {
        authorization: `Bearer ${token}`,
      });
      expect(response.status).toBe(403);
      expect(yield* responseJson(response)).toMatchObject({
        code: "insufficient_scope",
        requiredScope: "relay:write",
      });
    }),
  );

  it.effect("rejects unauthenticated requests", () =>
    Effect.gen(function* () {
      const { post } = yield* linkProofClient;
      const response = yield* post("/api/connect/link-proof", proofRequest);
      expect(response.status).toBe(401);
    }),
  );
});
