// @effect-diagnostics nodeBuiltinImport:off -- Local mock GitHub OAuth & REST API server for Phase 7b tests.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeEffectCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentId,
  IsoDateTime,
  ProviderSessionId,
  TeamEnvironmentRecordId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { describe, expect, it } from "@effect/vitest";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as TeamAssetsRepository from "./TeamAssetsRepository.ts";
import * as TeamGitHubBroker from "./TeamGitHubBroker.ts";
import * as TeamGitHubHttp from "./githubBrokerHttp.ts";
import * as TeamGitHubRepository from "./TeamGitHubRepository.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";

interface MockOAuthGitHubServer {
  readonly baseUrl: string;
  readonly refreshHits: () => number;
  readonly tokenExchangeBodies: () => ReadonlyArray<Record<string, string>>;
  readonly setRefreshRevoked: (revoked: boolean) => void;
  readonly setRefreshMode: (
    mode: "normal" | "revoked" | "transient_503" | "rate_limit_403" | "redirect_302",
  ) => void;
  readonly setDeviceVerificationOverride: (
    override: {
      readonly verificationUri?: string;
      readonly verificationUriComplete?: string;
    } | null,
  ) => void;
  readonly registerPat: (
    token: string,
    user: { readonly login: string; readonly name: string; readonly email: string },
  ) => void;
  readonly holdNextRefresh: () => {
    readonly entered: Promise<void>;
    readonly release: () => void;
  };
  readonly holdNextDevicePoll: () => {
    readonly entered: Promise<void>;
    readonly release: () => void;
  };
  readonly setNextExpiresIn: (seconds: number) => void;
  readonly authorizeDeviceCode: (userCode: string, login?: string) => void;
  readonly setDeviceNextError: (userCode: string, error: string | null) => void;
  readonly registerAuthCode: (input: {
    readonly code: string;
    readonly codeChallenge: string;
    readonly login: string;
    readonly name: string;
    readonly email: string;
    readonly expiresIn?: number;
    readonly withRefreshToken?: boolean;
  }) => void;
  readonly close: () => Promise<void>;
}

function startMockOAuthGitHubServer(): Promise<MockOAuthGitHubServer> {
  const usersByToken = new Map<
    string,
    { readonly id: number; readonly login: string; readonly name: string; readonly email: string }
  >();
  const authCodes = new Map<
    string,
    {
      readonly codeChallenge: string;
      readonly login: string;
      readonly name: string;
      readonly email: string;
      readonly expiresIn: number;
      readonly withRefreshToken: boolean;
    }
  >();
  const activeRefreshTokens = new Map<
    string,
    { readonly login: string; readonly name: string; readonly email: string }
  >();
  const deviceCodes = new Map<
    string,
    {
      readonly deviceCode: string;
      readonly userCode: string;
      authorizedLogin: string | null;
      nextError: string | null;
    }
  >();

  let tokenSeq = 0;
  let refreshHits = 0;
  let refreshMode: "normal" | "revoked" | "transient_503" | "rate_limit_403" | "redirect_302" =
    "normal";
  let deviceVerificationOverride: {
    readonly verificationUri?: string;
    readonly verificationUriComplete?: string;
  } | null = null;
  let pendingRefreshGate: {
    readonly onEntered: () => void;
    readonly waitRelease: Promise<void>;
  } | null = null;
  let pendingDevicePollGate: {
    readonly onEntered: () => void;
    readonly waitRelease: Promise<void>;
  } | null = null;
  let nextExpiresIn = 28_800;
  const tokenExchangeBodies: Array<Record<string, string>> = [];

  const mintTokenPair = (
    user: { readonly login: string; readonly name: string; readonly email: string },
    options?: { readonly expiresIn?: number; readonly withRefreshToken?: boolean },
  ) => {
    tokenSeq += 1;
    const accessToken = `ghu_access_${user.login}_${tokenSeq}`;
    usersByToken.set(accessToken, {
      id: 1000 + tokenSeq,
      login: user.login,
      name: user.name,
      email: user.email,
    });
    const withRefresh = options?.withRefreshToken ?? true;
    const refreshToken = withRefresh ? `ghr_refresh_${user.login}_${tokenSeq}` : undefined;
    if (refreshToken) {
      activeRefreshTokens.set(refreshToken, user);
    }
    return {
      access_token: accessToken,
      token_type: "bearer",
      ...(options?.expiresIn !== undefined ? { expires_in: options.expiresIn } : {}),
      ...(refreshToken
        ? {
            refresh_token: refreshToken,
            refresh_token_expires_in: 15_897_600,
          }
        : {}),
    };
  };

  return new Promise((resolve, reject) => {
    const server = NodeHttp.createServer((req, res) => {
      const chunks: Array<Buffer> = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const pathname = (req.url ?? "/").split("?")[0] ?? "/";

        if (req.method === "POST" && pathname === "/login/device/code") {
          const params = Object.fromEntries(new URLSearchParams(bodyText).entries());
          if (!params.client_id) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "incorrect_client_credentials" }));
            return;
          }
          tokenSeq += 1;
          const deviceCode = `dev_code_${tokenSeq}`;
          const userCode = `ABCD-${String(1000 + tokenSeq).slice(-4)}`;
          deviceCodes.set(deviceCode, {
            deviceCode,
            userCode,
            authorizedLogin: null,
            nextError: "authorization_pending",
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              device_code: deviceCode,
              user_code: userCode,
              verification_uri:
                deviceVerificationOverride?.verificationUri ??
                `http://127.0.0.1:${(server.address() as { port: number }).port}/login/device`,
              ...(deviceVerificationOverride?.verificationUriComplete !== undefined
                ? { verification_uri_complete: deviceVerificationOverride.verificationUriComplete }
                : {}),
              expires_in: 900,
              interval: 1,
            }),
          );
          return;
        }

        if (req.method === "POST" && pathname === "/login/oauth/access_token") {
          const params = Object.fromEntries(new URLSearchParams(bodyText).entries());
          tokenExchangeBodies.push(params);

          // 1. Refresh token grant (single-use rotation!)
          if (params.grant_type === "refresh_token") {
            const respond = () => {
              refreshHits += 1;
              if (refreshMode === "redirect_302") {
                res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
                res.end();
                return;
              }
              if (refreshMode === "transient_503") {
                res.writeHead(503, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    error: "temporarily_unavailable",
                    error_description: "GitHub is temporarily unavailable.",
                  }),
                );
                return;
              }
              if (refreshMode === "rate_limit_403") {
                res.writeHead(403, { "content-type": "application/json" });
                res.end(JSON.stringify({ message: "API rate limit exceeded" }));
                return;
              }
              if (refreshMode === "revoked") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    error: "bad_refresh_token",
                    error_description: "The refresh token passed is incorrect or expired.",
                  }),
                );
                return;
              }
              const oldRt = params.refresh_token ?? "";
              const owner = activeRefreshTokens.get(oldRt);
              if (!owner) {
                // Single-use enforcement: reusing an already-rotated refresh token fails!
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({
                    error: "bad_refresh_token",
                    error_description: "Refresh token already used or invalid.",
                  }),
                );
                return;
              }
              activeRefreshTokens.delete(oldRt);
              const pair = mintTokenPair(owner, {
                expiresIn: nextExpiresIn,
                withRefreshToken: true,
              });
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify(pair));
            };
            const gate = pendingRefreshGate;
            if (gate !== null) {
              pendingRefreshGate = null;
              gate.onEntered();
              void gate.waitRelease.then(respond);
            } else {
              respond();
            }
            return;
          }

          // 2. Device code grant
          if (params.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
            const respondDevice = () => {
              const entry = deviceCodes.get(params.device_code ?? "");
              if (!entry) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "incorrect_device_code" }));
                return;
              }
              if (entry.nextError !== null) {
                const err = entry.nextError;
                if (err === "slow_down") {
                  entry.nextError = "authorization_pending";
                  res.writeHead(200, { "content-type": "application/json" });
                  res.end(JSON.stringify({ error: "slow_down", interval: 6 }));
                  return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: err }));
                return;
              }
              if (entry.authorizedLogin) {
                deviceCodes.delete(entry.deviceCode);
                const pair = mintTokenPair(
                  {
                    login: entry.authorizedLogin,
                    name: `${entry.authorizedLogin} Device`,
                    email: `${entry.authorizedLogin}@device.example`,
                  },
                  { expiresIn: nextExpiresIn, withRefreshToken: true },
                );
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(pair));
                return;
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "authorization_pending" }));
            };
            const gate = pendingDevicePollGate;
            if (gate !== null) {
              pendingDevicePollGate = null;
              gate.onEntered();
              void gate.waitRelease.then(respondDevice);
            } else {
              respondDevice();
            }
            return;
          }

          // 3. Authorization code + PKCE S256 grant
          const code = params.code ?? "";
          const entry = authCodes.get(code);
          if (!entry) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: "bad_verification_code",
                error_description: "The code passed is incorrect or expired.",
              }),
            );
            return;
          }
          authCodes.delete(code);
          const verifier = params.code_verifier ?? "";
          const computedChallenge = NodeCrypto.createHash("sha256")
            .update(verifier, "ascii")
            .digest("base64url");
          if (computedChallenge !== entry.codeChallenge) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "PKCE code_verifier mismatch.",
              }),
            );
            return;
          }
          const pair = mintTokenPair(
            { login: entry.login, name: entry.name, email: entry.email },
            { expiresIn: entry.expiresIn, withRefreshToken: entry.withRefreshToken },
          );
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(pair));
          return;
        }

        // REST API (/user, /user/emails)
        const auth = req.headers.authorization ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
        const user = usersByToken.get(token);
        if (!user) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "Bad credentials" }));
          return;
        }
        if (pathname === "/user") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: user.id, login: user.login, name: user.name, email: null }));
          return;
        }
        if (pathname === "/user/emails") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify([{ email: user.email, primary: true, verified: true }]));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Not found" }));
      });
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        refreshHits: () => refreshHits,
        tokenExchangeBodies: () => [...tokenExchangeBodies],
        setRefreshRevoked: (v) => {
          refreshMode = v ? "revoked" : "normal";
        },
        setRefreshMode: (mode) => {
          refreshMode = mode;
        },
        setDeviceVerificationOverride: (override) => {
          deviceVerificationOverride = override;
        },
        registerPat: (token, user) => {
          tokenSeq += 1;
          usersByToken.set(token, {
            id: 2000 + tokenSeq,
            login: user.login,
            name: user.name,
            email: user.email,
          });
        },
        holdNextRefresh: () => {
          let onEntered!: () => void;
          let release!: () => void;
          const entered = new Promise<void>((r) => {
            onEntered = r;
          });
          const waitRelease = new Promise<void>((r) => {
            release = r;
          });
          pendingRefreshGate = { onEntered, waitRelease };
          return { entered, release };
        },
        holdNextDevicePoll: () => {
          let onEntered!: () => void;
          let release!: () => void;
          const entered = new Promise<void>((r) => {
            onEntered = r;
          });
          const waitRelease = new Promise<void>((r) => {
            release = r;
          });
          pendingDevicePollGate = { onEntered, waitRelease };
          return { entered, release };
        },
        setNextExpiresIn: (s) => {
          nextExpiresIn = s;
        },
        authorizeDeviceCode: (userCode, login = "alice-dev") => {
          for (const entry of deviceCodes.values()) {
            if (entry.userCode === userCode) {
              entry.authorizedLogin = login;
              entry.nextError = null;
            }
          }
        },
        setDeviceNextError: (userCode, error) => {
          for (const entry of deviceCodes.values()) {
            if (entry.userCode === userCode) {
              entry.nextError = error;
            }
          }
        },
        registerAuthCode: (spec) => {
          authCodes.set(spec.code, {
            codeChallenge: spec.codeChallenge,
            login: spec.login,
            name: spec.name,
            email: spec.email,
            expiresIn: spec.expiresIn ?? 28_800,
            withRefreshToken: spec.withRefreshToken ?? true,
          });
        },
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

function swapAllowedGitHubOriginsEnv(value: string | undefined): string | undefined {
  const prev = process.env.T3_TEAM_GITHUB_ALLOWED_API_ORIGINS;
  if (value === undefined) {
    delete process.env.T3_TEAM_GITHUB_ALLOWED_API_ORIGINS;
  } else {
    process.env.T3_TEAM_GITHUB_ALLOWED_API_ORIGINS = value;
  }
  return prev;
}

function makeFullTestLayer() {
  const platform = Layer.mergeAll(
    NodeServices.layer,
    NodeEffectCrypto.layer,
    FetchHttpClient.layer,
  );
  const base = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-team-gh-oauth-test-",
  }).pipe(Layer.provideMerge(platform));
  const persistence = SqlitePersistence.layerMemory.pipe(Layer.provide(base));
  const secrets = ServerSecretStore.layer.pipe(Layer.provide(base));
  const authSessions = AuthSessions.layer.pipe(Layer.provide(persistence));
  const serverEnv = ServerEnvironment.layer.pipe(Layer.provide(secrets), Layer.provide(base));
  const sessions = SessionStore.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(persistence, secrets, authSessions, serverEnv)),
    Layer.provide(base),
  );
  const envAuth = EnvironmentAuth.layer.pipe(
    Layer.provideMerge(sessions),
    Layer.provideMerge(secrets),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(base),
  );
  const teamRepo = TeamRepository.layer.pipe(Layer.provide(persistence));
  const assetsRepo = TeamAssetsRepository.layer.pipe(Layer.provide(persistence));
  const githubRepo = TeamGitHubRepository.layer.pipe(Layer.provide(persistence));
  const teamService = TeamService.layer.pipe(
    Layer.provideMerge(teamRepo),
    Layer.provideMerge(assetsRepo),
    Layer.provideMerge(githubRepo),
    Layer.provideMerge(sessions),
    Layer.provideMerge(authSessions),
    Layer.provideMerge(secrets),
    Layer.provideMerge(serverEnv),
    Layer.provideMerge(base),
  );
  return Layer.mergeAll(TeamGitHubBroker.layer.pipe(Layer.provideMerge(teamService)), envAuth);
}

describe("TeamGitHubOAuth (Phase 7b)", () => {
  it.live(
    "enforces admin-only app config, encrypts client_secret, completes PKCE S256 browser callback, and rejects replayed state",
    () =>
      Effect.gen(function* () {
        const mockGitHub = yield* Effect.acquireRelease(
          Effect.promise(() => startMockOAuthGitHubServer()),
          (m) => Effect.promise(() => m.close()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => swapAllowedGitHubOriginsEnv(mockGitHub.baseUrl)),
          (prev) =>
            Effect.sync(() => {
              swapAllowedGitHubOriginsEnv(prev);
            }),
        );

        const team = yield* TeamService.TeamService;
        const sessionStore = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;

        const aliceSession = yield* sessionStore.issue({
          subject: "alice",
          scopes: ["orchestration:read", "orchestration:operate", "access:write"],
          client: { label: "Alice", deviceType: "desktop", os: "linux" },
        });
        yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Acme OAuth", ownerPseudo: "alice" },
        });
        const invite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob" },
        });
        const bobJoined = yield* team.redeemInvite({
          token: invite.token,
          pseudo: "bob",
          client: { label: "Bob", deviceType: "desktop", os: "linux" },
        });
        const bobSessionRows = yield* sql<{ readonly session_id: string }>`
          SELECT session_id FROM team_session_meta WHERE member_id = ${bobJoined.member.id} LIMIT 1
        `;
        const bobSessionId = AuthSessionId.make(bobSessionRows[0]!.session_id);

        // Regular member cannot configure or clear GitHub App config.
        const bobSetRes = yield* Effect.result(
          team.setGitHubAppConfig({
            sessionId: bobSessionId,
            payload: {
              mode: "github_app",
              clientId: "Iv1.evil",
            },
          }),
        );
        expect(bobSetRes._tag).toBe("Failure");
        if (bobSetRes._tag === "Failure") {
          expect(bobSetRes.failure.code).toBe("forbidden");
        }

        // Rejects SSRF / private IP / trailing-dot localhost / plain HTTP when not allowlisted.
        const ssrfRes = yield* Effect.result(
          team.setGitHubAppConfig({
            sessionId: aliceSession.sessionId,
            payload: {
              mode: "github_app",
              clientId: "Iv1.ssrf",
              webBaseUrl: "http://169.254.169.254",
              apiBaseUrl: "http://169.254.169.254",
            },
          }),
        );
        expect(ssrfRes._tag).toBe("Failure");
        const trailingDotLocalhostRes = yield* Effect.result(
          team.setGitHubAppConfig({
            sessionId: aliceSession.sessionId,
            payload: {
              mode: "github_app",
              clientId: "Iv1.ssrf2",
              webBaseUrl: "https://localhost.",
              apiBaseUrl: "https://api.localhost.",
            },
          }),
        );
        expect(trailingDotLocalhostRes._tag).toBe("Failure");

        // Owner configures GitHub App OAuth with client_secret (encrypted in ServerSecretStore).
        const savedConfig = yield* team.setGitHubAppConfig({
          sessionId: aliceSession.sessionId,
          payload: {
            mode: "github_app",
            clientId: "Iv1.acme1234",
            clientSecret: "SUPER_SECRET_CLIENT_KEY",
            webBaseUrl: mockGitHub.baseUrl,
            apiBaseUrl: mockGitHub.baseUrl,
            enabled: true,
          },
        });
        expect(savedConfig.mode).toBe("github_app");
        expect(savedConfig.clientId).toBe("Iv1.acme1234");
        expect(savedConfig.hasClientSecret).toBe(true);
        expect(JSON.stringify(savedConfig)).not.toContain("SUPER_SECRET_CLIENT_KEY");

        // Regular member sees safe public status metadata, never clientSecret or updatedByMemberId.
        const bobState = yield* team.getState(bobSessionId);
        expect(bobState.githubAppConfig).toMatchObject({
          enabled: true,
          mode: "github_app",
          clientId: "Iv1.acme1234",
          hasClientSecret: true,
        });
        expect(bobState.githubAppConfig?.updatedByMemberId).toBeUndefined();
        expect(JSON.stringify(bobState)).not.toContain("SUPER_SECRET_CLIENT_KEY");

        const started = yield* team.startGitHubOAuth({
          sessionId: bobSessionId,
          payload: { redirectBaseUrl: "http://127.0.0.1:41999" },
        });
        const authUrl = new URL(started.authorizeUrl);
        expect(authUrl.pathname).toBe("/login/oauth/authorize");
        expect(authUrl.searchParams.get("client_id")).toBe("Iv1.acme1234");
        expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authUrl.searchParams.get("scope")).toBeNull();
        expect(authUrl.searchParams.get("redirect_uri")).toBe(
          "http://127.0.0.1:41999/api/team/github/oauth/callback",
        );
        const challenge = authUrl.searchParams.get("code_challenge")!;
        expect(challenge.length).toBeGreaterThan(20);

        mockGitHub.registerAuthCode({
          code: "code_bob_1",
          codeChallenge: challenge,
          login: "bob-oauth",
          name: "Bob OAuth",
          email: "bob@oauth.example",
          expiresIn: 28_800,
          withRefreshToken: true,
        });

        // Drive the real HTTP route GET /api/team/github/oauth/callback.
        const testContext = yield* Effect.context<
          | TeamService.TeamService
          | TeamRepository.TeamRepository
          | TeamGitHubBroker.TeamGitHubBroker
          | EnvironmentAuth.EnvironmentAuth
        >();
        const { handler, dispose } = HttpRouter.toWebHandler(
          TeamGitHubHttp.layer.pipe(Layer.provideMerge(Layer.succeedContext(testContext))),
          { disableLogger: true },
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));

        // Cross-session protection: Alice's cookie hitting Bob's callback MUST fail closed with 403.
        const startedCross = yield* team.startGitHubOAuth({
          sessionId: bobSessionId,
          payload: { redirectBaseUrl: "http://127.0.0.1:41999" },
        });
        const crossSessionRes = yield* Effect.promise(() =>
          handler(
            new Request(
              `http://127.0.0.1:41999/api/team/github/oauth/callback?code=code_bob_1&state=${encodeURIComponent(startedCross.state)}`,
              {
                method: "GET",
                headers: {
                  cookie: `${sessionStore.cookieName}=${aliceSession.token}`,
                },
              },
            ),
          ),
        );
        expect(crossSessionRes.status).toBe(403);
        expect((yield* team.getState(bobSessionId)).myGitHubIdentity).toBeNull();

        // Callback error with untrusted HTML payload is escaped safely (XSS protection).
        const startedErr = yield* team.startGitHubOAuth({
          sessionId: bobSessionId,
          payload: { redirectBaseUrl: "http://127.0.0.1:41999" },
        });
        const errRes = yield* Effect.promise(() =>
          handler(
            new Request(
              `http://127.0.0.1:41999/api/team/github/oauth/callback?error=access_denied&error_description=${encodeURIComponent("<script>alert(1)</script>")}&state=${encodeURIComponent(startedErr.state)}`,
              { method: "GET" },
            ),
          ),
        );
        expect(errRes.status).toBe(502);
        const errHtml = yield* Effect.promise(() => errRes.text());
        expect(errHtml).not.toContain("<script>");
        expect(errHtml).toContain("&lt;script&gt;");

        // Unauthenticated callback (no cookie, e.g., external browser or phishing link) NEVER attaches
        // credentials on GET; it requires authenticated confirmation by the initiating session.
        const startedUnauth = yield* team.startGitHubOAuth({
          sessionId: bobSessionId,
          payload: { redirectBaseUrl: "http://127.0.0.1:41999" },
        });
        const unauthChallenge = new URL(startedUnauth.authorizeUrl).searchParams.get(
          "code_challenge",
        )!;
        mockGitHub.registerAuthCode({
          code: "code_bob_confirm",
          codeChallenge: unauthChallenge,
          login: "bob-confirmed",
          name: "Bob Confirmed",
          email: "bob-confirmed@oauth.example",
          expiresIn: 28_800,
          withRefreshToken: true,
        });
        const unauthRes = yield* Effect.promise(() =>
          handler(
            new Request(
              `http://127.0.0.1:41999/api/team/github/oauth/callback?code=code_bob_confirm&state=${encodeURIComponent(startedUnauth.state)}`,
              { method: "GET" },
            ),
          ),
        );
        expect(unauthRes.status).toBe(200);
        const unauthHtml = yield* Effect.promise(() => unauthRes.text());
        expect(unauthHtml).toContain("Confirmation required");
        const confirmCodeMatch = /data-testid="github-oauth-confirmation-code">([^<]+)</.exec(
          unauthHtml,
        );
        expect(confirmCodeMatch?.[1]).toBeTruthy();
        const confirmCode = confirmCodeMatch![1]!;
        // Credentials are NOT attached before authenticated confirmation!
        expect((yield* team.getState(bobSessionId)).myGitHubIdentity).toBeNull();
        // Another member (Alice) cannot confirm Bob's pending OAuth flow.
        const aliceStealConfirm = yield* Effect.result(
          team.completeGitHubOAuth({
            sessionId: aliceSession.sessionId,
            payload: { state: startedUnauth.state, confirmationCode: confirmCode },
          }),
        );
        expect(aliceStealConfirm._tag).toBe("Failure");
        if (aliceStealConfirm._tag === "Failure") {
          expect(aliceStealConfirm.failure.code).toBe("forbidden");
        }
        // Bob confirming with a wrong code burns the single-attempt confirmation record.
        const wrongCodeRes = yield* Effect.result(
          team.completeGitHubOAuth({
            sessionId: bobSessionId,
            payload: { state: startedUnauth.state, confirmationCode: "ZZZZ-ZZZZ" },
          }),
        );
        expect(wrongCodeRes._tag).toBe("Failure");
        const replayAfterWrong = yield* Effect.result(
          team.completeGitHubOAuth({
            sessionId: bobSessionId,
            payload: { state: startedUnauth.state, confirmationCode: confirmCode },
          }),
        );
        expect(replayAfterWrong._tag).toBe("Failure");

        // Fresh unauthenticated callback confirmed by Bob's authenticated session succeeds (desktop/DPoP flow).
        const startedDesktopConfirm = yield* team.startGitHubOAuth({
          sessionId: bobSessionId,
          payload: { redirectBaseUrl: "http://127.0.0.1:41999" },
        });
        mockGitHub.registerAuthCode({
          code: "code_bob_desktop_ok",
          codeChallenge: new URL(startedDesktopConfirm.authorizeUrl).searchParams.get(
            "code_challenge",
          )!,
          login: "bob-desktop-oauth",
          name: "Bob Desktop",
          email: "bob-desktop@oauth.example",
          expiresIn: 28_800,
          withRefreshToken: true,
        });
        const desktopCbRes = yield* Effect.promise(() =>
          handler(
            new Request(
              `http://127.0.0.1:41999/api/team/github/oauth/callback?code=code_bob_desktop_ok&state=${encodeURIComponent(startedDesktopConfirm.state)}`,
              { method: "GET" },
            ),
          ),
        );
        expect(desktopCbRes.status).toBe(200);
        const desktopConfirmCode = /data-testid="github-oauth-confirmation-code">([^<]+)</.exec(
          yield* Effect.promise(() => desktopCbRes.text()),
        )![1]!;
        const confirmedIdentity = yield* team.completeGitHubOAuth({
          sessionId: bobSessionId,
          payload: {
            state: startedDesktopConfirm.state,
            confirmationCode: desktopConfirmCode,
          },
        });
        expect(confirmedIdentity.githubLogin).toBe("bob-desktop-oauth");
        expect(confirmedIdentity.hasRefreshToken).toBe(true);

        // Subscribe Bob to live events before completing same-session cookie browser OAuth callback.
        const bobEventFiber = yield* team.streamState(bobSessionId).pipe(
          Stream.filter((ev) => ev.type === "myGitHubIdentityUpdated"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );

        // Same-session browser cookie completes immediately in 1 click!
        const callbackRes = yield* Effect.promise(() =>
          handler(
            new Request(
              `http://127.0.0.1:41999/api/team/github/oauth/callback?code=code_bob_1&state=${encodeURIComponent(started.state)}`,
              {
                method: "GET",
                headers: {
                  cookie: `${sessionStore.cookieName}=${bobJoined.accessToken}`,
                },
              },
            ),
          ),
        );
        expect(callbackRes.status).toBe(200);
        expect(callbackRes.headers.get("cache-control")).toBe("no-store");
        expect(callbackRes.headers.get("content-security-policy")).toContain("default-src 'none'");
        const html = yield* Effect.promise(() => callbackRes.text());
        expect(html).toContain("Connected as @bob-oauth");

        // Verify token exchange received PKCE code_verifier + decrypted client_secret.
        const exchanges = mockGitHub.tokenExchangeBodies();
        expect(exchanges[0]?.client_secret).toBe("SUPER_SECRET_CLIENT_KEY");
        expect(exchanges[0]?.code_verifier?.length).toBeGreaterThan(20);

        // Live event was pushed to Bob's stream without exposing tokens.
        const received = yield* Fiber.join(bobEventFiber);
        expect(received.length).toBe(1);
        const updatedEvent = received[0]!;
        expect(updatedEvent.type).toBe("myGitHubIdentityUpdated");
        if (updatedEvent.type === "myGitHubIdentityUpdated") {
          expect(updatedEvent.payload.identity?.githubLogin).toBe("bob-oauth");
          expect(updatedEvent.payload.identity?.authMethod).toBe("github_app");
          expect(updatedEvent.payload.identity?.hasRefreshToken).toBe(true);
          expect(updatedEvent.payload.identity?.needsReconnect).toBeUndefined();
          expect(JSON.stringify(updatedEvent)).not.toContain("ghu_");
          expect(JSON.stringify(updatedEvent)).not.toContain("ghr_");
        }

        // Replaying the same single-use state MUST be rejected (HTTP 400).
        const replayRes = yield* Effect.promise(() =>
          handler(
            new Request(
              `http://127.0.0.1:41999/api/team/github/oauth/callback?code=code_bob_1&state=${encodeURIComponent(started.state)}`,
              { method: "GET" },
            ),
          ),
        );
        expect(replayRes.status).toBe(400);

        // Clearing app config removes secret and publishes null.
        const cleared = yield* team.clearGitHubAppConfig({ sessionId: aliceSession.sessionId });
        expect(cleared.cleared).toBe(true);
        const afterClear = yield* team.getState(bobSessionId);
        expect(afterClear.githubAppConfig).toBeNull();
      }).pipe(Effect.provide(makeFullTestLayer())),
  );

  it.live(
    "completes RFC 8628 device code flow with authorization_pending, slow_down, cross-member isolation, and denied handling",
    () =>
      Effect.gen(function* () {
        const mockGitHub = yield* Effect.acquireRelease(
          Effect.promise(() => startMockOAuthGitHubServer()),
          (m) => Effect.promise(() => m.close()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => swapAllowedGitHubOriginsEnv(mockGitHub.baseUrl)),
          (prev) =>
            Effect.sync(() => {
              swapAllowedGitHubOriginsEnv(prev);
            }),
        );

        const team = yield* TeamService.TeamService;
        const sessionStore = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;

        const aliceSession = yield* sessionStore.issue({
          subject: "alice",
          scopes: ["orchestration:read", "orchestration:operate", "access:write"],
          client: { label: "Alice", deviceType: "desktop", os: "linux" },
        });
        yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Acme Device", ownerPseudo: "alice" },
        });
        const invite = yield* team.createInvite({
          sessionId: aliceSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob" },
        });
        const bobJoined = yield* team.redeemInvite({
          token: invite.token,
          pseudo: "bob",
          client: { label: "Bob", deviceType: "desktop", os: "linux" },
        });
        const bobSessionRows = yield* sql<{ readonly session_id: string }>`
          SELECT session_id FROM team_session_meta WHERE member_id = ${bobJoined.member.id} LIMIT 1
        `;
        const bobSessionId = AuthSessionId.make(bobSessionRows[0]!.session_id);

        yield* team.setGitHubAppConfig({
          sessionId: aliceSession.sessionId,
          payload: {
            mode: "github_app",
            clientId: "Iv1.device123",
            webBaseUrl: mockGitHub.baseUrl,
            apiBaseUrl: mockGitHub.baseUrl,
            enabled: true,
          },
        });

        const started = yield* team.startGitHubDeviceFlow({
          sessionId: aliceSession.sessionId,
          payload: {},
        });
        expect(started.userCode).toMatch(/^ABCD-\d{4}$/);
        expect(started.deviceFlowId.startsWith("ghdev_")).toBe(true);

        // Bob cannot poll Alice's device flow.
        const bobHijack = yield* Effect.result(
          team.pollGitHubDeviceFlow({
            sessionId: bobSessionId,
            payload: { deviceFlowId: started.deviceFlowId },
          }),
        );
        expect(bobHijack._tag).toBe("Failure");

        // Poll 1: authorization_pending; immediate repeat poll is locally throttled to pending.
        const poll1 = yield* team.pollGitHubDeviceFlow({
          sessionId: aliceSession.sessionId,
          payload: { deviceFlowId: started.deviceFlowId },
        });
        expect(poll1.status).toBe("pending");
        const pollThrottled = yield* team.pollGitHubDeviceFlow({
          sessionId: aliceSession.sessionId,
          payload: { deviceFlowId: started.deviceFlowId },
        });
        expect(pollThrottled.status).toBe("pending");

        // Start a fresh flow and trigger RFC 8628 slow_down -> interval increases to 6s without sleeping.
        const startedSlow = yield* team.startGitHubDeviceFlow({
          sessionId: aliceSession.sessionId,
          payload: {},
        });
        mockGitHub.setDeviceNextError(startedSlow.userCode, "slow_down");
        const pollSlow = yield* team.pollGitHubDeviceFlow({
          sessionId: aliceSession.sessionId,
          payload: { deviceFlowId: startedSlow.deviceFlowId },
        });
        expect(pollSlow.status).toBe("pending");
        expect(pollSlow.intervalSeconds).toBe(6);

        // Start a second device flow to test immediate completion after user authorizes.
        const started2 = yield* team.startGitHubDeviceFlow({
          sessionId: aliceSession.sessionId,
          payload: {},
        });
        mockGitHub.authorizeDeviceCode(started2.userCode, "alice-device");
        const pollComplete = yield* team.pollGitHubDeviceFlow({
          sessionId: aliceSession.sessionId,
          payload: { deviceFlowId: started2.deviceFlowId },
        });
        expect(pollComplete.status).toBe("completed");
        expect(pollComplete.identity?.githubLogin).toBe("alice-device");
        expect(pollComplete.identity?.authMethod).toBe("github_app");
        expect(pollComplete.identity?.hasRefreshToken).toBe(true);

        // Cancel first flow cleanly.
        const cancelled = yield* team.cancelGitHubDeviceFlow({
          sessionId: aliceSession.sessionId,
          payload: { deviceFlowId: started.deviceFlowId },
        });
        expect(cancelled.cancelled).toBe(true);

        // Denied flow returns status: "denied".
        const started3 = yield* team.startGitHubDeviceFlow({
          sessionId: bobSessionId,
          payload: {},
        });
        mockGitHub.setDeviceNextError(started3.userCode, "access_denied");
        const pollDenied = yield* team.pollGitHubDeviceFlow({
          sessionId: bobSessionId,
          payload: { deviceFlowId: started3.deviceFlowId },
        });
        expect(pollDenied.status).toBe("denied");

        // Hostile verification_uri / verification_uri_complete on another origin MUST be rejected.
        mockGitHub.setDeviceVerificationOverride({
          verificationUri: "https://evil.example/phish",
        });
        const hostileUriRes = yield* Effect.result(
          team.startGitHubDeviceFlow({
            sessionId: bobSessionId,
            payload: {},
          }),
        );
        expect(hostileUriRes._tag).toBe("Failure");
        mockGitHub.setDeviceVerificationOverride({
          verificationUri: `${mockGitHub.baseUrl}/login/device`,
          verificationUriComplete: "https://evil.example/phish?code=123",
        });
        const hostileCompleteUriRes = yield* Effect.result(
          team.startGitHubDeviceFlow({
            sessionId: bobSessionId,
            payload: {},
          }),
        );
        expect(hostileCompleteUriRes._tag).toBe("Failure");
        mockGitHub.setDeviceVerificationOverride(null);

        // In-flight cancel during outbound device token exchange MUST abort credential persistence.
        const startedInFlight = yield* team.startGitHubDeviceFlow({
          sessionId: bobSessionId,
          payload: {},
        });
        mockGitHub.authorizeDeviceCode(startedInFlight.userCode, "bob-cancelled");
        const pollGate = mockGitHub.holdNextDevicePoll();
        const inFlightPollFiber = yield* Effect.forkChild(
          Effect.result(
            team.pollGitHubDeviceFlow({
              sessionId: bobSessionId,
              payload: { deviceFlowId: startedInFlight.deviceFlowId },
            }),
          ),
        );
        yield* Effect.promise(() => pollGate.entered);
        const cancelInFlight = yield* team.cancelGitHubDeviceFlow({
          sessionId: bobSessionId,
          payload: { deviceFlowId: startedInFlight.deviceFlowId },
        });
        expect(cancelInFlight.cancelled).toBe(true);
        pollGate.release();
        const inFlightOutcome = yield* Fiber.join(inFlightPollFiber);
        expect(inFlightOutcome._tag).toBe("Failure");
        expect((yield* team.getState(bobSessionId)).myGitHubIdentity).toBeNull();
      }).pipe(Effect.provide(makeFullTestLayer())),
  );

  it.live(
    "serializes concurrent token refreshes via per-member Semaphore, keeps refresh_token off remote leases, fails closed with needsReconnect on revocation, and revokes leases on disconnect",
    () =>
      Effect.gen(function* () {
        const mockGitHub = yield* Effect.acquireRelease(
          Effect.promise(() => startMockOAuthGitHubServer()),
          (m) => Effect.promise(() => m.close()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => swapAllowedGitHubOriginsEnv(mockGitHub.baseUrl)),
          (prev) =>
            Effect.sync(() => {
              swapAllowedGitHubOriginsEnv(prev);
            }),
        );

        const team = yield* TeamService.TeamService;
        const repo = yield* TeamRepository.TeamRepository;
        const githubRepo = yield* TeamGitHubRepository.TeamGitHubRepository;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const broker = yield* TeamGitHubBroker.TeamGitHubBroker;
        const sessionStore = yield* SessionStore.SessionStore;

        const aliceSession = yield* sessionStore.issue({
          subject: "alice",
          scopes: ["orchestration:read", "orchestration:operate", "access:write"],
          client: { label: "Alice", deviceType: "desktop", os: "linux" },
        });
        const init = yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Acme Refresh", ownerPseudo: "alice" },
        });

        const remoteEnvId = EnvironmentId.make("env-remote-runner");
        yield* repo.createEnvironment({
          id: TeamEnvironmentRecordId.make("env-rec-remote"),
          teamId: init.team.id,
          environmentId: remoteEnvId,
          name: "Remote Runner",
          isDefault: false,
          peerLinkId: null,
          accessRule: { roles: ["owner", "admin", "modo", "regular"], memberIds: [] },
          createdAt: IsoDateTime.make(DateTime.formatIso(yield* DateTime.now)),
          updatedAt: IsoDateTime.make(DateTime.formatIso(yield* DateTime.now)),
        });

        yield* team.setGitHubAppConfig({
          sessionId: aliceSession.sessionId,
          payload: {
            mode: "github_app",
            clientId: "Iv1.refresh123",
            clientSecret: "CLIENT_SECRET_STAY_ON_HUB",
            webBaseUrl: mockGitHub.baseUrl,
            apiBaseUrl: mockGitHub.baseUrl,
            enabled: true,
          },
        });

        // Connect Alice with a short-lived token already inside the 5-minute proactive refresh window (120s left).
        const started = yield* team.startGitHubOAuth({
          sessionId: aliceSession.sessionId,
          payload: { redirectBaseUrl: "http://127.0.0.1:41999" },
        });
        const challenge = new URL(started.authorizeUrl).searchParams.get("code_challenge")!;
        mockGitHub.registerAuthCode({
          code: "code_alice_short",
          codeChallenge: challenge,
          login: "alice-app",
          name: "Alice App",
          email: "alice@app.example",
          expiresIn: 120, // < 5 min safety margin -> triggers proactive refresh!
          withRefreshToken: true,
        });
        yield* team.completeGitHubOAuthCallback({
          code: "code_alice_short",
          state: started.state,
          callbackSessionId: aliceSession.sessionId,
        });

        mockGitHub.setNextExpiresIn(28_800);

        const threadId = ThreadId.make("thread-concurrent-refresh");
        const issued = yield* broker.issueRemoteTurnLease({
          teamId: init.team.id,
          environmentId: remoteEnvId,
          threadId,
          turnId: "turn-1",
          authorKind: "member",
          authorMemberId: init.owner.id,
        });
        // Proactively refreshed once on issueRemoteTurnLease!
        expect(issued.hasCredential).toBe(true);
        expect(mockGitHub.refreshHits()).toBe(1);

        // Now push Alice's token back into near-expiry (60s left) and fire 10 parallel broker resolutions.
        const credRecord = Option.getOrThrow(yield* githubRepo.getMemberCredential(init.owner.id));
        const currentSecret = yield* TeamGitHubRepository.readTeamGitHubSecret(
          secrets,
          credRecord.secretKey,
        );
        expect(currentSecret?.refreshToken).toBeTruthy();
        const nowMsForSoon = yield* Clock.currentTimeMillis;
        const soonIso = DateTime.formatIso(DateTime.makeUnsafe(nowMsForSoon + 60_000));
        yield* TeamGitHubRepository.writeTeamGitHubSecret(secrets, credRecord.secretKey, {
          ...currentSecret!,
          expiresAt: soonIso,
        });

        // Hold the single in-flight refresh HTTP request until fiber #1 enters the mock server
        // so all 10 parallel resolutions genuinely overlap on the per-member Semaphore.
        const refreshGate = mockGitHub.holdNextRefresh();
        const parallelFiber = yield* Effect.forkChild(
          Effect.all(
            Array.from({ length: 10 }, () =>
              broker.resolveRemoteTurnLease({
                leaseId: issued.leaseId!,
                leaseToken: issued.leaseToken!,
                environmentId: remoteEnvId,
                threadId,
                turnId: "turn-1",
              }),
            ),
            { concurrency: "unbounded" },
          ),
        );
        yield* Effect.promise(() => refreshGate.entered);
        refreshGate.release();
        const parallelResolved = yield* Fiber.join(parallelFiber);

        // All 10 concurrent resolutions succeed with the EXACT same rotated access token,
        // and GitHub's single-use refresh endpoint was hit ONLY ONCE more (total = 2)!
        expect(mockGitHub.refreshHits()).toBe(2);
        const tokens = new Set(parallelResolved.map((r) => r?.token));
        expect(tokens.size).toBe(1);
        const rotatedToken = parallelResolved[0]!.token;
        expect(rotatedToken).not.toBe(currentSecret!.accessToken);

        // Strict security invariant: refresh_token and client_secret NEVER appear in remote lease payloads!
        const serializedLeasePayload = JSON.stringify({ issued, resolved: parallelResolved[0] });
        expect(serializedLeasePayload).not.toContain("ghr_");
        expect(serializedLeasePayload).not.toContain("refreshToken");
        expect(serializedLeasePayload).not.toContain("refresh_token");
        expect(serializedLeasePayload).not.toContain("CLIENT_SECRET_STAY_ON_HUB");

        // Transient refresh errors (503 temporarily_unavailable, 403 rate limit, 302 redirect)
        // MUST preserve stored refresh_token and return the still-valid access token without needsReconnect.
        const beforeTransientSecret = yield* TeamGitHubRepository.readTeamGitHubSecret(
          secrets,
          credRecord.secretKey,
        );
        const nowMsTransient = yield* Clock.currentTimeMillis;
        yield* TeamGitHubRepository.writeTeamGitHubSecret(secrets, credRecord.secretKey, {
          ...beforeTransientSecret!,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(nowMsTransient + 90_000)),
        });
        for (const transientMode of ["transient_503", "rate_limit_403", "redirect_302"] as const) {
          mockGitHub.setRefreshMode(transientMode);
          const transientResolved = yield* broker.resolveRemoteTurnLease({
            leaseId: issued.leaseId!,
            leaseToken: issued.leaseToken!,
            environmentId: remoteEnvId,
            threadId,
            turnId: "turn-1",
          });
          expect(transientResolved?.token).toBe(beforeTransientSecret!.accessToken);
          const secretStillIntact = yield* TeamGitHubRepository.readTeamGitHubSecret(
            secrets,
            credRecord.secretKey,
          );
          expect(secretStillIntact?.refreshToken).toBe(beforeTransientSecret!.refreshToken);
          expect(
            (yield* team.getState(aliceSession.sessionId)).myGitHubIdentity?.needsReconnect,
          ).toBeUndefined();
        }
        mockGitHub.setRefreshMode("normal");

        // Changing clientId on team config MUST NOT send the stored refresh_token to the mismatched client.
        const hitsBeforeConfigSwap = mockGitHub.refreshHits();
        yield* team.setGitHubAppConfig({
          sessionId: aliceSession.sessionId,
          payload: {
            mode: "github_app",
            clientId: "Iv1.other_app",
            clientSecret: "CLIENT_SECRET_STAY_ON_HUB",
            webBaseUrl: mockGitHub.baseUrl,
            apiBaseUrl: mockGitHub.baseUrl,
            enabled: true,
          },
        });
        const mismatchResolved = yield* broker.resolveRemoteTurnLease({
          leaseId: issued.leaseId!,
          leaseToken: issued.leaseToken!,
          environmentId: remoteEnvId,
          threadId,
          turnId: "turn-1",
        });
        expect(mismatchResolved?.token).toBe(beforeTransientSecret!.accessToken);
        expect(mockGitHub.refreshHits()).toBe(hitsBeforeConfigSwap);
        // Restore original clientId for revocation test.
        yield* team.setGitHubAppConfig({
          sessionId: aliceSession.sessionId,
          payload: {
            mode: "github_app",
            clientId: "Iv1.refresh123",
            clientSecret: "CLIENT_SECRET_STAY_ON_HUB",
            webBaseUrl: mockGitHub.baseUrl,
            apiBaseUrl: mockGitHub.baseUrl,
            enabled: true,
          },
        });

        // Now simulate revoked GitHub App authorization + expired token -> must fail closed & set needsReconnect!
        mockGitHub.setRefreshRevoked(true);
        const latestSecret = yield* TeamGitHubRepository.readTeamGitHubSecret(
          secrets,
          credRecord.secretKey,
        );
        const nowMsForPast = yield* Clock.currentTimeMillis;
        const pastIso = DateTime.formatIso(DateTime.makeUnsafe(nowMsForPast - 10_000));
        yield* TeamGitHubRepository.writeTeamGitHubSecret(secrets, credRecord.secretKey, {
          ...latestSecret!,
          expiresAt: pastIso,
        });

        const failedResolve = yield* broker.resolveRemoteTurnLease({
          leaseId: issued.leaseId!,
          leaseToken: issued.leaseToken!,
          environmentId: remoteEnvId,
          threadId,
          turnId: "turn-1",
        });
        expect(failedResolve).toBeNull();

        // Invalid secret was removed from ServerSecretStore, needsReconnect is surfaced in TeamStateSnapshot!
        const secretAfterRevoke = yield* TeamGitHubRepository.readTeamGitHubSecret(
          secrets,
          credRecord.secretKey,
        );
        expect(secretAfterRevoke).toBeNull();

        const aliceStateAfterRevoke = yield* team.getState(aliceSession.sessionId);
        expect(aliceStateAfterRevoke.myGitHubIdentity?.needsReconnect).toBe(true);
        expect(aliceStateAfterRevoke.myGitHubIdentity?.reconnectReason).toContain("refresh token");

        // Reconnect and verify in-flight refresh racing with PAT rotation does NOT clobber the new PAT,
        // and in-flight refresh racing with disconnect does NOT resurrect a deleted secret.
        mockGitHub.setRefreshRevoked(false);
        const startedReconnect = yield* team.startGitHubOAuth({
          sessionId: aliceSession.sessionId,
          payload: { redirectBaseUrl: "http://127.0.0.1:41999" },
        });
        const challenge2 = new URL(startedReconnect.authorizeUrl).searchParams.get(
          "code_challenge",
        )!;
        mockGitHub.registerAuthCode({
          code: "code_alice_reconnect",
          codeChallenge: challenge2,
          login: "alice-app",
          name: "Alice App",
          email: "alice@app.example",
          expiresIn: 60,
          withRefreshToken: true,
        });
        yield* team.completeGitHubOAuthCallback({
          code: "code_alice_reconnect",
          state: startedReconnect.state,
          callbackSessionId: aliceSession.sessionId,
        });

        const aliceReconnectedState = yield* team.getState(aliceSession.sessionId);
        expect(aliceReconnectedState.myGitHubIdentity?.needsReconnect).toBeUndefined();
        expect(aliceReconnectedState.myGitHubIdentity?.hasRefreshToken).toBe(true);

        // Race 1: Hold an OAuth refresh that will return bad_refresh_token; rotate Alice to a PAT while in flight.
        mockGitHub.setRefreshRevoked(true);
        const patRaceGate = mockGitHub.holdNextRefresh();
        const oldRefreshFiber = yield* Effect.forkChild(
          broker.issueRemoteTurnLease({
            teamId: init.team.id,
            environmentId: remoteEnvId,
            threadId,
            turnId: "turn-pat-race",
            authorKind: "member",
            authorMemberId: init.owner.id,
          }),
        );
        yield* Effect.promise(() => patRaceGate.entered);
        mockGitHub.registerPat("github_pat_fresh_alice", {
          login: "alice-pat",
          name: "Alice PAT",
          email: "alice@pat.example",
        });
        yield* team.connectMyGitHub({
          sessionId: aliceSession.sessionId,
          payload: {
            token: "github_pat_fresh_alice",
            apiBaseUrl: mockGitHub.baseUrl,
          },
        });
        patRaceGate.release();
        yield* Fiber.join(oldRefreshFiber);
        // The replacement PAT MUST remain connected with needsReconnect unset!
        const afterPatRaceState = yield* team.getState(aliceSession.sessionId);
        expect(afterPatRaceState.myGitHubIdentity?.authMethod).toBe("pat");
        expect(afterPatRaceState.myGitHubIdentity?.githubLogin).toBe("alice-pat");
        expect(afterPatRaceState.myGitHubIdentity?.needsReconnect).toBeUndefined();

        // Race 2: Reconnect short-lived OAuth, hold a succeeding refresh, disconnect while in flight ->
        // must return null and MUST NOT resurrect the deleted secret in ServerSecretStore!
        mockGitHub.setRefreshRevoked(false);
        const startedRace2 = yield* team.startGitHubOAuth({
          sessionId: aliceSession.sessionId,
          payload: { redirectBaseUrl: "http://127.0.0.1:41999" },
        });
        mockGitHub.registerAuthCode({
          code: "code_alice_race2",
          codeChallenge: new URL(startedRace2.authorizeUrl).searchParams.get("code_challenge")!,
          login: "alice-app",
          name: "Alice App",
          email: "alice@app.example",
          expiresIn: 60,
          withRefreshToken: true,
        });
        yield* team.completeGitHubOAuthCallback({
          code: "code_alice_race2",
          state: startedRace2.state,
          callbackSessionId: aliceSession.sessionId,
        });
        const race2Cred = Option.getOrThrow(yield* githubRepo.getMemberCredential(init.owner.id));
        const disconnectRaceGate = mockGitHub.holdNextRefresh();
        const disconnectRaceFiber = yield* Effect.forkChild(
          broker.issueRemoteTurnLease({
            teamId: init.team.id,
            environmentId: remoteEnvId,
            threadId,
            turnId: "turn-disconnect-race",
            authorKind: "member",
            authorMemberId: init.owner.id,
          }),
        );
        yield* Effect.promise(() => disconnectRaceGate.entered);
        yield* team.disconnectMyGitHub({ sessionId: aliceSession.sessionId });
        disconnectRaceGate.release();
        const disconnectRaceLease = yield* Fiber.join(disconnectRaceFiber);
        expect(disconnectRaceLease.hasCredential).toBe(false);
        expect(
          yield* TeamGitHubRepository.readTeamGitHubSecret(secrets, race2Cred.secretKey),
        ).toBeNull();

        // Final sequential reconnect + disconnect immediately revokes active local & remote turn leases.
        const startedFinal = yield* team.startGitHubOAuth({
          sessionId: aliceSession.sessionId,
          payload: { redirectBaseUrl: "http://127.0.0.1:41999" },
        });
        mockGitHub.registerAuthCode({
          code: "code_alice_final",
          codeChallenge: new URL(startedFinal.authorizeUrl).searchParams.get("code_challenge")!,
          login: "alice-app",
          name: "Alice App",
          email: "alice@app.example",
          expiresIn: 28_800,
          withRefreshToken: true,
        });
        yield* team.completeGitHubOAuthCallback({
          code: "code_alice_final",
          state: startedFinal.state,
          callbackSessionId: aliceSession.sessionId,
        });

        const leaseBeforeDisconnect = yield* broker.issueRemoteTurnLease({
          teamId: init.team.id,
          environmentId: remoteEnvId,
          threadId,
          turnId: "turn-2",
          authorKind: "member",
          authorMemberId: init.owner.id,
        });
        expect(leaseBeforeDisconnect.hasCredential).toBe(true);
        yield* broker.activateLocalTurnLease({
          threadId,
          turnId: "turn-local-2",
          providerSessionId: ProviderSessionId.make("ps-disconnect"),
          authorKind: "member",
          authorMemberId: init.owner.id,
        });
        expect(yield* broker.hasActiveTurnLease({ threadId, turnId: "turn-local-2" })).toBe(true);

        yield* team.disconnectMyGitHub({ sessionId: aliceSession.sessionId });

        expect(yield* broker.hasActiveTurnLease({ threadId, turnId: "turn-local-2" })).toBe(false);
        const afterDisconnectResolve = yield* broker.resolveRemoteTurnLease({
          leaseId: leaseBeforeDisconnect.leaseId!,
          leaseToken: leaseBeforeDisconnect.leaseToken!,
          environmentId: remoteEnvId,
          threadId,
          turnId: "turn-2",
        });
        expect(afterDisconnectResolve).toBeNull();
      }).pipe(Effect.provide(makeFullTestLayer())),
  );
});
