// @effect-diagnostics nodeBuiltinImport:off -- Spins up an ephemeral loopback mock upstream LLM & OAuth server.
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  TeamSkillSlug,
  type TeamAssetsDeltaResponse,
  type TeamProviderLeaseResponse,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/http";
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
import * as TeamProviderManager from "./TeamProviderManager.ts";
import * as TeamProviderProxyHttp from "./providerProxyHttp.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";

const makeTestLayer = () => {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer);
  const base = ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-proxy-http-" }).pipe(
    Layer.provideMerge(platform),
  );
  const persistence = SqlitePersistence.layerMemory.pipe(Layer.provide(base));
  const secrets = ServerSecretStore.layer.pipe(Layer.provide(base));
  const authSessions = AuthSessions.layer.pipe(Layer.provide(persistence));
  const authDeps = Layer.mergeAll(
    persistence,
    secrets,
    authSessions,
    ServerEnvironment.layer.pipe(Layer.provide(secrets), Layer.provide(base)),
  );
  const sessions = SessionStore.layer.pipe(Layer.provideMerge(authDeps), Layer.provide(base));
  const envAuth = EnvironmentAuth.layer.pipe(
    Layer.provideMerge(sessions),
    Layer.provideMerge(secrets),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(base),
  );
  const teamRepo = TeamRepository.layer.pipe(Layer.provide(persistence));
  const assetsRepo = TeamAssetsRepository.layer.pipe(Layer.provide(persistence));
  const teamProviderManager = TeamProviderManager.layer.pipe(
    Layer.provideMerge(assetsRepo),
    Layer.provideMerge(teamRepo),
    Layer.provideMerge(secrets),
    Layer.provideMerge(base),
  );
  const teamService = TeamService.layer.pipe(
    Layer.provideMerge(teamRepo),
    Layer.provideMerge(assetsRepo),
    Layer.provideMerge(sessions),
    Layer.provideMerge(secrets),
    Layer.provide(base),
  );
  return Layer.mergeAll(
    teamService,
    teamProviderManager,
    teamRepo,
    assetsRepo,
    authSessions,
    sessions,
    envAuth,
    secrets,
    persistence,
    base,
  );
};

describe("TeamProviderProxyHttp", () => {
  it.live(
    "proxies API-key requests with server-injected secret, records centralized usage, leases OAuth tokens without refresh_token, serves delta assets, and returns 403 immediately on revocation",
    () =>
      Effect.gen(function* () {
        const upstreamRequests: Array<{
          readonly url: string;
          readonly authHeader: string | undefined;
          readonly body: string;
        }> = [];
        const upstreamServer = NodeHttp.createServer((req, res) => {
          const chunks: Array<Buffer> = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            upstreamRequests.push({
              url: req.url ?? "",
              authHeader: req.headers.authorization,
              body,
            });
            if (req.url === "/redirect-secret") {
              res.writeHead(302, { location: `${upstreamOrigin}/redirect-target` });
              res.end();
              return;
            }
            if (req.url === "/oauth/token") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(
                JSON.stringify({
                  access_token: "leased-short-lived-access",
                  refresh_token: "company-master-refresh-never-leaked",
                  token_type: "Bearer",
                  expires_in: 3600,
                }),
              );
              return;
            }
            if (req.headers.authorization !== "Bearer COMPANY_SECRET_API_KEY") {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, echoed: body }));
          });
        });
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", () => resolve())),
        );
        const upstreamPort = (upstreamServer.address() as { port: number }).port;
        const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;

        try {
          const team = yield* TeamService.TeamService;
          const sessions = yield* SessionStore.SessionStore;

          const aliceSession = yield* sessions.issue({ subject: "alice-owner" });
          yield* team.initializeTeam({
            sessionId: aliceSession.sessionId,
            payload: { name: "Acme", ownerPseudo: "alice" },
          });
          const bobInvite = yield* team.createInvite({
            sessionId: aliceSession.sessionId,
            payload: { role: "regular", prefilledPseudo: "bob" },
          });
          const bobRedeemed = yield* team.redeemInvite({
            token: bobInvite.token,
            pseudo: "bob",
            client: { deviceType: "desktop" },
          });
          const bobSession = yield* sessions.verify(bobRedeemed.accessToken);

          // Alice configures a proxy provider and a token-lease provider.
          yield* team.upsertProvider({
            sessionId: aliceSession.sessionId,
            payload: {
              providerInstanceId: ProviderInstanceId.make("company-openai"),
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: "Company OpenAI",
              deliveryStrategy: "proxy",
              upstreamBaseUrl: upstreamOrigin,
              apiKey: "COMPANY_SECRET_API_KEY",
            },
          });
          yield* team.upsertProvider({
            sessionId: aliceSession.sessionId,
            payload: {
              providerInstanceId: ProviderInstanceId.make("company-agy"),
              driver: ProviderDriverKind.make("antigravity"),
              displayName: "Company Antigravity",
              deliveryStrategy: "token-lease",
              oauthAccessToken: "stale",
              oauthRefreshToken: "company-master-refresh-never-leaked",
              oauthExpiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 })),
              oauthTokenEndpoint: `${upstreamOrigin}/oauth/token`,
              oauthClientId: "cid",
            },
          });

          // Alice adds a skill and a pre-prompt, then deletes a second skill to create a tombstone.
          const skill1 = yield* team.upsertSkill({
            sessionId: aliceSession.sessionId,
            payload: {
              slug: TeamSkillSlug.make("review"),
              providerDriver: "*",
              skillMd: "---\nname: review\ndescription: Review\n---\nCheck everything.",
            },
          });
          const skill2 = yield* team.upsertSkill({
            sessionId: aliceSession.sessionId,
            payload: {
              slug: TeamSkillSlug.make("obsolete"),
              providerDriver: "*",
              skillMd: "---\nname: obsolete\ndescription: Old\n---\nOld.",
            },
          });
          yield* team.deleteSkill({
            sessionId: aliceSession.sessionId,
            payload: { skillId: skill2.id },
          });

          // Bob obtains a dedicated local sync token (opaque, never valid as a general session).
          const bobSync = yield* team.issueLocalSyncToken(bobSession.sessionId);
          expect(bobSync.token.startsWith("t3teamsync_")).toBe(true);
          const verifySyncAsSession = yield* Effect.result(sessions.verify(bobSync.token));
          expect(verifySyncAsSession._tag).toBe("Failure");

          const teamProviderManager = yield* TeamProviderManager.TeamProviderManager;

          const testContext = yield* Effect.context<
            | TeamRepository.TeamRepository
            | TeamAssetsRepository.TeamAssetsRepository
            | TeamProviderManager.TeamProviderManager
            | AuthSessions.AuthSessionRepository
            | EnvironmentAuth.EnvironmentAuth
            | ServerSecretStore.ServerSecretStore
            | HttpClient.HttpClient
            | SecureRandom.SecureRandom
          >();
          const routerLayer = TeamProviderProxyHttp.layer.pipe(
            Layer.provideMerge(Layer.succeedContext(testContext)),
          );
          const { handler, dispose } = HttpRouter.toWebHandler(routerLayer, {
            disableLogger: true,
          });
          try {
            // 1. Proxy request injects COMPANY_SECRET_API_KEY and strips Bob's token.
            const proxyRes = yield* Effect.promise(() =>
              handler(
                new Request("http://team.local/api/team/provider-proxy/company-openai/v1/chat", {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${bobSync.token}`,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({ prompt: "hello" }),
                }),
              ),
            );
            expect(proxyRes.status).toBe(200);
            const proxyJson = (yield* Effect.promise(() => proxyRes.json())) as {
              ok: boolean;
              echoed: string;
            };
            expect(proxyJson.ok).toBe(true);
            expect(upstreamRequests[0]?.authHeader).toBe("Bearer COMPANY_SECRET_API_KEY");

            // 2. Centralized usage accounting recorded Bob's proxy request!
            const usage = yield* team.listProviderUsage(aliceSession.sessionId);
            expect(
              usage.some(
                (entry) =>
                  entry.memberId === bobRedeemed.member.id &&
                  entry.providerInstanceId === "company-openai" &&
                  entry.requestCount === 1,
              ),
            ).toBe(true);

            // 3. OAuth lease returns short-lived accessToken and ZERO refresh_token!
            const leaseRes = yield* Effect.promise(() =>
              handler(
                new Request("http://team.local/api/team/provider-lease/company-agy", {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${bobSync.token}`,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({}),
                }),
              ),
            );
            expect(leaseRes.status).toBe(200);
            const leaseText = yield* Effect.promise(() => leaseRes.text());
            expect(leaseText).not.toContain("company-master-refresh-never-leaked");
            const leaseBody = JSON.parse(leaseText) as TeamProviderLeaseResponse;
            expect(leaseBody.accessToken).toBe("leased-short-lived-access");

            // 4. Delta assets endpoint supports full sync (?since=0) and incremental delta + tombstones!
            const fullAssetsRes = yield* Effect.promise(() =>
              handler(
                new Request("http://team.local/api/team/assets?since=0", {
                  headers: { authorization: `Bearer ${bobSync.token}` },
                }),
              ),
            );
            expect(fullAssetsRes.status).toBe(200);
            const fullAssets = (yield* Effect.promise(() =>
              fullAssetsRes.json(),
            )) as TeamAssetsDeltaResponse;
            expect(fullAssets.fullSync).toBe(true);
            expect(fullAssets.skills.map((s) => s.id)).toEqual([skill1.id]);

            const deltaAssetsRes = yield* Effect.promise(() =>
              handler(
                new Request(`http://team.local/api/team/assets?since=${skill1.revision}`, {
                  headers: { authorization: `Bearer ${bobSync.token}` },
                }),
              ),
            );
            expect(deltaAssetsRes.status).toBe(200);
            const deltaAssets = (yield* Effect.promise(() =>
              deltaAssetsRes.json(),
            )) as TeamAssetsDeltaResponse;
            expect(deltaAssets.fullSync).toBe(false);
            expect(deltaAssets.deletedSkillIds).toEqual([skill2.id]);

            // 4b. Security hardening: path traversal, malformed percent-encoding, and 3xx redirects are blocked.
            const traversalRes = yield* Effect.promise(() =>
              handler(
                new Request(
                  "http://team.local/api/team/provider-proxy/company-openai/v1/..%2fadmin",
                  {
                    method: "POST",
                    headers: { authorization: `Bearer ${bobSync.token}` },
                  },
                ),
              ),
            );
            expect(traversalRes.status).toBe(400);

            const malformedRes = yield* Effect.promise(() =>
              handler(
                new Request("http://team.local/api/team/provider-proxy/company-openai/v1/%ZZ", {
                  method: "POST",
                  headers: { authorization: `Bearer ${bobSync.token}` },
                }),
              ),
            );
            expect([400, 404]).toContain(malformedRes.status);

            const redirectRes = yield* Effect.promise(() =>
              handler(
                new Request(
                  "http://team.local/api/team/provider-proxy/company-openai/redirect-secret",
                  {
                    method: "GET",
                    headers: { authorization: `Bearer ${bobSync.token}` },
                  },
                ),
              ),
            );
            expect(redirectRes.status).toBe(302);
            expect(upstreamRequests.some((r) => r.url === "/redirect-target")).toBe(false);

            // 4c. Team Server internal loopback proxy token keeps company API key out of agent env & records usage!
            const virtualConfigs = yield* teamProviderManager.getVirtualProviderConfigs;
            const virtualOpenAiKey = Object.keys(virtualConfigs).find((k) =>
              k.endsWith(":company-openai"),
            );
            expect(virtualOpenAiKey).toBeDefined();
            const virtualOpenAi = virtualConfigs[virtualOpenAiKey as ProviderInstanceId]!;
            const internalProxyToken = virtualOpenAi.environment?.find(
              (entry) => entry.name === "T3_TEAM_PROXY_TOKEN",
            )?.value;
            expect(internalProxyToken).toBeDefined();
            expect(internalProxyToken).not.toBe("COMPANY_SECRET_API_KEY");
            expect(
              virtualOpenAi.environment?.some((entry) => entry.value === "COMPANY_SECRET_API_KEY"),
            ).toBe(false);

            yield* teamProviderManager.setActiveTeamServerTurnMember(
              virtualOpenAiKey as ProviderInstanceId,
              bobRedeemed.member.id,
            );
            const internalProxyRes = yield* Effect.promise(() =>
              handler(
                new Request("http://team.local/api/team/provider-proxy/company-openai/v1/chat", {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${internalProxyToken}`,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({ prompt: "from-team-server" }),
                }),
              ),
            );
            expect(internalProxyRes.status).toBe(200);

            // 4d. Revoking Bob's underlying AuthSession immediately rejects bobSync.token even while member stays active!
            const bobInvite2 = yield* team.createInvite({
              sessionId: aliceSession.sessionId,
              payload: { role: "regular", prefilledPseudo: "charlie" },
            });
            const charlieRedeemed = yield* team.redeemInvite({
              token: bobInvite2.token,
              pseudo: "charlie",
              client: { deviceType: "desktop" },
            });
            const charlieSession = yield* sessions.verify(charlieRedeemed.accessToken);
            const charlieSync = yield* team.issueLocalSyncToken(charlieSession.sessionId);
            yield* sessions.revoke(charlieSession.sessionId);

            const revokedSessionRes = yield* Effect.promise(() =>
              handler(
                new Request("http://team.local/api/team/assets?since=0", {
                  headers: { authorization: `Bearer ${charlieSync.token}` },
                }),
              ),
            );
            expect(revokedSessionRes.status).toBe(403);
            expect(yield* Effect.promise(() => revokedSessionRes.text())).toContain(
              "team_access_revoked",
            );

            // 5. Alice suspends Bob -> proxy, lease, and assets endpoints IMMEDIATELY return 403 team_access_revoked!
            yield* team.updateMemberStatus({
              sessionId: aliceSession.sessionId,
              payload: { memberId: bobRedeemed.member.id, status: "suspended" },
            });

            const revokedProxy = yield* Effect.promise(() =>
              handler(
                new Request("http://team.local/api/team/provider-proxy/company-openai/v1/chat", {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${bobSync.token}`,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify({ prompt: "after-revoke" }),
                }),
              ),
            );
            expect(revokedProxy.status).toBe(403);
            expect(yield* Effect.promise(() => revokedProxy.text())).toContain(
              "team_access_revoked",
            );

            const revokedLease = yield* Effect.promise(() =>
              handler(
                new Request("http://team.local/api/team/provider-lease/company-agy", {
                  method: "POST",
                  headers: { authorization: `Bearer ${bobSync.token}` },
                }),
              ),
            );
            expect(revokedLease.status).toBe(403);

            const revokedAssets = yield* Effect.promise(() =>
              handler(
                new Request("http://team.local/api/team/assets?since=0", {
                  headers: { authorization: `Bearer ${bobSync.token}` },
                }),
              ),
            );
            expect(revokedAssets.status).toBe(403);
          } finally {
            yield* Effect.promise(() => dispose());
          }
        } finally {
          yield* Effect.promise(
            () => new Promise<void>((resolve) => upstreamServer.close(() => resolve())),
          );
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
