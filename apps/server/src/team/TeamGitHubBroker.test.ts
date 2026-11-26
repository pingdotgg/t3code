// @effect-diagnostics nodeBuiltinImport:off -- Spawns git/gh helper scripts and runs a local fake GitHub API for broker verification.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId, EnvironmentId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { applyProviderSessionEnvironmentOverride } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "@effect/vitest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TeamAssetsRepository from "./TeamAssetsRepository.ts";
import * as TeamGitHubBroker from "./TeamGitHubBroker.ts";
import * as TeamGitHubRepository from "./TeamGitHubRepository.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";

interface RecordedApiHit {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
}

function startFakeGitHubServer() {
  const hits: Array<RecordedApiHit> = [];
  return new Promise<{
    readonly baseUrl: string;
    readonly hits: () => ReadonlyArray<RecordedApiHit>;
    readonly close: () => Promise<void>;
  }>((resolve, reject) => {
    const server = NodeHttp.createServer((req, res) => {
      hits.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        authorization: req.headers.authorization,
      });
      const auth = req.headers.authorization;
      if (req.url === "/user") {
        if (auth === "Bearer PAT_ALICE") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: 101,
              login: "alice-gh",
              name: "Alice Owner",
              email: "alice@test.example",
            }),
          );
          return;
        }
        if (auth === "Bearer PAT_BOB") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: 202,
              login: "bob-gh",
              name: "Bob Regular",
              email: "bob@test.example",
            }),
          );
          return;
        }
        if (auth === "Bearer PAT_BOT") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: 303,
              login: "acme-automation",
              name: "Acme Bot",
              email: "bot@test.example",
            }),
          );
          return;
        }
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Bad credentials" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not found" }));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        hits: () => [...hits],
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

function makeBrokerStack() {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer);
  const base = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-team-gh-broker-test-",
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
  return TeamGitHubBroker.layer.pipe(Layer.provideMerge(teamService));
}

function runHelper(command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) {
  return Effect.promise<{
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>(
    () =>
      new Promise((resolve) => {
        const child = NodeChildProcess.spawn(command, args, { env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("close", (status) => resolve({ status, stdout, stderr }));
        child.on("error", () => resolve({ status: 1, stdout, stderr }));
      }),
  );
}

describe("TeamGitHubBroker", () => {
  it("enforces fail-closed local-only HTTP checks (rejects forwarded headers and non-loopback peers)", () => {
    expect(
      TeamGitHubBroker.isLocalBrokerHttpRequest(
        { headers: {}, socket: { remoteAddress: "127.0.0.1" } as never },
        false,
      ),
    ).toBe(true);
    expect(
      TeamGitHubBroker.isLocalBrokerHttpRequest(
        { headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } as never },
        false,
      ),
    ).toBe(true);
    expect(
      TeamGitHubBroker.isLocalBrokerHttpRequest(
        {
          headers: { "x-forwarded-for": "127.0.0.1" },
          socket: { remoteAddress: "127.0.0.1" } as never,
        },
        false,
      ),
    ).toBe(false);
    expect(
      TeamGitHubBroker.isLocalBrokerHttpRequest(
        { headers: { forwarded: "for=127.0.0.1" }, socket: {} as never },
        true,
      ),
    ).toBe(false);
    expect(
      TeamGitHubBroker.isLocalBrokerHttpRequest(
        { headers: {}, socket: { remoteAddress: "192.168.1.25" } as never },
        false,
      ),
    ).toBe(false);
    expect(
      TeamGitHubBroker.isLocalBrokerHttpRequest(
        { headers: {}, socket: { remoteAddress: undefined } as never },
        false,
      ),
    ).toBe(false);
  });

  it.live(
    "brokers per-turn GIT_ASKPASS and gh wrapper without static GH_TOKEN and revokes on turn end, Interrupt, Send now, and suspension",
    () =>
      Effect.gen(function* () {
        const fakeGitHub = yield* Effect.acquireRelease(
          Effect.promise(() => startFakeGitHubServer()),
          (m) => Effect.promise(() => m.close()),
        );
        const teamService = yield* TeamService.TeamService;
        const broker = yield* TeamGitHubBroker.TeamGitHubBroker;
        const sessionStore = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;

        const ownerSession = yield* sessionStore.issue({
          subject: "alice",
          scopes: ["orchestration:read", "orchestration:operate", "access:write"],
          client: { label: "Alice", deviceType: "desktop", os: "linux" },
        });
        const init = yield* teamService.initializeTeam({
          sessionId: ownerSession.sessionId,
          payload: { name: "Acme", ownerPseudo: "alice" },
        });
        const aliceId = init.owner.id;

        const invite = yield* teamService.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "regular", prefilledPseudo: "bob" },
        });
        const bobRedeem = yield* teamService.redeemInvite({
          token: invite.token,
          pseudo: "bob",
          client: { label: "Bob", deviceType: "desktop", os: "linux" },
        });
        const bobId = bobRedeem.member.id;
        const bobSessionRows = yield* sql<{ readonly session_id: string }>`
            SELECT session_id FROM team_session_meta WHERE member_id = ${bobId} LIMIT 1
          `;
        const bobSessionId = AuthSessionId.make(bobSessionRows[0]!.session_id);

        // Connect Alice and Bob PATs
        yield* teamService.connectMyGitHub({
          sessionId: ownerSession.sessionId,
          payload: { token: "PAT_ALICE", apiBaseUrl: fakeGitHub.baseUrl },
        });
        yield* teamService.connectMyGitHub({
          sessionId: bobSessionId,
          payload: { token: "PAT_BOB", apiBaseUrl: fakeGitHub.baseUrl },
        });

        // Verify privacy: Alice cannot see Bob's GitHub identity, Bob cannot see Alice's
        const aliceState = yield* teamService.getState(ownerSession.sessionId);
        const bobState = yield* teamService.getState(bobSessionId);
        expect(aliceState.myGitHubIdentity?.githubLogin).toBe("alice-gh");
        expect(bobState.myGitHubIdentity?.githubLogin).toBe("bob-gh");
        expect(aliceState.automationGitHubIdentity).toBeNull();
        expect(bobState.automationGitHubIdentity).toBeNull();

        const threadId = ThreadId.make("thread-gh-1");
        yield* teamService.recordThreadCreated({
          sessionId: ownerSession.sessionId,
          threadId,
        });
        const aliceSessionId = ProviderSessionId.make("ps-alice");
        const aliceSessionOverride = yield* broker.prepareSessionEnvironment({
          providerSessionId: aliceSessionId,
          threadId,
          authorKind: "member",
          authorMemberId: aliceId,
        });
        expect(aliceSessionOverride).not.toBeNull();

        // Merge on top of a host env that HAS a static GH_TOKEN to prove it is completely stripped.
        const aliceChildEnv = applyProviderSessionEnvironmentOverride(
          {
            ...process.env,
            GH_TOKEN: "HOST_LEAKED_STATIC_TOKEN",
            GITHUB_TOKEN: "HOST_LEAKED_GITHUB_TOKEN",
          },
          aliceSessionOverride!,
        );
        expect(aliceChildEnv.GH_TOKEN).toBeUndefined();
        expect(aliceChildEnv.GITHUB_TOKEN).toBeUndefined();
        expect(aliceChildEnv.GIT_AUTHOR_NAME).toBe("Alice Owner");
        expect(aliceChildEnv.GIT_AUTHOR_EMAIL).toBe("alice@test.example");
        expect(aliceChildEnv.GIT_TERMINAL_PROMPT).toBe("0");

        // Before any turn is active -> fail-closed!
        const askpassIdle = yield* runHelper(
          aliceChildEnv.GIT_ASKPASS!,
          ["Password for 'https://github.com':"],
          aliceChildEnv,
        );
        expect(askpassIdle.status).not.toBe(0);
        expect(askpassIdle.stdout).toBe("");

        const ghIdle = yield* runHelper("gh", ["auth", "token"], aliceChildEnv);
        expect(ghIdle.status).not.toBe(0);

        // Activate Alice's Turn 1
        yield* teamService.recordTurnAuthoredByMember({
          memberId: aliceId,
          threadId,
          turnId: "turn-1",
        });
        yield* broker.activateLocalTurnLease({
          threadId,
          turnId: "turn-1",
          providerSessionId: aliceSessionId,
          authorKind: "member",
          authorMemberId: aliceId,
        });

        const askpassUser = yield* runHelper(
          aliceChildEnv.GIT_ASKPASS!,
          ["Username for 'https://github.com':"],
          aliceChildEnv,
        );
        expect(askpassUser.status).toBe(0);
        expect(askpassUser.stdout.trim()).toBe("alice-gh");

        const askpassPass = yield* runHelper(
          aliceChildEnv.GIT_ASKPASS!,
          ["Password for 'https://github.com':"],
          aliceChildEnv,
        );
        expect(askpassPass.status).toBe(0);
        expect(askpassPass.stdout.trim()).toBe("PAT_ALICE");

        const ghTokenActive = yield* runHelper("gh", ["auth", "token"], aliceChildEnv);
        expect(ghTokenActive.status).toBe(0);
        expect(ghTokenActive.stdout.trim()).toBe("PAT_ALICE");

        const ghApiActive = yield* runHelper("gh", ["api", "/user"], aliceChildEnv);
        expect(ghApiActive.status).toBe(0);
        expect(JSON.parse(ghApiActive.stdout)).toMatchObject({ login: "alice-gh" });

        // Revoke immediately via owner/admin Interrupt hook!
        yield* teamService.notifyTurnInterrupted({
          actor: { kind: "session", sessionId: ownerSession.sessionId },
          threadId,
          runId: "turn-1",
          reason: "interrupt",
        });
        const afterInterrupt = yield* runHelper("gh", ["auth", "token"], aliceChildEnv);
        expect(afterInterrupt.status).not.toBe(0);

        // Bob's Turn 2 on the same thread (recycled session)
        yield* broker.revokeSessionChannel(aliceSessionId);
        const bobProviderSessionId = ProviderSessionId.make("ps-bob");
        const bobSessionOverride = yield* broker.prepareSessionEnvironment({
          providerSessionId: bobProviderSessionId,
          threadId,
          authorKind: "member",
          authorMemberId: bobId,
        });
        const bobChildEnv = applyProviderSessionEnvironmentOverride(
          process.env,
          bobSessionOverride!,
        );
        expect(bobChildEnv.GIT_AUTHOR_NAME).toBe("Bob Regular");
        expect(bobChildEnv.GIT_AUTHOR_EMAIL).toBe("bob@test.example");

        yield* teamService.recordTurnAuthoredByMember({
          memberId: bobId,
          threadId,
          turnId: "turn-2",
        });
        yield* broker.activateLocalTurnLease({
          threadId,
          turnId: "turn-2",
          providerSessionId: bobProviderSessionId,
          authorKind: "member",
          authorMemberId: bobId,
        });

        // Alice's old session broker token STILL fails even while Bob's turn is active!
        expect((yield* runHelper("gh", ["auth", "token"], aliceChildEnv)).status).not.toBe(0);
        // Bob's session receives Bob's token
        expect((yield* runHelper("gh", ["auth", "token"], bobChildEnv)).stdout.trim()).toBe(
          "PAT_BOB",
        );

        // Creator (Alice) clicks Send now (promote_to_steer) on Bob's foreign-authored turn -> IMMEDIATELY revokes Bob's lease!
        yield* teamService.notifyTurnInterrupted({
          actor: { kind: "session", sessionId: ownerSession.sessionId },
          threadId,
          runId: "turn-2",
          reason: "promote_to_steer",
        });
        expect((yield* runHelper("gh", ["auth", "token"], bobChildEnv)).status).not.toBe(0);

        // Team automation: when unconfigured, receives ZERO credentials (never borrows Alice's or Bob's PAT!)
        const autoSessionId = ProviderSessionId.make("ps-auto");
        const autoOverride = yield* broker.prepareSessionEnvironment({
          providerSessionId: autoSessionId,
          threadId,
          authorKind: "team_automation",
          authorMemberId: null,
        });
        const autoEnv = applyProviderSessionEnvironmentOverride(process.env, autoOverride!);
        expect(autoEnv.GIT_AUTHOR_NAME).toBeUndefined();
        yield* broker.activateLocalTurnLease({
          threadId,
          turnId: "turn-auto-1",
          providerSessionId: autoSessionId,
          authorKind: "team_automation",
          authorMemberId: null,
        });
        expect((yield* runHelper("gh", ["auth", "token"], autoEnv)).status).not.toBe(0);

        // Regular Bob cannot configure team automation GitHub account
        const bobSetAuto = yield* Effect.result(
          teamService.setAutomationGitHub({
            sessionId: bobSessionId,
            payload: { token: "PAT_BOT", apiBaseUrl: fakeGitHub.baseUrl },
          }),
        );
        expect(bobSetAuto._tag).toBe("Failure");

        // Owner configures team automation GitHub account -> automation turn gets PAT_BOT
        yield* teamService.setAutomationGitHub({
          sessionId: ownerSession.sessionId,
          payload: { token: "PAT_BOT", apiBaseUrl: fakeGitHub.baseUrl },
        });
        yield* broker.activateLocalTurnLease({
          threadId,
          turnId: "turn-auto-2",
          providerSessionId: autoSessionId,
          authorKind: "team_automation",
          authorMemberId: null,
        });
        expect((yield* runHelper("gh", ["auth", "token"], autoEnv)).stdout.trim()).toBe("PAT_BOT");

        // Clearing automation account immediately revokes active automation turn lease
        yield* teamService.clearAutomationGitHub({ sessionId: ownerSession.sessionId });
        expect((yield* runHelper("gh", ["auth", "token"], autoEnv)).status).not.toBe(0);

        // Member suspension immediately revokes active turn lease
        yield* broker.activateLocalTurnLease({
          threadId,
          turnId: "turn-bob-3",
          providerSessionId: bobProviderSessionId,
          authorKind: "member",
          authorMemberId: bobId,
        });
        expect((yield* runHelper("gh", ["auth", "token"], bobChildEnv)).stdout.trim()).toBe(
          "PAT_BOB",
        );
        yield* teamService.updateMemberStatus({
          sessionId: ownerSession.sessionId,
          payload: { memberId: bobId, status: "suspended" },
        });
        expect((yield* runHelper("gh", ["auth", "token"], bobChildEnv)).status).not.toBe(0);
      }).pipe(Effect.scoped, Effect.provide(makeBrokerStack())),
  );

  it.live(
    "mints single-turn remote credential leases strictly bound to (environmentId, threadId, turnId, authorMemberId)",
    () =>
      Effect.gen(function* () {
        const fakeGitHub = yield* Effect.acquireRelease(
          Effect.promise(() => startFakeGitHubServer()),
          (m) => Effect.promise(() => m.close()),
        );
        const teamService = yield* TeamService.TeamService;
        const broker = yield* TeamGitHubBroker.TeamGitHubBroker;
        const sessionStore = yield* SessionStore.SessionStore;

        const ownerSession = yield* sessionStore.issue({
          subject: "alice",
          scopes: ["orchestration:read", "orchestration:operate", "access:write"],
          client: { label: "Alice", deviceType: "desktop", os: "linux" },
        });
        const init = yield* teamService.initializeTeam({
          sessionId: ownerSession.sessionId,
          payload: { name: "Acme", ownerPseudo: "alice" },
        });
        yield* teamService.connectMyGitHub({
          sessionId: ownerSession.sessionId,
          payload: { token: "PAT_ALICE", apiBaseUrl: fakeGitHub.baseUrl },
        });

        const envId = EnvironmentId.make("remote-env-1");
        const threadId = ThreadId.make("thread-remote-1");
        const issued = yield* broker.issueRemoteTurnLease({
          teamId: init.team.id,
          environmentId: envId,
          threadId,
          turnId: "turn-r1",
          authorKind: "member",
          authorMemberId: init.owner.id,
        });
        expect(issued.hasCredential).toBe(true);
        expect(issued.leaseId).not.toBeNull();
        expect(issued.leaseToken).not.toBeNull();

        // Exact tuple resolves
        const resolved = yield* broker.resolveRemoteTurnLease({
          leaseId: issued.leaseId!,
          leaseToken: issued.leaseToken!,
          environmentId: envId,
          threadId,
          turnId: "turn-r1",
        });
        expect(resolved?.token).toBe("PAT_ALICE");

        // Mismatched environmentId, threadId, turnId, or leaseToken are rejected
        expect(
          yield* broker.resolveRemoteTurnLease({
            leaseId: issued.leaseId!,
            leaseToken: issued.leaseToken!,
            environmentId: EnvironmentId.make("remote-env-OTHER"),
            threadId,
            turnId: "turn-r1",
          }),
        ).toBeNull();
        expect(
          yield* broker.resolveRemoteTurnLease({
            leaseId: issued.leaseId!,
            leaseToken: issued.leaseToken!,
            environmentId: envId,
            threadId: ThreadId.make("thread-OTHER"),
            turnId: "turn-r1",
          }),
        ).toBeNull();
        expect(
          yield* broker.resolveRemoteTurnLease({
            leaseId: issued.leaseId!,
            leaseToken: issued.leaseToken!,
            environmentId: envId,
            threadId,
            turnId: "turn-OTHER",
          }),
        ).toBeNull();
        expect(
          yield* broker.resolveRemoteTurnLease({
            leaseId: issued.leaseId!,
            leaseToken: "wrong-token",
            environmentId: envId,
            threadId,
            turnId: "turn-r1",
          }),
        ).toBeNull();

        // Immediate revocation stops resolution immediately
        const revoked = yield* broker.revokeRemoteTurnLease({
          leaseId: issued.leaseId!,
          leaseToken: issued.leaseToken!,
        });
        expect(revoked).toBe(true);
        expect(
          yield* broker.resolveRemoteTurnLease({
            leaseId: issued.leaseId!,
            leaseToken: issued.leaseToken!,
            environmentId: envId,
            threadId,
            turnId: "turn-r1",
          }),
        ).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(makeBrokerStack())),
  );
});
