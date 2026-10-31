import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthMcpClientAccess,
  AuthStandardClientScopes,
  type AuthCreatePairingCredentialInput,
  EnvironmentHttpApi,
  mcpClientScopes,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuth from "./McpOAuth.ts";
import * as McpOAuthHttp from "./mcpOAuthHttp.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

class AuthTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-oauth-test-" });
const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
const makeLayerRoutes = (capture: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => void) =>
  Layer.mergeAll(
    Layer.effectDiscard(
      EnvironmentAuth.EnvironmentAuth.pipe(Effect.tap((auth) => Effect.sync(() => capture(auth)))),
    ),
    HttpApiBuilder.layer(AuthTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(
        McpOAuthHttp.layer.pipe(
          Layer.provide(McpOAuth.layer),
          Layer.provide(ServerSettings.layerTest()),
        ),
      ),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
  ).pipe(
    Layer.provideMerge(layerEnvironmentAuth),
    Layer.provide(layerConfig),
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
const challenge = "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c";

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
    const layerRoutes = makeLayerRoutes((auth) => {
      routerAuth = auth;
    });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (web) =>
        Effect.gen(function* () {
          const handler: Handler = (request) => Effect.promise(() => web.handler(request, context));
          yield* handler(at("/.well-known/oauth-authorization-server"));
          return yield* use(handler, routerAuth!);
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);

const postJson = (path: string, body: unknown, cookie?: string) =>
  at(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: encodeJson(body),
  });

const decide = (
  handler: Handler,
  authorization: Record<string, string>,
  decision: Record<string, string>,
  cookie?: string,
) =>
  handler(postJson("/oauth/mcp/decision", { authorization, decision }, cookie)).pipe(
    Effect.flatMap((response) =>
      json<{ redirectTo?: string; message?: string }>(response).pipe(
        Effect.map((payload) => ({ status: response.status, ...payload })),
      ),
    ),
  );

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

it.live("registers loopback and https clients and never redirects for an unverified client", () =>
  withRoutes((handler) =>
    Effect.gen(function* () {
      for (const refused of [
        "http://bot.example/callback",
        "https://user:pass@bot.example/callback",
        "https://bot.example/callback#",
        "http://localhost/callback#",
        "javascript:alert(1)",
      ]) {
        const response = yield* register(handler, refused);
        expect(response.status).toBe(400);
        expect(yield* json<unknown>(response)).toMatchObject({ error: "invalid_redirect_uri" });
      }

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

      const query = new URLSearchParams(authorizeParams(clientId)).toString();
      const handoff = yield* handler(at(`/oauth/mcp/authorize?${query}`));
      expect(handoff.status).toBe(302);
      expect(handoff.headers.get("location")).toBe(`/connect-agent?${query}`);
      const details = yield* handler(
        postJson("/oauth/mcp/approval", authorizeParams(clientId)),
      ).pipe(Effect.flatMap(json<Record<string, unknown>>));
      expect(details).toEqual({
        clientName: "Claude Code",
        redirectHost: "localhost:51234",
        environmentHost: "box.example.ts.net",
      });

      const forgedDetails = yield* handler(
        postJson("/oauth/mcp/approval", authorizeParams(`${clientId.split(".")[0]}.forged`)),
      );
      expect(forgedDetails.status).toBe(400);
      expect(yield* json<Record<string, unknown>>(forgedDetails)).not.toHaveProperty("redirectTo");
    }),
  ),
);

it.live("signs in with a pairing code and issues a token only /mcp accepts", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const clientId = yield* registeredClientId(handler);
      const pairing = yield* auth.issuePairingCredential();
      const params = authorizeParams(clientId);

      const wrongCode = yield* decide(handler, params, {
        _tag: "pairing-code",
        access: "auto",
        code: "nope",
      });
      expect(wrongCode.status).toBe(400);
      expect(wrongCode.message).toContain("unknown, expired, or already used");

      const approved = yield* decide(handler, params, {
        _tag: "pairing-code",
        access: "auto",
        code: pairing.credential,
      });
      expect(approved.status).toBe(200);
      const callback = new URL(approved.redirectTo!);
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

      expect((yield* exchange(verifier)).status).toBe(400);

      const client = yield* auth.authenticateMcpClient(
        HttpServerRequest.fromWeb(
          at("/mcp", { headers: { authorization: `Bearer ${token.access_token}` } }),
        ),
      );
      expect(client).toMatchObject({ label: "Claude Code", access: "auto" });

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

it.live("signs in a hosted agent with an https callback that asked for a client secret", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const callbackUrl = "https://bot.example/oauth/callback";
      const registered = yield* handler(
        at("/oauth/mcp/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeJson({
            client_name: "Hosted bot",
            redirect_uris: [callbackUrl],
            token_endpoint_auth_method: "client_secret_post",
          }),
        }),
      );
      expect(registered.status).toBe(201);
      const client = (yield* json<unknown>(registered)) as {
        client_id: string;
        token_endpoint_auth_method: string;
      };
      expect(client.token_endpoint_auth_method).toBe("none");

      const params = authorizeParams(client.client_id, callbackUrl);
      const details = yield* handler(postJson("/oauth/mcp/approval", params)).pipe(
        Effect.flatMap(json<Record<string, unknown>>),
      );
      expect(details).toMatchObject({ clientName: "Hosted bot", redirectHost: "bot.example" });

      const pairing = yield* auth.issuePairingCredential();
      const approved = yield* decide(handler, params, {
        _tag: "pairing-code",
        access: "approval-required",
        code: pairing.credential,
      });
      const callback = new URL(approved.redirectTo!);
      expect(`${callback.origin}${callback.pathname}`).toBe(callbackUrl);

      const tokenResponse = yield* handler(
        at(
          "/oauth/mcp/token",
          form({
            grant_type: "authorization_code",
            code: callback.searchParams.get("code")!,
            redirect_uri: callbackUrl,
            client_id: client.client_id,
            client_secret: "unused",
            code_verifier: verifier,
          }),
        ),
      );
      expect(tokenResponse.status).toBe(200);
      const token = (yield* json<unknown>(tokenResponse)) as { access_token: string };
      const signedIn = yield* auth.authenticateMcpClient(
        HttpServerRequest.fromWeb(
          at("/mcp", { headers: { authorization: `Bearer ${token.access_token}` } }),
        ),
      );
      expect(signedIn).toMatchObject({ label: "Hosted bot", access: "approval-required" });
    }),
  ),
);

it.live("rejects a wrong PKCE verifier and spends the code", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const clientId = yield* registeredClientId(handler);
      const pairing = yield* auth.issuePairingCredential();
      const params = authorizeParams(clientId);
      const approved = yield* decide(handler, params, {
        _tag: "pairing-code",
        access: "approval-required",
        code: pairing.credential,
      });
      const code = new URL(approved.redirectTo!).searchParams.get("code")!;
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

it.live(
  "denies and refuses codes bound to another client's key or without the scopes it grants",
  () =>
    withRoutes((handler, auth) =>
      Effect.gen(function* () {
        const clientId = yield* registeredClientId(handler);
        const params = authorizeParams(clientId);

        const denied = yield* decide(handler, params, { _tag: "deny" });
        const deniedUrl = new URL(denied.redirectTo!);
        expect(deniedUrl.searchParams.get("error")).toBe("access_denied");
        expect(deniedUrl.searchParams.get("state")).toBe("state-1");

        const approveWith = (code: string) =>
          decide(handler, params, { _tag: "pairing-code", access: "auto", code });

        const bound = yield* auth.createPairingLink({
          proofKeyThumbprint: "device-key-thumbprint",
        });
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
        expect(readOnlyResponse.message).toContain("cannot grant this access");
        const operator = yield* auth.issuePairingCredential({
          scopes: ["orchestration:read", "orchestration:operate"],
        });
        const operatorFull = yield* decide(handler, params, {
          _tag: "pairing-code",
          access: "full-access",
          code: operator.credential,
        });
        expect(operatorFull.status).toBe(400);

        const readOnlyApproval = yield* decide(handler, params, {
          _tag: "pairing-code",
          access: "read-only",
          code: readOnly.credential,
        });
        expect(readOnlyApproval.status).toBe(200);
        const readOnlyToken = yield* handler(
          at(
            "/oauth/mcp/token",
            form({
              grant_type: "authorization_code",
              code: new URL(readOnlyApproval.redirectTo!).searchParams.get("code")!,
              redirect_uri: params.redirect_uri,
              client_id: clientId,
              code_verifier: verifier,
              resource: `${ORIGIN}/mcp`,
            }),
          ),
        ).pipe(Effect.flatMap(json<{ access_token: string; scope: string }>));
        expect(readOnlyToken.scope).toBe("orchestration:read");
        const readOnlyClient = yield* auth.authenticateMcpClient(
          HttpServerRequest.fromWeb(
            at("/mcp", { headers: { authorization: `Bearer ${readOnlyToken.access_token}` } }),
          ),
        );
        expect(readOnlyClient.access).toBe("read-only");
      }),
    ),
);

it.live("a code minted with an access level's scopes approves that access", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const params = authorizeParams(yield* registeredClientId(handler));
      for (const access of AuthMcpClientAccess.literals) {
        const code = yield* auth.issuePairingCredential({ scopes: [...mcpClientScopes(access)] });
        const approval = yield* decide(handler, params, {
          _tag: "pairing-code",
          access,
          code: code.credential,
        });
        expect(approval.status, access).toBe(200);
      }
    }),
  ),
);

it.live("one-click approves only access the browser session holds the scopes for", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const clientId = yield* registeredClientId(handler);
      const params = authorizeParams(clientId);
      const browserCookie = (scopes: NonNullable<AuthCreatePairingCredentialInput["scopes"]>) =>
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
      const details = (cookie: string) =>
        handler(postJson("/oauth/mcp/approval", params, cookie)).pipe(
          Effect.flatMap(json<{ csrfToken?: string; oneClickAccess?: ReadonlyArray<string> }>),
        );

      const admin = yield* browserCookie([...AuthStandardClientScopes]);
      const adminDetails = yield* details(admin);
      expect(adminDetails.csrfToken).toEqual(expect.any(String));
      expect(adminDetails.oneClickAccess).toEqual([
        "read-only",
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
      const oneClick = yield* decide(
        handler,
        params,
        { _tag: "browser-session", access: "auto", csrfToken: adminDetails.csrfToken! },
        admin,
      );
      expect(new URL(oneClick.redirectTo!).searchParams.get("code")).toEqual(expect.any(String));

      const accessOnly = yield* browserCookie(["access:read", "access:write"]);
      expect((yield* details(accessOnly)).csrfToken).toBeUndefined();
      const forged = yield* decide(
        handler,
        params,
        { _tag: "browser-session", access: "auto", csrfToken: "forged" },
        accessOnly,
      );
      expect(forged.status).toBe(400);
      expect(forged.message).toContain("Enter a pairing code instead");

      const reader = yield* browserCookie(["access:write", "orchestration:read"]);
      const readerDetails = yield* details(reader);
      expect(readerDetails.csrfToken).toEqual(expect.any(String));
      expect(readerDetails.oneClickAccess).toEqual(["read-only"]);
      const tooBroad = yield* decide(
        handler,
        params,
        { _tag: "browser-session", access: "auto", csrfToken: readerDetails.csrfToken! },
        reader,
      );
      expect(tooBroad.status).toBe(400);
      const readOnly = yield* decide(
        handler,
        params,
        { _tag: "browser-session", access: "read-only", csrfToken: readerDetails.csrfToken! },
        reader,
      );
      expect(new URL(readOnly.redirectTo!).searchParams.get("code")).toEqual(expect.any(String));
    }),
  ),
);

it("matches loopback redirects on everything but the port, and https redirects exactly", () => {
  const matches = McpOAuth.redirectMatches;
  expect(matches("http://localhost/callback", "http://localhost:9/callback")).toBe(true);
  expect(matches("http://127.0.0.1:1/callback", "http://127.0.0.1:2/callback")).toBe(true);
  expect(matches("http://localhost/callback", "http://127.0.0.1/callback")).toBe(false);
  expect(matches("http://localhost/callback", "https://localhost/callback")).toBe(false);
  expect(matches("https://bot.example/cb", "https://bot.example/cb")).toBe(true);
  expect(matches("https://bot.example/cb", "https://bot.example:8443/cb")).toBe(false);
  expect(matches("https://bot.example/cb", "https://bot.example/cb?x=1")).toBe(false);
  expect(matches("https://bot.example/cb", "https://evil.example/cb")).toBe(false);
});
