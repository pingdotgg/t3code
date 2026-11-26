// @effect-diagnostics nodeBuiltinImport:off -- Local mock Team Server HTTP endpoints for lease/revocation/delta tests.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  TeamId,
  TeamMemberId,
  TeamPrepromptId,
  TeamProviderId,
  TeamSkillId,
  TeamSkillSlug,
  ThreadId,
  makeTeamProviderInstanceId,
  type TeamPreprompt,
  type TeamProvider,
  type TeamSkill,
} from "@t3tools/contracts";
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

          // Personal project continues using personal providers cleanly.
          yield* manager.assertProviderAllowedForProject({
            projectId: personalProjectId,
            instanceId: ProviderInstanceId.make("codex"),
          });

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
            NodeFSP.access(NodePath.join(paths.profileDir, TEAM_ANTIGRAVITY_OAUTH_TOKEN_FILENAME))
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
});
