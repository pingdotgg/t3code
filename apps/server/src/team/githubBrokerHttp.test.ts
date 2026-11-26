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

        const testContext = yield* Effect.context<
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

          // Alice issues single-turn lease on admin-only env
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
        } finally {
          yield* Effect.promise(() => dispose());
        }
      }).pipe(Effect.scoped, Effect.provide(fullLayer));
    },
  );
});
