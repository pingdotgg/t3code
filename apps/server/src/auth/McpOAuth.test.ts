import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAdministrativeScopes,
  type AuthEnvironmentScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuth from "./McpOAuth.ts";
import { mcpOAuthRouteLayer } from "./mcpOAuthHttp.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-oauth-test-" });
const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
// Each router gets its own database; the capture hands that router's EnvironmentAuth to its test.
const makeRoutesLayer = (capture: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => void) =>
  Layer.mergeAll(
    mcpOAuthRouteLayer.pipe(Layer.provide(McpOAuth.layer)),
    Layer.effectDiscard(
      EnvironmentAuth.EnvironmentAuth.pipe(Effect.tap((auth) => Effect.sync(() => capture(auth)))),
    ),
    HttpApiBuilder.layer(AuthTestApi).pipe(
      Layer.provide(authHttpApiLayer),
      Layer.provide(environmentAuthenticatedAuthLayer),
    ),
  ).pipe(
    Layer.provideMerge(environmentAuthLayer),
    Layer.provide(configLayer),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ORIGIN = "https://box.example.ts.net";
const REDIRECT = "http://localhost/callback";
const verifier = "a".repeat(43) + "-verifier-for-tests";
const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");

/** Requests as they arrive behind an https proxy: plain http with the public Host. */
const at = (path: string, init?: RequestInit) =>
  new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: { host: "box.example.ts.net", "x-forwarded-proto": "https", ...init?.headers },
  });
const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});

type Handler = (request: Request) => Effect.Effect<Response>;

const withRoutes = <A, E>(
  use: (handler: Handler, auth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const context = Context.make(Crypto.Crypto, crypto);
    let routerAuth: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;
    const routesLayer = makeRoutesLayer((auth) => {
      routerAuth = auth;
    });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
      (web) =>
        Effect.gen(function* () {
          const handler: Handler = (request) => Effect.promise(() => web.handler(request, context));
          // The router builds its layer on first request; a metadata read warms it.
          yield* handler(at("/.well-known/oauth-authorization-server"));
          return yield* use(handler, routerAuth!);
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);
const text = (response: Response) => Effect.promise(() => response.text());

const register = (handler: Handler, redirect = REDIRECT) =>
  handler(
    at("/oauth/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodeJson({
        client_name: "Claude Code",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );

const registeredClientId = (handler: Handler) =>
  register(handler).pipe(
    Effect.flatMap((response) => json<{ client_id: string }>(response)),
    Effect.map((body) => body.client_id),
  );

const authorizeParams = (clientId: string, redirect = "http://localhost:51234/callback") => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirect,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "state-1",
  resource: `${ORIGIN}/mcp`,
});

it.live("derives discovery metadata from the origin the client reached", () =>
  withRoutes((handler) =>
    Effect.gen(function* () {
      const resource = yield* handler(at("/.well-known/oauth-protected-resource/mcp"));
      expect(yield* json<unknown>(resource)).toMatchObject({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
      });
      const server = yield* json<unknown>(
        yield* handler(at("/.well-known/oauth-authorization-server")),
      );
      expect(server).toMatchObject({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/mcp/authorize`,
        token_endpoint: `${ORIGIN}/oauth/mcp/token`,
        registration_endpoint: `${ORIGIN}/oauth/mcp/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }),
  ),
);

it.live("registers only loopback clients and never redirects for an unverified client", () =>
  withRoutes((handler) =>
    Effect.gen(function* () {
      const remote = yield* register(handler, "https://attacker.example/callback");
      expect(remote.status).toBe(400);
      expect(yield* json<unknown>(remote)).toMatchObject({ error: "invalid_redirect_uri" });

      const registered = yield* register(handler);
      expect(registered.status).toBe(201);
      const { client_id: clientId } = (yield* json<unknown>(registered)) as { client_id: string };

      const forged = yield* handler(
        at(
          `/oauth/mcp/authorize?${new URLSearchParams(authorizeParams(`${clientId.split(".")[0]}.forged`))}`,
        ),
      );
      expect(forged.status).toBe(400);
      expect(forged.headers.get("location")).toBeNull();

      const unregistered = yield* handler(
        at(
          `/oauth/mcp/authorize?${new URLSearchParams(
            authorizeParams(clientId, "http://localhost:51234/elsewhere"),
          )}`,
        ),
      );
      expect(unregistered.status).toBe(400);
      expect(unregistered.headers.get("location")).toBeNull();

      const page = yield* handler(
        at(`/oauth/mcp/authorize?${new URLSearchParams(authorizeParams(clientId))}`),
      );
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(yield* text(page)).toContain("Pairing code");
    }),
  ),
);

it.live("signs in with a pairing code and issues a token only /mcp accepts", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const clientId = yield* registeredClientId(handler);
      const pairing = yield* auth.issuePairingCredential();
      const params = authorizeParams(clientId);

      const wrongCode = yield* handler(
        at(
          "/oauth/mcp/authorize",
          form({ ...params, decision: "approve", runtime_mode: "auto", pairing_code: "nope" }),
        ),
      );
      expect(wrongCode.status).toBe(400);
      expect(yield* text(wrongCode)).toContain("unknown, expired, or already used");

      const approved = yield* handler(
        at(
          "/oauth/mcp/authorize",
          form({
            ...params,
            decision: "approve",
            runtime_mode: "auto",
            pairing_code: pairing.credential,
          }),
        ),
      );
      expect(approved.status).toBe(302);
      const callback = new URL(approved.headers.get("location")!);
      expect(callback.origin).toBe("http://localhost:51234");
      expect(callback.searchParams.get("state")).toBe("state-1");
      expect(callback.searchParams.get("iss")).toBe(ORIGIN);
      const code = callback.searchParams.get("code")!;

      const exchange = (codeVerifier: string) =>
        handler(
          at(
            "/oauth/mcp/token",
            form({
              grant_type: "authorization_code",
              code,
              redirect_uri: params.redirect_uri,
              client_id: clientId,
              code_verifier: codeVerifier,
              resource: `${ORIGIN}/mcp`,
            }),
          ),
        );
      const tokenResponse = yield* exchange(verifier);
      expect(tokenResponse.status).toBe(200);
      const token = (yield* json<unknown>(tokenResponse)) as {
        access_token: string;
        scope: string;
      };
      expect(token.scope).toBe("orchestration:read orchestration:operate");

      // Codes are single use.
      expect((yield* exchange(verifier)).status).toBe(400);

      const client = yield* auth.authenticateMcpClient(
        HttpServerRequest.fromWeb(
          at("/mcp", { headers: { authorization: `Bearer ${token.access_token}` } }),
        ),
      );
      expect(client).toMatchObject({ label: "Claude Code", runtimeModeCeiling: "auto" });

      // The same token is refused by the rest of the environment.
      const session = yield* handler(
        at("/api/auth/session", { headers: { authorization: `Bearer ${token.access_token}` } }),
      );
      expect(yield* json<unknown>(session)).toMatchObject({ authenticated: false });
      const ticket = yield* handler(
        at("/api/auth/websocket-ticket", {
          method: "POST",
          headers: { authorization: `Bearer ${token.access_token}` },
        }),
      );
      expect(ticket.status).toBe(401);
    }),
  ),
);

it.live("rejects a wrong PKCE verifier and spends the code", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const clientId = yield* registeredClientId(handler);
      const pairing = yield* auth.issuePairingCredential();
      const params = authorizeParams(clientId);
      const approved = yield* handler(
        at(
          "/oauth/mcp/authorize",
          form({
            ...params,
            decision: "approve",
            runtime_mode: "approval-required",
            pairing_code: pairing.credential,
          }),
        ),
      );
      const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
      const exchange = (codeVerifier: string) =>
        handler(
          at(
            "/oauth/mcp/token",
            form({
              grant_type: "authorization_code",
              code,
              redirect_uri: params.redirect_uri,
              client_id: clientId,
              code_verifier: codeVerifier,
            }),
          ),
        );
      const wrong = yield* exchange("b".repeat(64));
      expect(wrong.status).toBe(400);
      expect(yield* json<unknown>(wrong)).toMatchObject({ error: "invalid_grant" });
      expect((yield* exchange(verifier)).status).toBe(400);
    }),
  ),
);

it.live("denies and refuses codes bound to another client's key or without thread scopes", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const clientId = yield* registeredClientId(handler);
      const params = authorizeParams(clientId);

      const denied = yield* handler(
        at("/oauth/mcp/authorize", form({ ...params, decision: "deny" })),
      );
      expect(denied.status).toBe(302);
      const deniedUrl = new URL(denied.headers.get("location")!);
      expect(deniedUrl.searchParams.get("error")).toBe("access_denied");
      expect(deniedUrl.searchParams.get("state")).toBe("state-1");

      const approveWith = (code: string) =>
        handler(
          at(
            "/oauth/mcp/authorize",
            form({ ...params, decision: "approve", runtime_mode: "auto", pairing_code: code }),
          ),
        );

      // A T3 Connect code is bound to a device key: refused, and still usable by its device.
      const bound = yield* auth.createPairingLink({ proofKeyThumbprint: "device-key-thumbprint" });
      expect((yield* approveWith(bound.credential)).status).toBe(400);
      const stillValid = yield* auth
        .exchangeBootstrapCredentialForAccessToken(
          bound.credential,
          undefined,
          { deviceType: "mobile" },
          { proofKeyThumbprint: "device-key-thumbprint" },
        )
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      expect(stillValid).toBe(true);

      const readOnly = yield* auth.issuePairingCredential({ scopes: ["orchestration:read"] });
      const readOnlyResponse = yield* approveWith(readOnly.credential);
      expect(readOnlyResponse.status).toBe(400);
      expect(yield* text(readOnlyResponse)).toContain("cannot control threads");
    }),
  ),
);

it.live("offers one-click only to a browser session that holds the scopes it would grant", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const clientId = yield* registeredClientId(handler);
      const params = authorizeParams(clientId);
      // Signs a browser in through the real route and returns its session cookie.
      const browserCookie = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
        Effect.gen(function* () {
          const pairing = yield* auth.issuePairingCredential({ scopes });
          const response = yield* handler(
            at("/api/auth/browser-session", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encodeJson({ credential: pairing.credential }),
            }),
          );
          return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
        });
      const page = (cookie: string) =>
        handler(
          at(`/oauth/mcp/authorize?${new URLSearchParams(params)}`, { headers: { cookie } }),
        ).pipe(Effect.flatMap(text));

      const admin = yield* browserCookie([...AuthAdministrativeScopes]);
      expect(yield* page(admin)).toContain('name="csrf_token"');

      // access:write alone cannot hand an agent thread control it does not hold.
      const accessOnly = yield* browserCookie(["access:read", "access:write"]);
      expect(yield* page(accessOnly)).not.toContain('name="csrf_token"');
      const forged = yield* handler(
        at("/oauth/mcp/authorize", {
          ...form({ ...params, decision: "approve", runtime_mode: "auto", csrf_token: "forged" }),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: accessOnly,
          },
        }),
      );
      expect(forged.status).toBe(400);
      expect(yield* text(forged)).toContain("Enter a pairing code instead");
    }),
  ),
);

it("matches loopback redirects on everything but the port", () => {
  expect(
    McpOAuth.loopbackRedirectMatches("http://localhost/callback", "http://localhost:9/callback"),
  ).toBe(true);
  expect(
    McpOAuth.loopbackRedirectMatches("http://127.0.0.1:1/callback", "http://127.0.0.1:2/callback"),
  ).toBe(true);
  expect(
    McpOAuth.loopbackRedirectMatches("http://localhost/callback", "http://127.0.0.1/callback"),
  ).toBe(false);
  expect(
    McpOAuth.loopbackRedirectMatches("http://localhost/callback", "https://localhost/callback"),
  ).toBe(false);
});
