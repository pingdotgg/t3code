// @effect-diagnostics nodeBuiltinImport:off -- Local mock GitHub API for remote lease HTTP route tests.
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentId,
  TeamEnvironmentRecordId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { describe, expect, it } from "@effect/vitest";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as TeamAssetsRepository from "./TeamAssetsRepository.ts";
import * as TeamGitHubBroker from "./TeamGitHubBroker.ts";
import * as TeamGitHubHttp from "./githubBrokerHttp.ts";
import * as TeamGitHubRepository from "./TeamGitHubRepository.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";

function startMockGitHubApi() {
  return new Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }>(
    (resolve, reject) => {
      const server = NodeHttp.createServer((req, res) => {
        if (req.url === "/user" && req.headers.authorization === "Bearer PAT_ALICE") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: 1,
              login: "alice-gh",
              name: "Alice",
              email: "alice@acme.dev",
            }),
          );
          return;
        }
        if (req.url === "/user" && req.headers.authorization === "Bearer PAT_BOB") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: 2,
              login: "bob-gh",
              name: "Bob",
              email: "bob@acme.dev",
            }),
          );
          return;
        }
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Unauthorized" }));
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () =>
            new Promise<void>((done) => {
              server.closeAllConnections?.();
              server.close(() => done());
            }),
        });
      });
    },
  );
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

describe("TeamGitHubHttp (/api/team/github-lease/*)", () => {
  it.live(
    "enforces environment ACL, blocks cross-member spoofing, resolves exact tuple, and revokes cleanly",
    () => {
      const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer);
      const base = ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-team-gh-http-test-",
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
        Layer.provideMerge(secrets),
        Layer.provideMerge(serverEnv),
        Layer.provideMerge(base),
      );
      const fullLayer = Layer.mergeAll(
        TeamGitHubBroker.layer.pipe(Layer.provideMerge(teamService)),
        envAuth,
      );

      return Effect.gen(function* () {
        const mockGitHub = yield* Effect.acquireRelease(
          Effect.promise(() => startMockGitHubApi()),
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
        const sessionStore = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;

        const aliceSession = yield* sessionStore.issue({
          subject: "alice",
          scopes: ["orchestration:read", "orchestration:operate", "access:write"],
          client: { label: "Alice", deviceType: "desktop", os: "linux" },
        });
        const init = yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Acme", ownerPseudo: "alice" },
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

        yield* team.connectMyGitHub({
          sessionId: aliceSession.sessionId,
          payload: { token: "PAT_ALICE", apiBaseUrl: mockGitHub.baseUrl },
        });
        yield* team.connectMyGitHub({
          sessionId: bobSessionId,
          payload: { token: "PAT_BOB", apiBaseUrl: mockGitHub.baseUrl },
        });

        const adminOnlyEnvId = EnvironmentId.make("env-admin-only");
        yield* repo.createEnvironment({
          id: TeamEnvironmentRecordId.make("te-1"),
          teamId: init.team.id,
          environmentId: adminOnlyEnvId,
          name: "Admin Runner",
          isDefault: false,
          peerLinkId: null,
          accessRule: { roles: ["owner", "admin"], memberIds: [] },
          createdAt: "2026-11-26T12:00:00.000Z",
          updatedAt: "2026-11-26T12:00:00.000Z",
        });

        const aliceToken = (yield* team.issueLocalSyncToken(aliceSession.sessionId)).token;
        const bobToken = (yield* team.issueLocalSyncToken(bobSessionId)).token;

        const seedAttributedTurn = (input: {
          readonly threadId: ThreadId;
          readonly turnId: string;
          readonly environmentId: EnvironmentId;
          readonly creatorMemberId: typeof init.owner.id;
          readonly authorMemberId: typeof init.owner.id;
          readonly viewId?: typeof init.team.defaultViewId;
          readonly locked?: boolean;
        }) =>
          Effect.gen(function* () {
            yield* repo.recordThreadAttribution({
              threadId: input.threadId,
              teamId: init.team.id,
              creatorMemberId: input.creatorMemberId,
              viewId: input.viewId ?? init.team.defaultViewId,
              ...(input.locked !== undefined ? { locked: input.locked } : {}),
              executionEnvironmentId: input.environmentId,
              createdAt: "2026-11-26T12:00:00.000Z",
            });
            yield* repo.recordTurnAttribution({
              turnId: input.turnId,
              threadId: input.threadId,
              authorMemberId: input.authorMemberId,
              createdAt: "2026-11-26T12:00:00.000Z",
            });
          });

        const testContext = yield* Effect.context<
          | TeamService.TeamService
          | TeamRepository.TeamRepository
          | TeamAssetsRepository.TeamAssetsRepository
          | TeamGitHubBroker.TeamGitHubBroker
          | AuthSessions.AuthSessionRepository
          | EnvironmentAuth.EnvironmentAuth
        >();
        const routerLayer = TeamGitHubHttp.layer.pipe(
          Layer.provideMerge(Layer.succeedContext(testContext)),
        );
        const { handler, dispose } = HttpRouter.toWebHandler(routerLayer, {
          disableLogger: true,
        });
        const callHandler = (url: string, body: unknown, token?: string) =>
          Effect.promise(() =>
            handler(
              new Request(url, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify(body),
              }),
            ),
          );

        try {
          // Unknown hub-local turn is rejected (P1-2)
          const missingTupleRes = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: EnvironmentId.make("default-team-environment"),
              threadId: ThreadId.make("t-nonexistent"),
              turnId: "turn-nonexistent",
            },
            aliceToken,
          );
          expect(missingTupleRes.status).toBe(404);

          yield* seedAttributedTurn({
            threadId: ThreadId.make("t-1"),
            turnId: "turn-1",
            environmentId: adminOnlyEnvId,
            creatorMemberId: init.owner.id,
            authorMemberId: init.owner.id,
          });

          // Regular Bob is denied on admin-only environment
          const bobDenied = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-1"),
              turnId: "turn-1",
            },
            bobToken,
          );
          expect(bobDenied.status).toBe(403);

          // Alice cannot spoof Bob's memberId
          const spoofRes = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-1"),
              turnId: "turn-1",
              authorMemberId: bobJoined.member.id,
            },
            aliceToken,
          );
          expect(spoofRes.status).toBe(403);

          // Alice issues single-turn lease on admin-only env for her attributed turn
          const issueRes = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-1"),
              turnId: "turn-1",
            },
            aliceToken,
          );
          expect(issueRes.status).toBe(200);
          const issued = (yield* Effect.promise(() => issueRes.json())) as {
            readonly hasCredential: boolean;
            readonly leaseId: string;
            readonly leaseToken: string;
          };
          expect(issued.hasCredential).toBe(true);

          // Resolve works with exact tuple
          const resolveRes = yield* callHandler("http://team.local/api/team/github-lease/resolve", {
            leaseId: issued.leaseId,
            leaseToken: issued.leaseToken,
            environmentId: adminOnlyEnvId,
            threadId: ThreadId.make("t-1"),
            turnId: "turn-1",
          });
          expect(resolveRes.status).toBe(200);
          expect(yield* Effect.promise(() => resolveRes.json())).toMatchObject({
            token: "PAT_ALICE",
            githubLogin: "alice-gh",
          });

          // Bob cannot revoke Alice's lease without the leaseToken
          const bobRevokeRes = yield* callHandler(
            "http://team.local/api/team/github-lease/revoke",
            { leaseId: issued.leaseId },
            bobToken,
          );
          expect(bobRevokeRes.status).toBe(200);
          expect(yield* Effect.promise(() => bobRevokeRes.json())).toEqual({ revoked: false });

          // Remote environment revokes using (leaseId, leaseToken)
          const revokeRes = yield* callHandler("http://team.local/api/team/github-lease/revoke", {
            leaseId: issued.leaseId,
            leaseToken: issued.leaseToken,
          });
          expect(revokeRes.status).toBe(200);
          expect(yield* Effect.promise(() => revokeRes.json())).toEqual({ revoked: true });

          // Subsequent resolve fails closed with 403
          const resolveAfter = yield* callHandler(
            "http://team.local/api/team/github-lease/resolve",
            {
              leaseId: issued.leaseId,
              leaseToken: issued.leaseToken,
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-1"),
              turnId: "turn-1",
            },
          );
          expect(resolveAfter.status).toBe(403);

          // Shared environment: verify foreign-tuple DoS rejection (P1-2) and ACL/detach revocation
          const sharedEnvId = EnvironmentId.make("env-shared-acl");
          yield* repo.createEnvironment({
            id: TeamEnvironmentRecordId.make("te-2"),
            teamId: init.team.id,
            environmentId: sharedEnvId,
            name: "Shared Runner",
            isDefault: false,
            peerLinkId: null,
            accessRule: { roles: ["owner", "admin", "regular"], memberIds: [] },
            createdAt: "2026-11-26T12:00:00.000Z",
            updatedAt: "2026-11-26T12:00:00.000Z",
          });

          // P1-2: Bob cannot pre-reserve/DoS Alice's attributed queued turn on a shared environment
          yield* seedAttributedTurn({
            threadId: ThreadId.make("t-alice-queued"),
            turnId: "turn-alice-queued-1",
            environmentId: sharedEnvId,
            creatorMemberId: init.owner.id,
            authorMemberId: init.owner.id,
          });
          const bobDosRes = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: sharedEnvId,
              threadId: ThreadId.make("t-alice-queued"),
              turnId: "turn-alice-queued-1",
            },
            bobToken,
          );
          expect(bobDosRes.status).toBe(403);
          const aliceLegitAfterDos = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: sharedEnvId,
              threadId: ThreadId.make("t-alice-queued"),
              turnId: "turn-alice-queued-1",
            },
            aliceToken,
          );
          expect(aliceLegitAfterDos.status).toBe(200);
          expect(yield* Effect.promise(() => aliceLegitAfterDos.json())).toMatchObject({
            hasCredential: true,
          });

          // Attached runners may start a turn before its attribution reaches the hub.
          const runnerTurn = {
            environmentId: sharedEnvId,
            threadId: ThreadId.make("runner-local-thread"),
            turnId: "runner-local-turn",
          };
          const authorLeases = [];
          for (const [token, login] of [
            [bobToken, "bob-gh"],
            [aliceToken, "alice-gh"],
          ] as const) {
            const response = yield* callHandler(
              "http://team.local/api/team/github-lease/issue",
              runnerTurn,
              token,
            );
            expect(response.status).toBe(200);
            const lease = (yield* Effect.promise(() => response.json())) as {
              readonly leaseId: string;
              readonly leaseToken: string;
            };
            authorLeases.push({ lease, login });
          }
          for (const { lease, login } of authorLeases) {
            const response = yield* callHandler("http://team.local/api/team/github-lease/resolve", {
              ...runnerTurn,
              leaseId: lease.leaseId,
              leaseToken: lease.leaseToken,
            });
            expect(response.status).toBe(200);
            expect(yield* Effect.promise(() => response.json())).toMatchObject({
              githubLogin: login,
            });
          }

          yield* seedAttributedTurn({
            threadId: ThreadId.make("t-shared"),
            turnId: "turn-shared-1",
            environmentId: sharedEnvId,
            creatorMemberId: bobJoined.member.id,
            authorMemberId: bobJoined.member.id,
          });
          const bobIssueRes = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: sharedEnvId,
              threadId: ThreadId.make("t-shared"),
              turnId: "turn-shared-1",
            },
            bobToken,
          );
          expect(bobIssueRes.status).toBe(200);
          const bobLease = (yield* Effect.promise(() => bobIssueRes.json())) as {
            readonly hasCredential: boolean;
            readonly leaseId: string;
            readonly leaseToken: string;
          };
          expect(bobLease.hasCredential).toBe(true);

          // Alice cannot clobber Bob's attributed turn tuple either (403 foreign turn)
          const aliceCollisionRes = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: sharedEnvId,
              threadId: ThreadId.make("t-shared"),
              turnId: "turn-shared-1",
            },
            aliceToken,
          );
          expect(aliceCollisionRes.status).toBe(403);
          // Bob's lease still resolves cleanly
          const bobStillValid = yield* callHandler(
            "http://team.local/api/team/github-lease/resolve",
            {
              leaseId: bobLease.leaseId,
              leaseToken: bobLease.leaseToken,
              environmentId: sharedEnvId,
              threadId: ThreadId.make("t-shared"),
              turnId: "turn-shared-1",
            },
          );
          expect(bobStillValid.status).toBe(200);

          // Narrowing environment ACL to owner/admin immediately revokes & blocks Bob's lease
          yield* team.updateEnvironment({
            sessionId: aliceSession.sessionId,
            payload: {
              environmentId: sharedEnvId,
              accessRule: { roles: ["owner", "admin"], memberIds: [] },
            },
          });
          const bobAfterAcl = yield* callHandler(
            "http://team.local/api/team/github-lease/resolve",
            {
              leaseId: bobLease.leaseId,
              leaseToken: bobLease.leaseToken,
              environmentId: sharedEnvId,
              threadId: ThreadId.make("t-shared"),
              turnId: "turn-shared-1",
            },
          );
          expect(bobAfterAcl.status).toBe(403);

          // Alice issues on sharedEnvId, then detaching sharedEnvId immediately revokes Alice's lease
          yield* seedAttributedTurn({
            threadId: ThreadId.make("t-detach"),
            turnId: "turn-detach-1",
            environmentId: sharedEnvId,
            creatorMemberId: init.owner.id,
            authorMemberId: init.owner.id,
          });
          const aliceOnShared = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: sharedEnvId,
              threadId: ThreadId.make("t-detach"),
              turnId: "turn-detach-1",
            },
            aliceToken,
          );
          expect(aliceOnShared.status).toBe(200);
          const aliceDetachLease = (yield* Effect.promise(() => aliceOnShared.json())) as {
            readonly leaseId: string;
            readonly leaseToken: string;
          };
          yield* team.detachEnvironment({
            sessionId: aliceSession.sessionId,
            payload: { environmentId: sharedEnvId, unlinkPeer: false },
          });
          const aliceAfterDetach = yield* callHandler(
            "http://team.local/api/team/github-lease/resolve",
            {
              leaseId: aliceDetachLease.leaseId,
              leaseToken: aliceDetachLease.leaseToken,
              environmentId: sharedEnvId,
              threadId: ThreadId.make("t-detach"),
              turnId: "turn-detach-1",
            },
          );
          expect(aliceAfterDetach.status).toBe(403);

          // Restricted read-only sessions (missing orchestration:operate) are denied lease issuance
          // on BOTH direct HTTP session auth AND local-sync token auth!
          const readOnlyAliceSession = yield* sessionStore.issue({
            subject: "alice-ro",
            scopes: ["orchestration:read"],
            client: { label: "Alice ReadOnly", deviceType: "desktop", os: "linux" },
          });
          yield* repo.bindSession({
            sessionId: readOnlyAliceSession.sessionId,
            teamId: init.team.id,
            memberId: init.owner.id,
            boundAt: "2026-11-26T12:00:00.000Z",
          });
          const roDirectIssue = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-ro-direct"),
              turnId: "turn-ro-1",
            },
            readOnlyAliceSession.token,
          );
          expect(roDirectIssue.status).toBe(403);

          const roSyncToken = (yield* team.issueLocalSyncToken(readOnlyAliceSession.sessionId))
            .token;
          const roSyncIssue = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-ro-sync"),
              turnId: "turn-ro-2",
            },
            roSyncToken,
          );
          expect(roSyncIssue.status).toBe(403);

          // Admin session without access:write cannot issue team_automation leases
          const operateOnlyAlice = yield* sessionStore.issue({
            subject: "alice-op",
            scopes: ["orchestration:read", "orchestration:operate"],
            client: { label: "Alice OpOnly", deviceType: "desktop", os: "linux" },
          });
          yield* repo.bindSession({
            sessionId: operateOnlyAlice.sessionId,
            teamId: init.team.id,
            memberId: init.owner.id,
            boundAt: "2026-11-26T12:00:00.000Z",
          });
          const autoWithoutAccessWrite = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-auto-scope"),
              turnId: "turn-auto-scope",
              authorKind: "team_automation",
            },
            operateOnlyAlice.token,
          );
          expect(autoWithoutAccessWrite.status).toBe(403);

          // Promoting Bob to admin lets him issue on adminOnlyEnvId; demoting Bob back to regular
          // proactively purges his active remote lease on adminOnlyEnvId!
          yield* team.updateMemberRole({
            sessionId: aliceSession.sessionId,
            payload: { memberId: bobJoined.member.id, role: "admin" },
          });
          yield* seedAttributedTurn({
            threadId: ThreadId.make("t-demote"),
            turnId: "turn-demote-1",
            environmentId: adminOnlyEnvId,
            creatorMemberId: bobJoined.member.id,
            authorMemberId: bobJoined.member.id,
          });
          const bobAdminIssue = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-demote"),
              turnId: "turn-demote-1",
            },
            bobToken,
          );
          expect(bobAdminIssue.status).toBe(200);
          const bobAdminLease = (yield* Effect.promise(() => bobAdminIssue.json())) as {
            readonly leaseId: string;
            readonly leaseToken: string;
          };
          // Valid active lease can be renewed via /api/team/github-lease/renew
          const bobRenewOk = yield* callHandler("http://team.local/api/team/github-lease/renew", {
            leaseId: bobAdminLease.leaseId,
            leaseToken: bobAdminLease.leaseToken,
            environmentId: adminOnlyEnvId,
            threadId: ThreadId.make("t-demote"),
            turnId: "turn-demote-1",
          });
          expect(bobRenewOk.status).toBe(200);
          expect(yield* Effect.promise(() => bobRenewOk.json())).toMatchObject({
            expiresAt: expect.any(String),
          });
          yield* team.updateMemberRole({
            sessionId: aliceSession.sessionId,
            payload: { memberId: bobJoined.member.id, role: "regular" },
          });
          const teamBroker = yield* TeamGitHubBroker.TeamGitHubBroker;
          expect(
            yield* teamBroker.hasActiveTurnLease({
              threadId: ThreadId.make("t-demote"),
              turnId: "turn-demote-1",
            }),
          ).toBe(false);
          const bobDemoteRenew = yield* callHandler(
            "http://team.local/api/team/github-lease/renew",
            {
              leaseId: bobAdminLease.leaseId,
              leaseToken: bobAdminLease.leaseToken,
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-demote"),
              turnId: "turn-demote-1",
            },
          );
          expect(bobDemoteRenew.status).toBe(403);
          const bobDemoteResolve = yield* callHandler(
            "http://team.local/api/team/github-lease/resolve",
            {
              leaseId: bobAdminLease.leaseId,
              leaseToken: bobAdminLease.leaseToken,
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-demote"),
              turnId: "turn-demote-1",
            },
          );
          expect(bobDemoteResolve.status).toBe(403);

          // P1-3: Revoking the issuing session immediately invalidates its remote lease on resolve,
          // renew, and hasActiveTurnLease — even while the member remains active with another session!
          const aliceSecondSession = yield* sessionStore.issue({
            subject: "alice-ephemeral",
            scopes: ["orchestration:read", "orchestration:operate"],
            client: { label: "Alice Laptop", deviceType: "desktop", os: "linux" },
          });
          yield* repo.bindSession({
            sessionId: aliceSecondSession.sessionId,
            teamId: init.team.id,
            memberId: init.owner.id,
            boundAt: "2026-11-26T12:00:00.000Z",
          });
          yield* seedAttributedTurn({
            threadId: ThreadId.make("t-session-revoke"),
            turnId: "turn-session-revoke-1",
            environmentId: adminOnlyEnvId,
            creatorMemberId: init.owner.id,
            authorMemberId: init.owner.id,
          });
          const sessionIssueRes = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-session-revoke"),
              turnId: "turn-session-revoke-1",
            },
            aliceSecondSession.token,
          );
          expect(sessionIssueRes.status).toBe(200);
          const sessionLease = (yield* Effect.promise(() => sessionIssueRes.json())) as {
            readonly leaseId: string;
            readonly leaseToken: string;
          };
          expect(
            yield* teamBroker.hasActiveTurnLease({
              threadId: ThreadId.make("t-session-revoke"),
              turnId: "turn-session-revoke-1",
            }),
          ).toBe(true);
          yield* sessionStore.revoke(aliceSecondSession.sessionId);
          expect(
            yield* teamBroker.hasActiveTurnLease({
              threadId: ThreadId.make("t-session-revoke"),
              turnId: "turn-session-revoke-1",
            }),
          ).toBe(false);
          const afterSessionRevokeResolve = yield* callHandler(
            "http://team.local/api/team/github-lease/resolve",
            {
              leaseId: sessionLease.leaseId,
              leaseToken: sessionLease.leaseToken,
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-session-revoke"),
              turnId: "turn-session-revoke-1",
            },
          );
          expect(afterSessionRevokeResolve.status).toBe(403);
          const afterSessionRevokeRenew = yield* callHandler(
            "http://team.local/api/team/github-lease/renew",
            {
              leaseId: sessionLease.leaseId,
              leaseToken: sessionLease.leaseToken,
              environmentId: adminOnlyEnvId,
              threadId: ThreadId.make("t-session-revoke"),
              turnId: "turn-session-revoke-1",
            },
          );
          expect(afterSessionRevokeRenew.status).toBe(403);

          // P1-3: Absolute maxExpiresAtMs cap clamps renewal (expiry expiration tested with TestClock below)
          const boundedLease = yield* teamBroker.issueRemoteTurnLease({
            teamId: init.team.id,
            environmentId: adminOnlyEnvId,
            threadId: ThreadId.make("t-bounded"),
            turnId: "turn-bounded-1",
            authorKind: "member",
            authorMemberId: init.owner.id,
            issuingSessionId: aliceSession.sessionId,
            ttlMs: 1_000,
            maxLifetimeMs: 1_500,
          });
          expect(boundedLease.hasCredential).toBe(true);
          const renewedBounded = yield* teamBroker.renewRemoteTurnLease({
            leaseId: boundedLease.leaseId!,
            leaseToken: boundedLease.leaseToken!,
            environmentId: adminOnlyEnvId,
            threadId: ThreadId.make("t-bounded"),
            turnId: "turn-bounded-1",
            ttlMs: 60_000,
          });
          expect(renewedBounded).not.toBeNull();
          // Renewed expiry must be clamped to maxExpiresAtMs (within ~2s of issuance, not +60s).
          const issuedAtApproxMs = Date.parse(boundedLease.expiresAt!) - 1_000;
          expect(Date.parse(renewedBounded!.expiresAt) - issuedAtApproxMs).toBeLessThanOrEqual(
            2_000,
          );

          // P3-3: modo may revoke remote leases via session-auth HTTP on unlocked readable threads,
          // while locked threads and unreadable admin-only views remain admin-only.
          const modoInvite = yield* team.createInvite({
            sessionId: aliceSession.sessionId,
            payload: { role: "modo", prefilledPseudo: "carol" },
          });
          const carolJoined = yield* team.redeemInvite({
            token: modoInvite.token,
            pseudo: "carol",
            client: { label: "Carol", deviceType: "desktop", os: "linux" },
          });
          const carolSessionRows = yield* sql<{ readonly session_id: string }>`
            SELECT session_id FROM team_session_meta WHERE member_id = ${carolJoined.member.id} LIMIT 1
          `;
          const carolSessionId = AuthSessionId.make(carolSessionRows[0]!.session_id);
          const carolToken = (yield* team.issueLocalSyncToken(carolSessionId)).token;

          const modoEnvId = EnvironmentId.make("env-modo-test");
          yield* repo.createEnvironment({
            id: TeamEnvironmentRecordId.make("te-modo"),
            teamId: init.team.id,
            environmentId: modoEnvId,
            name: "Modo Test Runner",
            isDefault: false,
            peerLinkId: null,
            accessRule: { roles: ["owner", "admin", "modo", "regular"], memberIds: [] },
            createdAt: "2026-11-26T12:00:00.000Z",
            updatedAt: "2026-11-26T12:00:00.000Z",
          });
          const adminOnlyView = yield* team.createView({
            sessionId: aliceSession.sessionId,
            payload: {
              name: "Secret Ops",
              readRule: { roles: ["owner", "admin"], memberIds: [] },
              postRule: { roles: ["owner", "admin"], memberIds: [] },
            },
          });

          // 1. Unlocked readable thread: Carol (modo) CAN revoke Alice's remote lease
          yield* seedAttributedTurn({
            threadId: ThreadId.make("t-modo-unlocked"),
            turnId: "turn-modo-unlocked-1",
            environmentId: modoEnvId,
            creatorMemberId: init.owner.id,
            authorMemberId: init.owner.id,
            locked: false,
          });
          const unlockedIssueRes = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: modoEnvId,
              threadId: ThreadId.make("t-modo-unlocked"),
              turnId: "turn-modo-unlocked-1",
            },
            aliceToken,
          );
          expect(unlockedIssueRes.status).toBe(200);
          const unlockedLease = (yield* Effect.promise(() => unlockedIssueRes.json())) as {
            readonly leaseId: string;
            readonly leaseToken: string;
          };
          const carolRevokeUnlocked = yield* callHandler(
            "http://team.local/api/team/github-lease/revoke",
            { leaseId: unlockedLease.leaseId },
            carolToken,
          );
          expect(carolRevokeUnlocked.status).toBe(200);
          expect(yield* Effect.promise(() => carolRevokeUnlocked.json())).toEqual({
            revoked: true,
          });

          // 2. Locked thread: Carol (modo) CANNOT revoke Alice's remote lease
          yield* seedAttributedTurn({
            threadId: ThreadId.make("t-modo-locked"),
            turnId: "turn-modo-locked-1",
            environmentId: modoEnvId,
            creatorMemberId: init.owner.id,
            authorMemberId: init.owner.id,
            locked: true,
          });
          const lockedIssueRes = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: modoEnvId,
              threadId: ThreadId.make("t-modo-locked"),
              turnId: "turn-modo-locked-1",
            },
            aliceToken,
          );
          expect(lockedIssueRes.status).toBe(200);
          const lockedLease = (yield* Effect.promise(() => lockedIssueRes.json())) as {
            readonly leaseId: string;
            readonly leaseToken: string;
          };
          const carolRevokeLocked = yield* callHandler(
            "http://team.local/api/team/github-lease/revoke",
            { leaseId: lockedLease.leaseId },
            carolToken,
          );
          expect(carolRevokeLocked.status).toBe(200);
          expect(yield* Effect.promise(() => carolRevokeLocked.json())).toEqual({
            revoked: false,
          });
          // Locked lease remains valid for Alice
          const lockedStillValid = yield* callHandler(
            "http://team.local/api/team/github-lease/resolve",
            {
              leaseId: lockedLease.leaseId,
              leaseToken: lockedLease.leaseToken,
              environmentId: modoEnvId,
              threadId: ThreadId.make("t-modo-locked"),
              turnId: "turn-modo-locked-1",
            },
          );
          expect(lockedStillValid.status).toBe(200);

          // 3. Admin-only unreadable view: Carol (modo) CANNOT revoke Alice's remote lease
          yield* seedAttributedTurn({
            threadId: ThreadId.make("t-modo-secret-view"),
            turnId: "turn-modo-secret-1",
            environmentId: modoEnvId,
            creatorMemberId: init.owner.id,
            authorMemberId: init.owner.id,
            viewId: adminOnlyView.id,
            locked: false,
          });
          const secretIssueRes = yield* callHandler(
            "http://team.local/api/team/github-lease/issue",
            {
              environmentId: modoEnvId,
              threadId: ThreadId.make("t-modo-secret-view"),
              turnId: "turn-modo-secret-1",
            },
            aliceToken,
          );
          expect(secretIssueRes.status).toBe(200);
          const secretLease = (yield* Effect.promise(() => secretIssueRes.json())) as {
            readonly leaseId: string;
          };
          const carolRevokeSecret = yield* callHandler(
            "http://team.local/api/team/github-lease/revoke",
            { leaseId: secretLease.leaseId },
            carolToken,
          );
          expect(carolRevokeSecret.status).toBe(200);
          expect(yield* Effect.promise(() => carolRevokeSecret.json())).toEqual({
            revoked: false,
          });
        } finally {
          yield* Effect.promise(() => dispose());
        }
      }).pipe(Effect.scoped, Effect.provide(fullLayer));
    },
  );

  it.effect(
    "P1-3: enforces absolute maxExpiresAtMs expiration on renewRemoteTurnLease and resolveRemoteTurnLease via TestClock",
    () => {
      const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer);
      const base = ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-team-gh-http-clock-test-",
      }).pipe(Layer.provideMerge(platform));
      const persistence = SqlitePersistence.layerMemory.pipe(Layer.provide(base));
      const secrets = ServerSecretStore.layer.pipe(Layer.provide(base));
      const authSessions = AuthSessions.layer.pipe(Layer.provide(persistence));
      const serverEnv = ServerEnvironment.layer.pipe(Layer.provide(secrets), Layer.provide(base));
      const sessions = SessionStore.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(persistence, secrets, authSessions, serverEnv)),
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
        Layer.provideMerge(secrets),
        Layer.provideMerge(serverEnv),
        Layer.provideMerge(base),
      );
      const fullLayer = TeamGitHubBroker.layer.pipe(Layer.provideMerge(teamService));

      return Effect.gen(function* () {
        const team = yield* TeamService.TeamService;
        const repo = yield* TeamRepository.TeamRepository;
        const githubRepoSvc = yield* TeamGitHubRepository.TeamGitHubRepository;
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const sessionStore = yield* SessionStore.SessionStore;
        const broker = yield* TeamGitHubBroker.TeamGitHubBroker;

        const aliceSession = yield* sessionStore.issue({
          subject: "alice-clock",
          scopes: ["orchestration:read", "orchestration:operate", "access:write"],
          client: { label: "Alice", deviceType: "desktop", os: "linux" },
        });
        const init = yield* team.initializeTeam({
          sessionId: aliceSession.sessionId,
          payload: { name: "Acme", ownerPseudo: "alice" },
        });
        const secretKey = TeamGitHubRepository.teamMemberGitHubSecretKey(
          init.team.id,
          init.owner.id,
        );
        yield* TeamGitHubRepository.writeTeamGitHubSecret(secretStore, secretKey, {
          authMethod: "pat",
          accessToken: "PAT_ALICE_CLOCK",
          apiBaseUrl: "https://api.github.com",
          githubLogin: "alice-gh",
          githubName: "Alice",
          githubEmail: "alice@acme.dev",
        });
        yield* githubRepoSvc.upsertMemberCredential({
          memberId: init.owner.id,
          teamId: init.team.id,
          authMethod: "pat",
          githubLogin: "alice-gh",
          githubName: "Alice",
          githubEmail: "alice@acme.dev",
          apiBaseUrl: "https://api.github.com",
          secretKey,
          connectedAt: "2026-11-26T12:00:00.000Z",
          updatedAt: "2026-11-26T12:00:00.000Z",
        });
        const runnerEnvId = EnvironmentId.make("env-clock-runner");
        yield* repo.createEnvironment({
          id: TeamEnvironmentRecordId.make("te-clock"),
          teamId: init.team.id,
          environmentId: runnerEnvId,
          name: "Clock Runner",
          isDefault: false,
          peerLinkId: null,
          accessRule: { roles: ["owner", "admin", "regular"], memberIds: [] },
          createdAt: "2026-11-26T12:00:00.000Z",
          updatedAt: "2026-11-26T12:00:00.000Z",
        });

        const issued = yield* broker.issueRemoteTurnLease({
          teamId: init.team.id,
          environmentId: runnerEnvId,
          threadId: ThreadId.make("t-clock"),
          turnId: "turn-clock-1",
          authorKind: "member",
          authorMemberId: init.owner.id,
          issuingSessionId: aliceSession.sessionId,
          ttlMs: 10_000,
          maxLifetimeMs: 25_000,
        });
        expect(issued.hasCredential).toBe(true);

        // Advance 9s and renew by 60s -> clamped to 25s maxLifetimeMs from issuance.
        yield* TestClock.adjust("9 seconds");
        const renewed = yield* broker.renewRemoteTurnLease({
          leaseId: issued.leaseId!,
          leaseToken: issued.leaseToken!,
          environmentId: runnerEnvId,
          threadId: ThreadId.make("t-clock"),
          turnId: "turn-clock-1",
          ttlMs: 60_000,
        });
        expect(renewed).not.toBeNull();
        expect(Date.parse(renewed!.expiresAt)).toBe(25_000);

        // Advance past maxExpiresAtMs (total 26s): both renew and resolve fail closed.
        yield* TestClock.adjust("17 seconds");
        expect(
          yield* broker.renewRemoteTurnLease({
            leaseId: issued.leaseId!,
            leaseToken: issued.leaseToken!,
            environmentId: runnerEnvId,
            threadId: ThreadId.make("t-clock"),
            turnId: "turn-clock-1",
            ttlMs: 60_000,
          }),
        ).toBeNull();
        expect(
          yield* broker.resolveRemoteTurnLease({
            leaseId: issued.leaseId!,
            leaseToken: issued.leaseToken!,
            environmentId: runnerEnvId,
            threadId: ThreadId.make("t-clock"),
            turnId: "turn-clock-1",
          }),
        ).toBeNull();
        expect(
          yield* broker.hasActiveTurnLease({
            threadId: ThreadId.make("t-clock"),
            turnId: "turn-clock-1",
          }),
        ).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(fullLayer));
    },
  );
});
