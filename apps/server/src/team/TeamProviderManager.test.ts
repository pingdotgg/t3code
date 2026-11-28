// @effect-diagnostics nodeBuiltinImport:off -- Local mock Team Server HTTP endpoints for lease/revocation/delta tests.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  ProviderThreadId,
  RunId,
  TeamId,
  TeamMemberId,
  TeamPrepromptId,
  TeamProviderId,
  TeamPseudo,
  TeamSkillId,
  TeamSkillSlug,
  TeamViewId,
  ThreadId,
  makeTeamProviderInstanceId,
  type TeamPreprompt,
  type TeamProvider,
  type TeamSkill,
} from "@t3tools/contracts";
import * as AcpErrors from "effect-acp/errors";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "@effect/vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TeamAssetsRepository from "./TeamAssetsRepository.ts";
import { TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME } from "./TeamProfileMaterializer.ts";
import * as TeamProviderManager from "./TeamProviderManager.ts";
import * as TeamRepository from "./TeamRepository.ts";

const makeTestLayer = () => {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer);
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-pm-test-" }).pipe(
    Layer.provideMerge(platform),
  );
  const persistence = SqlitePersistence.layerMemory.pipe(Layer.provide(config));
  const secrets = ServerSecretStore.layer.pipe(Layer.provide(config));
  const teamRepo = TeamRepository.layer.pipe(Layer.provide(persistence));
  const assetsRepo = TeamAssetsRepository.layer.pipe(Layer.provide(persistence));
  const manager = TeamProviderManager.layer.pipe(
    Layer.provideMerge(assetsRepo),
    Layer.provideMerge(teamRepo),
    Layer.provideMerge(secrets),
    Layer.provideMerge(config),
  );
  return Layer.mergeAll(manager, assetsRepo, teamRepo, secrets, config);
};

const makeTeamProvider = (
  id: string,
  driver: string,
  deliveryStrategy: "proxy" | "token-lease" | "remote-only",
): TeamProvider => ({
  id: TeamProviderId.make(`tp-${id}`),
  teamId: TeamId.make("team-1"),
  providerInstanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  displayName: `Team ${id}`,
  deliveryStrategy,
  hasSecret: deliveryStrategy !== "remote-only",
  upstreamBaseUrl: deliveryStrategy === "proxy" ? "https://upstream.example/v1" : null,
  apiKeyHeader: null,
  apiKeyPrefix: null,
  config: {},
  enabled: true,
  updatedByMemberId: TeamMemberId.make("member-alice"),
  createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
  updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
});

describe("TeamProviderManager", () => {
  it.effect(
    "enforces strict team:<T>:* isolation, leases & refreshes tokens, auto-resumes on >1h auth expiry, and purges with NO auto-resume on 403 revocation",
    () =>
      Effect.gen(function* () {
        let revoked = false;
        let leaseCount = 0;
        const teamId = TeamId.make("team-1");
        const skillV1: TeamSkill = {
          id: TeamSkillId.make("sk-1"),
          teamId,
          slug: TeamSkillSlug.make("release-check"),
          providerDriver: "*",
          skillMd: "---\nname: release-check\ndescription: Check release\n---\nBody",
          references: [],
          enabled: true,
          revision: NonNegativeInt.make(1),
          contentHash: "a".repeat(64),
          updatedByMemberId: TeamMemberId.make("member-alice"),
          createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
          updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
        };
        const turnPreprompt: TeamPreprompt = {
          id: TeamPrepromptId.make("pp-turn"),
          teamId,
          name: "Always Test",
          providerDriver: "*",
          injectionScope: "turn",
          content: "ALWAYS_RUN_UNIT_TESTS_MARKER",
          enabled: true,
          revision: NonNegativeInt.make(1),
          contentHash: "b".repeat(64),
          updatedByMemberId: TeamMemberId.make("member-alice"),
          createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
          updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
        };

        const mockTeamServer = NodeHttp.createServer((req, res) => {
          if (revoked) {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ code: "team_access_revoked", message: "Revoked" }));
            return;
          }
          if (req.url?.startsWith("/api/team/assets")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                teamId,
                revision: 1,
                fullSync: true,
                skills: [skillV1],
                preprompts: [turnPreprompt],
                deletedSkillIds: [],
                deletedPrepromptIds: [],
              }),
            );
            return;
          }
          if (req.method === "POST" && req.url?.startsWith("/api/team/provider-lease/")) {
            leaseCount += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                providerInstanceId: "team-agy",
                driver: "antigravity",
                accessToken: `leased-token-${leaseCount}`,
                tokenType: "Bearer",
                expiresAt: "2099-01-01T00:00:00.000Z",
                expiresInSeconds: 3600,
                email: "team@acme.test",
              }),
            );
            return;
          }
          res.writeHead(404);
          res.end();
        });
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => mockTeamServer.listen(0, "127.0.0.1", () => resolve())),
        );
        const port = (mockTeamServer.address() as { port: number }).port;

        try {
          const manager = yield* TeamProviderManager.TeamProviderManager;
          const config = yield* ServerConfig.ServerConfig;
          const projectId = ProjectId.make("proj-team-1");
          const personalProjectId = ProjectId.make("proj-personal-1");

          const syncRes = yield* manager.syncLocalTeamBinding({
            teamId,
            teamName: "Acme",
            teamServerUrl: `http://127.0.0.1:${port}`,
            memberToken: "bob-sync-token",
            providers: [
              makeTeamProvider("team-agy", "antigravity", "token-lease"),
              makeTeamProvider("team-proxy", "claudeAgent", "proxy"),
              makeTeamProvider("team-remote", "cursor", "remote-only"),
            ],
            projects: [
              { localProjectId: projectId, teamProjectId: projectId, repoIdentityKey: null },
            ],
            assetsRevision: NonNegativeInt.make(1),
          });
          expect(syncRes.synced).toBe(true);
          expect(syncRes.assetsRevision).toBe(1);

          // Virtual configs exclude remote-only on local binding, include proxy & token-lease.
          const virtuals = yield* manager.getVirtualProviderConfigs;
          const agyVirtualId = makeTeamProviderInstanceId(
            teamId,
            ProviderInstanceId.make("team-agy"),
          );
          const proxyVirtualId = makeTeamProviderInstanceId(
            teamId,
            ProviderInstanceId.make("team-proxy"),
          );
          const remoteVirtualId = makeTeamProviderInstanceId(
            teamId,
            ProviderInstanceId.make("team-remote"),
          );
          expect(virtuals[agyVirtualId]).toBeDefined();
          expect(virtuals[proxyVirtualId]).toBeDefined();
          expect(virtuals[remoteVirtualId]).toBeUndefined();

          // Strict isolation: personal provider REJECTED on team project!
          const isolationFail = yield* Effect.result(
            manager.assertProviderAllowedForProject({
              projectId,
              instanceId: ProviderInstanceId.make("codex"),
            }),
          );
          expect(isolationFail._tag).toBe("Failure");

          // Remote-only provider REJECTED on local binding!
          const remoteFail = yield* Effect.result(
            manager.assertProviderAllowedForProject({
              projectId,
              instanceId: remoteVirtualId,
            }),
          );
          expect(remoteFail._tag).toBe("Failure");

          // Personal project continues using personal providers cleanly,
          // and strictly REJECTS virtual team:* providers!
          yield* manager.assertProviderAllowedForProject({
            projectId: personalProjectId,
            instanceId: ProviderInstanceId.make("codex"),
          });
          const personalTeamProviderFail = yield* Effect.result(
            manager.assertProviderAllowedForProject({
              projectId: personalProjectId,
              instanceId: agyVirtualId,
            }),
          );
          expect(personalTeamProviderFail._tag).toBe("Failure");
          const personalPrepareFail = yield* Effect.result(
            manager.prepareForTurn({
              projectId: personalProjectId,
              instanceId: agyVirtualId,
              driver: ProviderDriverKind.make("antigravity"),
              nativeThreadHasTurns: false,
            }),
          );
          expect(personalPrepareFail._tag).toBe("Failure");

          // Invalid non-http(s) teamServerUrl is rejected by syncLocalTeamBinding.
          const badUrlSync = yield* manager.syncLocalTeamBinding({
            teamId: TeamId.make("team-evil"),
            teamName: "Evil",
            teamServerUrl: "file:///etc/passwd",
            providers: [],
            projects: [],
            assetsRevision: NonNegativeInt.make(0),
          });
          expect(badUrlSync.synced).toBe(false);

          // Pre-turn preparation fetches lease, writes chmod 0600 token file (no refresh_token), and returns turn pre-prompts!
          const prep = yield* manager.prepareForTurn({
            projectId,
            instanceId: agyVirtualId,
            driver: ProviderDriverKind.make("antigravity"),
            nativeThreadHasTurns: false,
          });
          expect(leaseCount).toBe(1);
          expect(prep.recycleWarmSession).toBe(true);
          expect(prep.turnPrepromptText).toContain("ALWAYS_RUN_UNIT_TESTS_MARKER");

          // Active-turn >1h auth expiry triggers forced lease refresh, session recycle, AND ProviderContinuationRequests auto-resume!
          let recycledCount = 0;
          const continuations: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
          const recovered = yield* manager.handleActiveTurnAuthFailure({
            virtualInstanceId: agyVirtualId,
            driver: ProviderDriverKind.make("antigravity"),
            threadId: ThreadId.make("thread-1"),
            providerThreadId: ProviderThreadId.make("pt-1"),
            runId: RunId.make("run-1"),
            error: new Error("HTTP 401 UNAUTHENTICATED: token has expired"),
            recycleSession: () =>
              Effect.sync(() => {
                recycledCount += 1;
              }),
            requestContinuation: (req) =>
              Effect.sync(() => {
                continuations.push(req);
              }),
          });
          expect(recovered.handled).toBe(true);
          expect(recovered.revoked).toBe(false);
          expect(leaseCount).toBe(2);
          expect(recycledCount).toBe(1);
          expect(continuations).toHaveLength(1);

          // Pending recycle marker guarantees continuation turn recycles warm RAM-caching session even when lease is already fresh!
          const sessionA = ProviderSessionId.make("sess-warm-a");
          const sessionB = ProviderSessionId.make("sess-warm-b");
          const continuationPrep = yield* manager.prepareForTurn({
            projectId,
            instanceId: agyVirtualId,
            driver: ProviderDriverKind.make("antigravity"),
            nativeThreadHasTurns: true,
            providerSessionId: sessionA,
          });
          expect(continuationPrep.recycleWarmSession).toBe(true);
          // Simulate sessionA recycle -> reopen stamping its new lease generation.
          yield* manager.revokeInternalProxySessionToken(sessionA);
          yield* manager.recordSessionLeaseGeneration(agyVirtualId, sessionA);

          // Register sessionB at the same lease generation (no recycle needed yet).
          const sessionBInit = yield* manager.prepareForTurn({
            projectId,
            instanceId: agyVirtualId,
            driver: ProviderDriverKind.make("antigravity"),
            nativeThreadHasTurns: true,
            providerSessionId: sessionB,
          });
          expect(sessionBInit.recycleWarmSession).toBe(false);

          // Simulate background lease rotation #1 (forceRefresh outside prepareForTurn):
          // BOTH warm sessions A and B MUST see recycleWarmSession === true on their next turn!
          yield* manager.getLeasedAccessToken(agyVirtualId, { forceRefresh: true });
          const afterRotateA = yield* manager.prepareForTurn({
            projectId,
            instanceId: agyVirtualId,
            driver: ProviderDriverKind.make("antigravity"),
            nativeThreadHasTurns: true,
            providerSessionId: sessionA,
          });
          const afterRotateB = yield* manager.prepareForTurn({
            projectId,
            instanceId: agyVirtualId,
            driver: ProviderDriverKind.make("antigravity"),
            nativeThreadHasTurns: true,
            providerSessionId: sessionB,
          });
          expect(afterRotateA.recycleWarmSession).toBe(true);
          expect(afterRotateB.recycleWarmSession).toBe(true);

          // Simulate full release + reopen for both sessions, then a SECOND background rotation:
          // BOTH warm sessions MUST still retain generation tracking and recycle again!
          yield* manager.revokeInternalProxySessionToken(sessionA);
          yield* manager.recordSessionLeaseGeneration(agyVirtualId, sessionA);
          yield* manager.revokeInternalProxySessionToken(sessionB);
          yield* manager.recordSessionLeaseGeneration(agyVirtualId, sessionB);

          yield* manager.getLeasedAccessToken(agyVirtualId, { forceRefresh: true });
          const afterSecondRotateA = yield* manager.prepareForTurn({
            projectId,
            instanceId: agyVirtualId,
            driver: ProviderDriverKind.make("antigravity"),
            nativeThreadHasTurns: true,
            providerSessionId: sessionA,
          });
          const afterSecondRotateB = yield* manager.prepareForTurn({
            projectId,
            instanceId: agyVirtualId,
            driver: ProviderDriverKind.make("antigravity"),
            nativeThreadHasTurns: true,
            providerSessionId: sessionB,
          });
          expect(afterSecondRotateA.recycleWarmSession).toBe(true);
          expect(afterSecondRotateB.recycleWarmSession).toBe(true);

          // Now revoke member -> 403 immediately purges ephemeral token file and refuses auto-resume!
          revoked = true;
          const revokedRecovery = yield* manager.handleActiveTurnAuthFailure({
            virtualInstanceId: agyVirtualId,
            driver: ProviderDriverKind.make("antigravity"),
            threadId: ThreadId.make("thread-1"),
            providerThreadId: ProviderThreadId.make("pt-1"),
            runId: RunId.make("run-2"),
            error: new Error("HTTP 401 token expired"),
            recycleSession: () =>
              Effect.sync(() => {
                recycledCount += 1;
              }),
            requestContinuation: (req) =>
              Effect.sync(() => {
                continuations.push(req);
              }),
          });
          expect(revokedRecovery.handled).toBe(true);
          expect(revokedRecovery.revoked).toBe(true);
          expect(continuations).toHaveLength(1); // NO auto-resume on revocation!

          const paths = yield* TeamProviderManager.resolveTeamProfilePathsForTests({
            stateDir: config.stateDir,
            teamId,
            virtualInstanceId: agyVirtualId,
            driver: ProviderDriverKind.make("antigravity"),
          });
          const tokenExists = yield* Effect.promise(() =>
            NodeFSP.access(
              NodePath.join(
                paths.profileDir,
                "antigravity-acp",
                TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME,
              ),
            )
              .then(() => true)
              .catch(() => false),
          );
          expect(tokenExists).toBe(false);
        } finally {
          yield* Effect.promise(
            () => new Promise<void>((resolve) => mockTeamServer.close(() => resolve())),
          );
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.live(
    "supports Team Server workspace token-lease issuance without local binding, loopback proxy config, and Antigravity proxy authMethod",
    () =>
      Effect.gen(function* () {
        const oauthServer = NodeHttp.createServer((req, res) => {
          if (req.url === "/oauth/token") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                access_token: "team-server-leased-access",
                token_type: "Bearer",
                expires_in: 3600,
              }),
            );
            return;
          }
          res.writeHead(404);
          res.end();
        });
        yield* Effect.promise(
          () => new Promise<void>((resolve) => oauthServer.listen(0, "127.0.0.1", () => resolve())),
        );
        const oauthPort = (oauthServer.address() as { port: number }).port;
        try {
          const teamRepo = yield* TeamRepository.TeamRepository;
          const assetsRepo = yield* TeamAssetsRepository.TeamAssetsRepository;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          const manager = yield* TeamProviderManager.TeamProviderManager;

          const teamId = TeamId.make("team-srv-1");
          const ownerId = TeamMemberId.make("member-owner");
          const now = IsoDateTime.make("2026-01-01T00:00:00.000Z");
          yield* teamRepo.initializeWorkspace({
            team: {
              id: teamId,
              name: "Server Team",
              defaultViewId: TeamViewId.make("view-default"),
              createdAt: now,
              updatedAt: now,
            },
            owner: {
              id: ownerId,
              teamId,
              pseudo: TeamPseudo.make("alice"),
              role: "owner",
              status: "active",
              createdAt: now,
              updatedAt: now,
            },
            ownerSessionId: AuthSessionId.make("sess-owner"),
          });
          const projectId = ProjectId.make("proj-srv-1");
          yield* teamRepo.upsertProjectAssignment({
            projectId,
            teamId,
            repoIdentityKey: null,
            defaultViewId: null,
            assignedByMemberId: ownerId,
            createdAt: now,
            updatedAt: now,
          });

          const encoder = new TextEncoder();
          const leaseSecretKey = "team-provider-secret-lease";
          yield* secrets.set(
            leaseSecretKey,
            encoder.encode(
              JSON.stringify({
                oauthAccessToken: "stale-token",
                oauthRefreshToken: "master-refresh",
                oauthExpiresAt: "2020-01-01T00:00:00.000Z",
                oauthTokenEndpoint: `http://127.0.0.1:${oauthPort}/oauth/token`,
                oauthClientId: "cid",
              }),
            ),
          );
          yield* assetsRepo.upsertProvider({
            id: TeamProviderId.make("tp-srv-lease"),
            teamId,
            providerInstanceId: ProviderInstanceId.make("srv-codex"),
            driver: ProviderDriverKind.make("codex"),
            displayName: "Server Codex",
            deliveryStrategy: "token-lease",
            secretKey: leaseSecretKey,
            upstreamBaseUrl: null,
            apiKeyHeader: null,
            apiKeyPrefix: null,
            config: {},
            enabled: true,
            updatedByMemberId: ownerId,
            now,
          });

          const proxySecretKey = "team-provider-secret-proxy";
          yield* secrets.set(
            proxySecretKey,
            encoder.encode(JSON.stringify({ apiKey: "RAW_COMPANY_GEMINI_KEY" })),
          );
          yield* assetsRepo.upsertProvider({
            id: TeamProviderId.make("tp-srv-agy-proxy"),
            teamId,
            providerInstanceId: ProviderInstanceId.make("srv-agy-proxy"),
            driver: ProviderDriverKind.make("antigravity"),
            displayName: "Server Agy Proxy",
            deliveryStrategy: "proxy",
            secretKey: proxySecretKey,
            upstreamBaseUrl: "https://generativelanguage.googleapis.com",
            apiKeyHeader: "x-goog-api-key",
            apiKeyPrefix: "",
            config: {},
            enabled: true,
            updatedByMemberId: ownerId,
            now,
          });

          const virtualCodexId = makeTeamProviderInstanceId(
            teamId,
            ProviderInstanceId.make("srv-codex"),
          );
          const lease = yield* manager.getLeasedAccessToken(virtualCodexId);
          expect(lease.accessToken).toBe("team-server-leased-access");

          const virtuals = yield* manager.getVirtualProviderConfigs;
          const virtualAgyId = makeTeamProviderInstanceId(
            teamId,
            ProviderInstanceId.make("srv-agy-proxy"),
          );
          const agyConfig = virtuals[virtualAgyId];
          expect(agyConfig).toBeDefined();
          const agyInnerConfig = agyConfig?.config as Record<string, unknown> | undefined;
          expect(agyInnerConfig?.authMethod).toBe("gemini-api-key");
          expect(typeof agyInnerConfig?.apiKey).toBe("string");
          expect(agyInnerConfig?.apiKey).not.toBe("RAW_COMPANY_GEMINI_KEY");
          expect(
            agyConfig?.environment?.some((entry) => entry.value === "RAW_COMPANY_GEMINI_KEY"),
          ).toBe(false);
          expect(
            agyConfig?.environment?.find((entry) => entry.name === "GOOGLE_GEMINI_BASE_URL")?.value,
          ).toContain("/api/team/provider-proxy/srv-agy-proxy");
        } finally {
          yield* Effect.promise(
            () => new Promise<void>((resolve) => oauthServer.close(() => resolve())),
          );
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "never triggers token-lease refresh or >1h auto-resume on v0.1.13 Antigravity version refusal AcpTransportError(ProviderSetupError)",
    () =>
      Effect.gen(function* () {
        let leaseCount = 0;
        const teamId = TeamId.make("team-version-refusal");
        const mockTeamServer = NodeHttp.createServer((req, res) => {
          if (req.url?.startsWith("/api/team/assets")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                teamId,
                revision: 1,
                fullSync: true,
                skills: [],
                preprompts: [],
                deletedSkillIds: [],
                deletedPrepromptIds: [],
              }),
            );
            return;
          }
          if (req.method === "POST" && req.url?.startsWith("/api/team/provider-lease/")) {
            leaseCount += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                providerInstanceId: "team-agy",
                driver: "antigravity",
                accessToken: `leased-token-${leaseCount}`,
                tokenType: "Bearer",
                expiresAt: "2099-01-01T00:00:00.000Z",
                expiresInSeconds: 3600,
              }),
            );
            return;
          }
          res.writeHead(404);
          res.end();
        });
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => mockTeamServer.listen(0, "127.0.0.1", () => resolve())),
        );
        const port = (mockTeamServer.address() as { port: number }).port;

        try {
          const manager = yield* TeamProviderManager.TeamProviderManager;
          const agyVirtualId = makeTeamProviderInstanceId(
            teamId,
            ProviderInstanceId.make("team-agy"),
          );
          yield* manager.syncLocalTeamBinding({
            teamId,
            teamName: "Acme",
            teamServerUrl: `http://127.0.0.1:${port}`,
            memberToken: "bob-token",
            providers: [makeTeamProvider("team-agy", "antigravity", "token-lease")],
            projects: [],
            assetsRevision: NonNegativeInt.make(1),
          });

          const setupError = new ProviderSetupError({
            instanceId: agyVirtualId,
            operation: "runtime",
            detail:
              "Antigravity 1.5.0 only serves allowlisted editors, not T3 Code. Update it in Antigravity setup to 1.5.1 or newer, then retry.",
          });
          const versionRefusalError = new AcpErrors.AcpTransportError({
            detail: setupError.detail,
            cause: setupError,
          });

          let recycledCount = 0;
          const continuations: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
          const result = yield* manager.handleActiveTurnAuthFailure({
            virtualInstanceId: agyVirtualId,
            driver: ProviderDriverKind.make("antigravity"),
            threadId: ThreadId.make("thread-version-refusal"),
            providerThreadId: ProviderThreadId.make("pt-version-refusal"),
            runId: RunId.make("run-version-refusal"),
            error: versionRefusalError,
            recycleSession: () =>
              Effect.sync(() => {
                recycledCount += 1;
              }),
            requestContinuation: (req) =>
              Effect.sync(() => {
                continuations.push(req);
              }),
          });

          expect(result.handled).toBe(false);
          expect(result.revoked).toBe(false);
          expect(leaseCount).toBe(0);
          expect(recycledCount).toBe(0);
          expect(continuations).toHaveLength(0);
        } finally {
          yield* Effect.promise(
            () => new Promise<void>((resolve) => mockTeamServer.close(() => resolve())),
          );
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
