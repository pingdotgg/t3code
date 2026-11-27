// @effect-diagnostics nodeBuiltinImport:off -- Spawns git/gh helper scripts and runs a local fake GitHub API for broker verification.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentId,
  ProviderSessionId,
  TeamEnvironmentRecordId,
  ThreadId,
} from "@t3tools/contracts";
import { applyProviderSessionEnvironmentOverride } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import * as BwrapSandbox from "./bwrapSandbox.ts";
import * as TeamGitHubBroker from "./TeamGitHubBroker.ts";
import * as TeamGitHubHttp from "./githubBrokerHttp.ts";
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

function runHelper(
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  cwd?: string,
) {
  return Effect.promise<{
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>(
    () =>
      new Promise((resolve) => {
        const child = NodeChildProcess.spawn(command, args, {
          env,
          ...(cwd === undefined ? {} : { cwd }),
        });
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

function swapAllowedGitHubOriginsEnv(nextValue: string | undefined): string | undefined {
  const prev = process.env.T3_TEAM_GITHUB_ALLOWED_API_ORIGINS;
  if (nextValue === undefined) {
    delete process.env.T3_TEAM_GITHUB_ALLOWED_API_ORIGINS;
  } else {
    process.env.T3_TEAM_GITHUB_ALLOWED_API_ORIGINS = nextValue;
  }
  return prev;
}

function withAllowedGitHubOrigins(origins: ReadonlyArray<string>) {
  return Effect.acquireRelease(
    Effect.sync(() => swapAllowedGitHubOriginsEnv(origins.join(","))),
    (prev) =>
      Effect.sync(() => {
        swapAllowedGitHubOriginsEnv(prev);
      }),
  );
}

describe("TeamGitHubBroker", () => {
  it("validates git-askpass prompts, allowed Git origins, gh api target boundaries, and GIT_CONFIG_COUNT append", () => {
    // GitHub.com mapping
    expect(TeamGitHubBroker.deriveAllowedGitOrigin("https://api.github.com")?.origin).toBe(
      "https://github.com",
    );
    expect(TeamGitHubBroker.deriveAllowedGitOrigin("https://ghe.corp.example/api/v3")?.origin).toBe(
      "https://ghe.corp.example",
    );

    const ghPass = TeamGitHubBroker.parseGitAskpassPrompt(
      "Password for 'https://alice@github.com':",
    );
    expect(ghPass?.kind).toBe("password");
    expect(
      TeamGitHubBroker.isGitAskpassTargetAllowed(ghPass!.targetUrl, "https://api.github.com"),
    ).toBe(true);

    // Reject foreign hosts, suffix tricks, HTTP downgrade, different GHE hosts, and unrecognized prompts
    for (const badPrompt of [
      "Password for 'https://attacker.example.com':",
      "Password for 'https://github.com.evil.test':",
      "Password for 'http://github.com':",
      "Password for 'https://other-ghe.corp/org/repo.git':",
      "Passphrase for key '/home/alice/.ssh/id_ed25519':",
      "Enter password:",
      "",
    ]) {
      const parsed = TeamGitHubBroker.parseGitAskpassPrompt(badPrompt);
      const allowed =
        parsed !== null &&
        TeamGitHubBroker.isGitAskpassTargetAllowed(parsed.targetUrl, "https://api.github.com");
      expect(allowed, `expected prompt to be rejected: ${badPrompt}`).toBe(false);
    }

    // GHE askpass only allows the exact GHE origin (not github.com!)
    expect(
      TeamGitHubBroker.isGitAskpassTargetAllowed(
        new URL("https://ghe.corp.example/org/repo.git"),
        "https://ghe.corp.example/api/v3",
      ),
    ).toBe(true);
    expect(
      TeamGitHubBroker.isGitAskpassTargetAllowed(
        new URL("https://github.com/org/repo.git"),
        "https://ghe.corp.example/api/v3",
      ),
    ).toBe(false);

    // gh api direct target validation constrains both origin and GHE /api/v3 prefix
    expect(
      TeamGitHubBroker.resolveAllowedDirectApiTarget("/user", "https://ghe.corp.example/api/v3")
        ?.href,
    ).toBe("https://ghe.corp.example/api/v3/user");
    expect(
      TeamGitHubBroker.resolveAllowedDirectApiTarget(
        "https://ghe.corp.example/api/v3/repos/o/r",
        "https://ghe.corp.example/api/v3",
      )?.href,
    ).toBe("https://ghe.corp.example/api/v3/repos/o/r");
    for (const badApi of [
      "https://attacker.example.com/steal",
      "//attacker.example.com/steal",
      "../../admin/secrets",
      "/%2e%2e/admin",
      "https://ghe.corp.example/other/endpoint",
      "http://ghe.corp.example/api/v3/user",
    ]) {
      expect(
        TeamGitHubBroker.resolveAllowedDirectApiTarget(badApi, "https://ghe.corp.example/api/v3"),
        `expected direct api target to be rejected: ${badApi}`,
      ).toBeNull();
    }

    // GIT_CONFIG_COUNT emits a self-contained compacted 0..N-1 map allowlisting only safe.directory
    // and dropping host auth headers, include.path / includeIf.*.path, and url.*.insteadOf rewrites.
    expect(
      TeamGitHubBroker.buildGitConfigEnv(
        {
          GIT_CONFIG_COUNT: "5",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: "*",
          GIT_CONFIG_KEY_1: "http.https://github.com/.extraHeader",
          GIT_CONFIG_VALUE_1: "Authorization: Basic HOST_SECRET",
          GIT_CONFIG_KEY_2: "include.path",
          GIT_CONFIG_VALUE_2: "/tmp/host-secret.gitconfig",
          GIT_CONFIG_KEY_3: "includeIf.gitdir:/.path",
          GIT_CONFIG_VALUE_3: "/tmp/host-conditional.gitconfig",
          GIT_CONFIG_KEY_4: "url.https://user:HOST_PAT@github.com/.insteadOf",
          GIT_CONFIG_VALUE_4: "https://github.com/",
        },
        [
          { key: "credential.helper", value: "" },
          { key: "core.askPass", value: "/tmp/askpass" },
        ],
      ),
    ).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "core.askPass",
      GIT_CONFIG_VALUE_2: "/tmp/askpass",
    });
  });
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
        yield* withAllowedGitHubOrigins([fakeGitHub.baseUrl]);
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

        // Merge on top of a host env that HAS static GH_TOKEN / GH_ENTERPRISE_TOKEN to prove all are stripped.
        const aliceChildEnv = applyProviderSessionEnvironmentOverride(
          {
            ...process.env,
            GH_TOKEN: "HOST_LEAKED_STATIC_TOKEN",
            GITHUB_TOKEN: "HOST_LEAKED_GITHUB_TOKEN",
            GH_ENTERPRISE_TOKEN: "HOST_LEAKED_GHE_TOKEN",
            GITHUB_ENTERPRISE_TOKEN: "HOST_LEAKED_GITHUB_GHE_TOKEN",
            GH_HOST: "ghe.host.leaked",
          },
          aliceSessionOverride,
        );
        expect(aliceChildEnv.GH_TOKEN).toBeUndefined();
        expect(aliceChildEnv.GITHUB_TOKEN).toBeUndefined();
        expect(aliceChildEnv.GH_ENTERPRISE_TOKEN).toBeUndefined();
        expect(aliceChildEnv.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
        expect(aliceChildEnv.GH_HOST).toBeUndefined();
        expect(aliceChildEnv.GIT_AUTHOR_NAME).toBe("Alice Owner");
        expect(aliceChildEnv.GIT_AUTHOR_EMAIL).toBe("alice@test.example");
        expect(aliceChildEnv.GIT_TERMINAL_PROMPT).toBe("0");

        // Before any turn is active -> fail-closed!
        const askpassIdle = yield* runHelper(
          aliceChildEnv.GIT_ASKPASS!,
          [`Password for '${fakeGitHub.baseUrl}':`],
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
          [`Username for '${fakeGitHub.baseUrl}':`],
          aliceChildEnv,
        );
        expect(askpassUser.status).toBe(0);
        expect(askpassUser.stdout.trim()).toBe("alice-gh");

        const askpassPass = yield* runHelper(
          aliceChildEnv.GIT_ASKPASS!,
          [`Password for '${fakeGitHub.baseUrl}':`],
          aliceChildEnv,
        );
        expect(askpassPass.status).toBe(0);
        expect(askpassPass.stdout.trim()).toBe("PAT_ALICE");

        // Foreign host or unrecognized askpass prompt MUST be rejected even during an active turn!
        const askpassForeign = yield* runHelper(
          aliceChildEnv.GIT_ASKPASS!,
          ["Password for 'https://attacker.example.com/repo.git':"],
          aliceChildEnv,
        );
        expect(askpassForeign.status).not.toBe(0);
        expect(askpassForeign.stdout).toBe("");

        const askpassWrongGithub = yield* runHelper(
          aliceChildEnv.GIT_ASKPASS!,
          ["Password for 'https://github.com':"],
          aliceChildEnv,
        );
        expect(askpassWrongGithub.status).not.toBe(0);
        expect(askpassWrongGithub.stdout).toBe("");

        const ghTokenActive = yield* runHelper("gh", ["auth", "token"], aliceChildEnv);
        expect(ghTokenActive.status).toBe(0);
        expect(ghTokenActive.stdout.trim()).toBe("PAT_ALICE");

        const ghApiActive = yield* runHelper("gh", ["api", "/user"], aliceChildEnv);
        expect(ghApiActive.status).toBe(0);
        expect(JSON.parse(ghApiActive.stdout)).toMatchObject({ login: "alice-gh" });

        // gh api targeting an arbitrary foreign URL or traversal MUST be rejected!
        const ghApiForeign = yield* runHelper(
          "gh",
          ["api", "https://attacker.example.com/steal"],
          aliceChildEnv,
        );
        expect(ghApiForeign.status).not.toBe(0);
        const ghApiTraversal = yield* runHelper("gh", ["api", "../../escape"], aliceChildEnv);
        expect(ghApiTraversal.status).not.toBe(0);

        // Revoke immediately via modo Interrupt on unlocked thread!
        const modoInvite = yield* teamService.createInvite({
          sessionId: ownerSession.sessionId,
          payload: { role: "modo", prefilledPseudo: "charlie-modo" },
        });
        const modoRedeemed = yield* teamService.redeemInvite({
          token: modoInvite.token,
          pseudo: "charlie-modo",
          client: { deviceType: "desktop", label: "Charlie Modo" },
        });
        const modoSession = yield* sessionStore.verify(modoRedeemed.accessToken);
        yield* teamService.assertCanInterruptThread(modoSession.sessionId, threadId, "turn-1");
        yield* teamService.notifyTurnInterrupted({
          actor: { kind: "session", sessionId: modoSession.sessionId },
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
        yield* withAllowedGitHubOrigins([fakeGitHub.baseUrl]);
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
        const teamRepo = yield* TeamRepository.TeamRepository;
        yield* teamRepo.createEnvironment({
          id: TeamEnvironmentRecordId.make("te-remote-1"),
          teamId: init.team.id,
          environmentId: envId,
          name: "Remote Runner 1",
          isDefault: false,
          peerLinkId: null,
          accessRule: { roles: ["owner", "admin", "regular"], memberIds: [] },
          createdAt: "2026-11-26T12:00:00.000Z",
          updatedAt: "2026-11-26T12:00:00.000Z",
        });
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

  it.live(
    "supports multi-thread session channels with per-thread T3CODE_THREAD_ID lease isolation, spaces in node path, and GHE real gh env",
    () =>
      Effect.gen(function* () {
        const fakeGitHub = yield* Effect.acquireRelease(
          Effect.promise(() => startFakeGitHubServer()),
          (m) => Effect.promise(() => m.close()),
        );
        yield* withAllowedGitHubOrigins([fakeGitHub.baseUrl, "https://ghe.corp.example"]);

        // Create a temporary directory with a space in its name and symlink node into it
        const spaceDir = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3 node space "))),
          (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
        );
        const spacedNodePath = NodePath.join(spaceDir, "node bin");
        yield* Effect.promise(() => NodeFSP.symlink(process.execPath, spacedNodePath));

        const stackWithSpacedNode = makeBrokerStack().pipe(
          Layer.provide(Layer.succeed(HostProcess.ExecutablePath, spacedNodePath)),
        );

        yield* Effect.gen(function* () {
          const teamService = yield* TeamService.TeamService;
          const broker = yield* TeamGitHubBroker.TeamGitHubBroker;
          const sessionStore = yield* SessionStore.SessionStore;
          const githubRepo = yield* TeamGitHubRepository.TeamGitHubRepository;
          const secrets = yield* ServerSecretStore.ServerSecretStore;

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

          const threadA = ThreadId.make("thread-multi-a");
          const threadB = ThreadId.make("thread-multi-b");
          const sharedSessionId = ProviderSessionId.make("ps-codex-multi");
          const override = yield* broker.prepareSessionEnvironment({
            providerSessionId: sharedSessionId,
            threadId: threadA,
            authorKind: "member",
            authorMemberId: init.owner.id,
          });
          yield* broker.attachThreadToSessionChannel({
            providerSessionId: sharedSessionId,
            threadId: threadB,
          });
          const childEnv = applyProviderSessionEnvironmentOverride(process.env, override);

          // Verify POSIX shim uses #!/bin/sh + ELECTRON_RUN_AS_NODE=1 and works with spaces in node path
          if ((yield* HostProcess.Platform) !== "win32") {
            const shimText = yield* Effect.promise(() =>
              NodeFSP.readFile(childEnv.GIT_ASKPASS!, "utf8"),
            );
            expect(shimText.startsWith("#!/bin/sh\n")).toBe(true);
            expect(shimText).toContain("ELECTRON_RUN_AS_NODE=1");
          }

          yield* broker.activateLocalTurnLease({
            threadId: threadA,
            turnId: "turn-a",
            providerSessionId: sharedSessionId,
            authorKind: "member",
            authorMemberId: init.owner.id,
          });
          yield* broker.activateLocalTurnLease({
            threadId: threadB,
            turnId: "turn-b",
            providerSessionId: sharedSessionId,
            authorKind: "member",
            authorMemberId: init.owner.id,
          });

          // Both Thread A and Thread B succeed on the shared session via spaced node shim
          const resA = yield* runHelper("gh", ["auth", "token"], {
            ...childEnv,
            T3CODE_THREAD_ID: threadA,
          });
          const resB = yield* runHelper("gh", ["auth", "token"], {
            ...childEnv,
            T3CODE_THREAD_ID: threadB,
          });
          expect(resA.status).toBe(0);
          expect(resA.stdout.trim()).toBe("PAT_ALICE");
          expect(resB.status).toBe(0);
          expect(resB.stdout.trim()).toBe("PAT_ALICE");

          // Revoking Thread A denies Thread A immediately while Thread B remains active;
          // omitting T3CODE_THREAD_ID on a multi-thread channel ALSO fails closed!
          yield* broker.revokeTurnLease({ threadId: threadA, turnId: "turn-a" });
          const resAAfter = yield* runHelper("gh", ["auth", "token"], {
            ...childEnv,
            T3CODE_THREAD_ID: threadA,
          });
          const envWithoutThreadId: NodeJS.ProcessEnv = { ...childEnv };
          delete envWithoutThreadId.T3CODE_THREAD_ID;
          const resMissingThreadId = yield* runHelper("gh", ["auth", "token"], envWithoutThreadId);
          const resBAfter = yield* runHelper("gh", ["auth", "token"], {
            ...childEnv,
            T3CODE_THREAD_ID: threadB,
          });
          expect(resAAfter.status).not.toBe(0);
          expect(resMissingThreadId.status).not.toBe(0);
          expect(resBAfter.status).toBe(0);
          expect(resBAfter.stdout.trim()).toBe("PAT_ALICE");

          // Verify real `gh` binary delegation for GHE uses an ephemeral host-scoped hosts.yml
          // (NEVER setting wildcard GH_ENTERPRISE_TOKEN/GH_TOKEN env vars), cleans up immediately,
          // preserves normal `-H <branch>` and `--body "https://..."` invocations, and blocks
          // mismatched --hostname / -h / --repo / foreign `gh api` targets.
          const fakeGhDir = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fake-gh-"))),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          const fakeGhBin = NodePath.join(fakeGhDir, "gh");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              fakeGhBin,
              `#!/bin/sh\nHOSTS_YML=""\nif [ -f "$GH_CONFIG_DIR/hosts.yml" ]; then HOSTS_YML=$(cat "$GH_CONFIG_DIR/hosts.yml"); fi\n${process.execPath} -e 'console.log(JSON.stringify({ GH_HOST: process.env.GH_HOST || "", GH_CONFIG_DIR: process.env.GH_CONFIG_DIR || "", GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN || "", GH_TOKEN: process.env.GH_TOKEN || "", GITHUB_TOKEN: process.env.GITHUB_TOKEN || "", GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN || "", GITHUB_PAT: process.env.GITHUB_PAT || "", hostsYml: process.argv[1] }))' "$HOSTS_YML"\n`,
              { encoding: "utf8", mode: 0o700 },
            ),
          );

          const gheSecretKey = TeamGitHubRepository.teamMemberGitHubSecretKey(
            init.team.id,
            init.owner.id,
          );
          yield* TeamGitHubRepository.writeTeamGitHubSecret(secrets, gheSecretKey, {
            authMethod: "pat",
            accessToken: "PAT_GHE_CORP",
            apiBaseUrl: "https://ghe.corp.example/api/v3",
            githubLogin: "alice-ghe",
            githubName: "Alice GHE",
            githubEmail: "alice@corp.example",
          });
          yield* githubRepo.upsertMemberCredential({
            memberId: init.owner.id,
            teamId: init.team.id,
            authMethod: "pat",
            githubLogin: "alice-ghe",
            githubName: "Alice GHE",
            githubEmail: "alice@corp.example",
            apiBaseUrl: "https://ghe.corp.example/api/v3",
            secretKey: gheSecretKey,
            connectedAt: "2026-11-26T12:00:00.000Z",
            updatedAt: "2026-11-26T12:05:00.000Z",
          });
          yield* broker.activateLocalTurnLease({
            threadId: threadB,
            turnId: "turn-ghe",
            providerSessionId: sharedSessionId,
            authorKind: "member",
            authorMemberId: init.owner.id,
          });

          const hostEnv = yield* HostProcess.Environment;
          const wrapperBinDir = childEnv.PATH!.split(NodePath.delimiter)[0]!;
          const gheEnv: NodeJS.ProcessEnv = {
            ...childEnv,
            T3CODE_THREAD_ID: threadB,
            GITHUB_PAT: "SHOULD_BE_STRIPPED",
            PATH: `${wrapperBinDir}${NodePath.delimiter}${fakeGhDir}${NodePath.delimiter}${hostEnv.PATH ?? ""}`,
          };
          const ghePrList = yield* runHelper("gh", ["pr", "list"], gheEnv);
          expect(ghePrList.status).toBe(0);
          const ghePayload = JSON.parse(ghePrList.stdout) as {
            readonly GH_HOST: string;
            readonly GH_CONFIG_DIR: string;
            readonly GH_ENTERPRISE_TOKEN: string;
            readonly GH_TOKEN: string;
            readonly GITHUB_TOKEN: string;
            readonly GITHUB_ENTERPRISE_TOKEN: string;
            readonly GITHUB_PAT: string;
            readonly hostsYml: string;
          };
          expect(ghePayload.GH_HOST).toBe("ghe.corp.example");
          expect(ghePayload.GH_ENTERPRISE_TOKEN).toBe("");
          expect(ghePayload.GH_TOKEN).toBe("");
          expect(ghePayload.GITHUB_TOKEN).toBe("");
          expect(ghePayload.GITHUB_ENTERPRISE_TOKEN).toBe("");
          expect(ghePayload.GITHUB_PAT).toBe("");
          expect(ghePayload.hostsYml).toContain('"ghe.corp.example":');
          expect(ghePayload.hostsYml).toContain('oauth_token: "PAT_GHE_CORP"');
          expect(ghePayload.hostsYml).toContain('user: "alice-ghe"');
          // Ephemeral hosts.yml directory MUST be removed immediately after gh exits
          const ephemeralExistsAfter = yield* Effect.promise(() =>
            NodeFSP.access(ghePayload.GH_CONFIG_DIR)
              .then(() => true)
              .catch(() => false),
          );
          expect(ephemeralExistsAfter).toBe(false);

          // Standard `gh pr create -H <branch> --body "https://..."` and `gh pr list -H main`
          // MUST succeed (regression guard against treating -H or body URLs as foreign hosts!)
          const prCreateWithHeadAndUrl = yield* runHelper(
            "gh",
            [
              "pr",
              "create",
              "--title",
              "Docs",
              "--body",
              "https://docs.example.com/spec",
              "-H",
              "feat/my-branch",
            ],
            gheEnv,
          );
          expect(prCreateWithHeadAndUrl.status).toBe(0);
          const prListWithHead = yield* runHelper("gh", ["pr", "list", "-H", "main"], gheEnv);
          expect(prListWithHead.status).toBe(0);

          // Mismatched --hostname, auth/config -h, attached -R/--repo, and foreign `gh api` URLs
          // are ALL rejected BEFORE invoking real `gh`!
          for (const badArgs of [
            ["pr", "list", "--hostname", "evil.example.com"],
            ["pr", "list", "--repo", "github.com/org/repo"],
            ["pr", "list", "-Rattacker.example/org/repo"],
            ["pr", "list", "-R=attacker.example/org/repo"],
            ["auth", "status", "-h=attacker.example"],
            ["auth", "status", "-hattacker.example"],
            ["config", "get", "git_protocol", "-h", "attacker.example"],
            ["api", "https://attacker.example/steal"],
            ["api", "../../admin/secrets"],
          ]) {
            const rejected = yield* runHelper("gh", badArgs, gheEnv);
            expect(rejected.status, `expected gh ${badArgs.join(" ")} to fail closed`).not.toBe(0);
          }

          // Valid GHE `gh api /user` succeeds and receives ephemeral host-scoped hosts.yml
          const validGheApi = yield* runHelper("gh", ["api", "/user"], gheEnv);
          expect(validGheApi.status).toBe(0);
          expect(JSON.parse(validGheApi.stdout)).toMatchObject({
            GH_HOST: "ghe.corp.example",
            GH_ENTERPRISE_TOKEN: "",
            GH_TOKEN: "",
          });

          // Verify SSH Git remote isolation: GitHub + configured GHE SSH URLs are rewritten to
          // HTTPS (routing through broker askpass), and any other SSH remote fails closed via
          // GIT_SSH_COMMAND without touching host SSH keys or agent.
          const gheSessionOverride = yield* broker.prepareSessionEnvironment({
            providerSessionId: ProviderSessionId.make("ps-ghe-ssh"),
            threadId: threadB,
            authorKind: "member",
            authorMemberId: init.owner.id,
          });
          const gheSessionEnv = applyProviderSessionEnvironmentOverride(
            hostEnv,
            gheSessionOverride,
          );
          const ghInsteadOf = yield* runHelper(
            "git",
            ["config", "--get-all", "url.https://github.com/.insteadOf"],
            gheSessionEnv,
          );
          expect(ghInsteadOf.status).toBe(0);
          expect(ghInsteadOf.stdout).toContain("git@github.com:");
          expect(ghInsteadOf.stdout).toContain("ssh://git@github.com/");

          const gheInsteadOf = yield* runHelper(
            "git",
            ["config", "--get-all", "url.https://ghe.corp.example/.insteadOf"],
            gheSessionEnv,
          );
          expect(gheInsteadOf.status).toBe(0);
          expect(gheInsteadOf.stdout).toContain("git@ghe.corp.example:");

          const customSshFail = yield* runHelper(
            "git",
            ["ls-remote", "git@custom-ssh-alias:org/repo.git"],
            gheSessionEnv,
          );
          expect(customSshFail.status).not.toBe(0);
          expect(customSshFail.stderr).toContain("Git SSH transport is disabled");

          // Verify `gh auth token --help` does NOT print the raw turn PAT
          const ghAuthTokenHelp = yield* runHelper("gh", ["auth", "token", "--help"], gheEnv);
          expect(ghAuthTokenHelp.stdout).not.toContain("PAT_GHE_CORP");

          // Verify signal-safe cleanup of ephemeral hosts.yml on SIGTERM AND broker-side sweep of
          // SIGKILL-orphaned gh-runs/ dirs upon revokeTurnLease!
          const slowGhDir = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-slow-gh-"))),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          const slowGhBin = NodePath.join(slowGhDir, "gh");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(slowGhBin, `#!/bin/sh\necho "$GH_CONFIG_DIR"\nsleep 30\n`, {
              encoding: "utf8",
              mode: 0o700,
            }),
          );
          const slowGheEnv: NodeJS.ProcessEnv = {
            ...gheEnv,
            PATH: `${wrapperBinDir}${NodePath.delimiter}${slowGhDir}${NodePath.delimiter}${hostEnv.PATH ?? ""}`,
          };
          const sigtermDir = yield* Effect.promise(
            () =>
              new Promise<string>((resolve, reject) => {
                const child = NodeChildProcess.spawn("gh", ["pr", "list"], {
                  env: slowGheEnv,
                  stdio: ["ignore", "pipe", "pipe"],
                });
                let buf = "";
                child.stdout.on("data", (chunk: Buffer) => {
                  buf += chunk.toString("utf8");
                  const nl = buf.indexOf("\n");
                  if (nl !== -1) {
                    const dirPath = buf.slice(0, nl).trim();
                    child.kill("SIGTERM");
                    child.once("exit", () => resolve(dirPath));
                  }
                });
                child.on("error", reject);
              }),
          );
          expect(sigtermDir).toContain("gh-runs");
          const sigtermDirExists = yield* Effect.promise(() =>
            NodeFSP.access(sigtermDir)
              .then(() => true)
              .catch(() => false),
          );
          expect(sigtermDirExists).toBe(false);

          // Plant both a simulated SIGKILL-orphaned dir AND a live sibling-thread dir on the same
          // shared channel; revoking threadA MUST sweep the dead orphan without touching threadB's live dir!
          const ghRunsDir = NodePath.dirname(sigtermDir);
          const dirParts = /^run-([0-9a-f]{12})-([0-9a-f]{12})-/.exec(
            NodePath.basename(sigtermDir),
          );
          expect(dirParts).not.toBeNull();
          const liveSiblingDir = NodePath.join(
            ghRunsDir,
            `run-${dirParts![1]}-${dirParts![2]}-${process.pid}-sibling`,
          );
          const fakeOrphanDir = NodePath.join(
            ghRunsDir,
            "run-deadbeefcafe-0123456789ab-99999999-orphan",
          );
          yield* Effect.promise(() => NodeFSP.mkdir(liveSiblingDir, { recursive: true }));
          yield* Effect.promise(() => NodeFSP.mkdir(fakeOrphanDir, { recursive: true }));
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(fakeOrphanDir, "hosts.yml"), "leaked: true\n"),
          );
          yield* broker.revokeTurnLease({ threadId: threadA, turnId: "turn-a" });
          expect(
            yield* Effect.promise(() =>
              NodeFSP.access(liveSiblingDir)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(true);
          expect(
            yield* Effect.promise(() =>
              NodeFSP.access(fakeOrphanDir)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false);
          // Revoking threadB DOES sweep threadB's own dir
          yield* broker.revokeTurnLease({ threadId: threadB, turnId: "turn-ghe" });
          expect(
            yield* Effect.promise(() =>
              NodeFSP.access(liveSiblingDir)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false);

          // Verify host HTTP auth sources (~/.netrc + ~/.gitconfig http.*.extraHeader + GIT_CONFIG_PARAMETERS)
          // CANNOT authenticate git when no turn lease is active, while provider HOME stays intact!
          const seenAuthHeaders: Array<string> = [];
          const seenCookieHeaders: Array<string> = [];
          const authTrapServer = yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<{ readonly origin: string; readonly close: () => Promise<void> }>(
                  (resolve, reject) => {
                    const srv = NodeHttp.createServer((req, res) => {
                      if (typeof req.headers.authorization === "string") {
                        seenAuthHeaders.push(req.headers.authorization);
                      }
                      if (typeof req.headers.cookie === "string") {
                        seenCookieHeaders.push(req.headers.cookie);
                      }
                      res.writeHead(401, { "www-authenticate": 'Basic realm="trap"' });
                      res.end("Unauthorized");
                    });
                    srv.on("error", reject);
                    srv.listen(0, "127.0.0.1", () => {
                      const addr = srv.address();
                      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
                      resolve({
                        origin: `http://127.0.0.1:${port}`,
                        close: () =>
                          new Promise<void>((done) => {
                            srv.closeAllConnections?.();
                            srv.close(() => done());
                          }),
                      });
                    });
                  },
                ),
            ),
            (s) => Effect.promise(() => s.close()),
          );
          const fakeHostHome = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-host-home-"))),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(fakeHostHome, ".netrc"),
              `machine 127.0.0.1 login hostuser password HOST_NETRC_SECRET\n`,
              { encoding: "utf8", mode: 0o600 },
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(fakeHostHome, ".gitconfig"),
              `[http "${authTrapServer.origin}"]\n\textraHeader = Authorization: Basic HOST_GITCONFIG_SECRET\n`,
              { encoding: "utf8", mode: 0o600 },
            ),
          );
          const isolatedWithHostHome = applyProviderSessionEnvironmentOverride(
            {
              ...hostEnv,
              HOME: fakeHostHome,
              GIT_CONFIG_PARAMETERS: `'http.extraHeader=Authorization: Basic HOST_PARAM_SECRET'`,
            },
            gheSessionOverride,
          );
          // Provider process keeps its real HOME untouched
          expect(isolatedWithHostHome.HOME).toBe(fakeHostHome);
          // Git subprocess fails closed AND never transmits .netrc or .gitconfig credentials!
          const gitHttpTrapRes = yield* runHelper(
            "git",
            ["ls-remote", `${authTrapServer.origin}/acme/demo.git`],
            isolatedWithHostHome,
          );
          expect(gitHttpTrapRes.status).not.toBe(0);
          expect(seenAuthHeaders).toEqual([]);

          // Path-scoped repository `.git/config`, `[include]`, `[includeIf]`, AND
          // `extensions.worktreeConfig` (`config.worktree`) extraHeaders MUST ALL be neutralized!
          const repoWithPathHeader = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-path-hdr-"))),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          const initRepoRes = yield* runHelper("git", ["init", repoWithPathHeader], hostEnv);
          expect(initRepoRes.status).toBe(0);
          const includedCfgPath = NodePath.join(repoWithPathHeader, ".git", "included-auth.cfg");
          const includeIfCfgPath = NodePath.join(repoWithPathHeader, ".git", "cond-auth.cfg");
          const worktreeCfgPath = NodePath.join(repoWithPathHeader, ".git", "config.worktree");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              includedCfgPath,
              `[http "${authTrapServer.origin}/included/"]\n\textraHeader = Authorization: Basic INCLUDED_SECRET\n`,
              "utf8",
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              includeIfCfgPath,
              `[http "${authTrapServer.origin}/includeif/"]\n\textraHeader = Authorization: Basic INCLUDEIF_SECRET\n`,
              "utf8",
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              worktreeCfgPath,
              `[http "${authTrapServer.origin}/worktree/"]\n\textraHeader = Authorization: Basic WORKTREE_SECRET\n`,
              "utf8",
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              NodePath.join(repoWithPathHeader, ".git", "config"),
              [
                "",
                `[core]`,
                `\trepositoryformatversion = 1`,
                `[extensions]`,
                `\tworktreeConfig = true`,
                `[include]`,
                `\tpath = included-auth.cfg`,
                `[includeIf "gitdir:${repoWithPathHeader}/"]`,
                `\tpath = cond-auth.cfg`,
                `[http "${authTrapServer.origin}/acme/"]`,
                `\textraHeader = Authorization: Basic PATH_SCOPED_REPO_SECRET`,
                "",
              ].join("\n"),
              "utf8",
            ),
          );
          for (const repoPath of [
            `${authTrapServer.origin}/acme/demo.git`,
            `${authTrapServer.origin}/included/demo.git`,
            `${authTrapServer.origin}/includeif/demo.git`,
            `${authTrapServer.origin}/worktree/demo.git`,
          ]) {
            const trapRes = yield* runHelper(
              "git",
              ["-C", repoWithPathHeader, "ls-remote", repoPath],
              { ...isolatedWithHostHome, GIT_CONFIG: "/dev/null" },
            );
            expect(trapRes.status).not.toBe(0);
          }
          // Attached `-C<path>` AND empty-string `-C ""` (Git no-op) MUST BOTH neutralize repo extraHeaders!
          const attachedCTrap = yield* runHelper(
            "git",
            [`-C${repoWithPathHeader}`, "ls-remote", `${authTrapServer.origin}/acme/demo.git`],
            isolatedWithHostHome,
          );
          expect(attachedCTrap.status).not.toBe(0);
          const emptyCTrap = yield* runHelper(
            "git",
            ["-C", "", "ls-remote", `${authTrapServer.origin}/acme/demo.git`],
            isolatedWithHostHome,
            repoWithPathHeader,
          );
          expect(emptyCTrap.status).not.toBe(0);
          // Git 2.40+ `--attr-source <tree-ish>` two-token global flag must not hide `-C` or spoof `init`.
          const attrSourceTrap = yield* runHelper(
            "git",
            [
              "--attr-source",
              "init",
              "-C",
              repoWithPathHeader,
              "ls-remote",
              `${authTrapServer.origin}/acme/demo.git`,
            ],
            isolatedWithHostHome,
          );
          expect(attrSourceTrap.status).not.toBe(0);
          // Inherited GIT_CONFIG_KEY_* include.path / includeIf.*.path / credential-bearing url.*.insteadOf
          // must be dropped by buildGitConfigEnv so host configs cannot bypass the broker's isolation!
          const inheritedIncludeCfg = NodePath.join(fakeHostHome, "inherited-secret.gitconfig");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              inheritedIncludeCfg,
              [
                `[http "${authTrapServer.origin}/"]`,
                `\textraHeader = Authorization: Basic INHERITED_INCLUDE_SECRET`,
                `[credential "${authTrapServer.origin}"]`,
                `\thelper = !echo username=x-access-token && echo password=INHERITED_HELPER_SECRET`,
                "",
              ].join("\n"),
              "utf8",
            ),
          );
          const envWithInheritedInclude = applyProviderSessionEnvironmentOverride(
            { ...hostEnv },
            {
              ...gheSessionOverride,
              ...TeamGitHubBroker.buildGitConfigEnv(
                {
                  GIT_CONFIG_COUNT: "4",
                  GIT_CONFIG_KEY_0: "include.path",
                  GIT_CONFIG_VALUE_0: inheritedIncludeCfg,
                  GIT_CONFIG_KEY_1: "includeIf.gitdir:/.path",
                  GIT_CONFIG_VALUE_1: inheritedIncludeCfg,
                  GIT_CONFIG_KEY_2: `url.http://hostuser:HOST_PAT@127.0.0.1:${new URL(authTrapServer.origin).port}/.insteadOf`,
                  GIT_CONFIG_VALUE_2: `${authTrapServer.origin}/`,
                  GIT_CONFIG_KEY_3: "safe.directory",
                  GIT_CONFIG_VALUE_3: "*",
                },
                [
                  { key: "credential.helper", value: "" },
                  { key: "core.askPass", value: gheSessionOverride.GIT_ASKPASS! },
                ],
              ),
            },
          );
          const inheritedIncludeTrap = yield* runHelper(
            "git",
            ["ls-remote", `${authTrapServer.origin}/acme/demo.git`],
            envWithInheritedInclude,
          );
          expect(inheritedIncludeTrap.status).not.toBe(0);
          // Repository-level credential-bearing or helper-form `url.*.(insteadOf|pushInsteadOf)`
          // (including via `[include]`) MUST be rejected fail-closed with zero auth headers sent,
          // `http.*.cookieFile` MUST be neutralized with zero Cookie headers sent, and
          // non-credential URL rewrites MUST remain allowed!
          const repoWithUrlRewrite = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-url-rw-"))),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          expect((yield* runHelper("git", ["init", repoWithUrlRewrite], hostEnv)).status).toBe(0);
          const trapPort = new URL(authTrapServer.origin).port;
          const includedRewriteCfg = NodePath.join(repoWithUrlRewrite, ".git", "rewrite.cfg");
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              NodePath.join(repoWithUrlRewrite, ".git", "config"),
              `\n[include]\n\tpath = ${includedRewriteCfg}\n`,
              "utf8",
            ),
          );
          for (const badRewriteSection of [
            `[url "http://hostuser:REPO_REWRITE_PAT@127.0.0.1:${trapPort}/"]\n\tinsteadOf = ${authTrapServer.origin}/\n`,
            `[url "http://hostuser:REPO_REWRITE_PAT@127.0.0.1:${trapPort}/"]\n\tpushInsteadOf = ${authTrapServer.origin}/\n`,
            `[url "http::http://hostuser:HELPER_REWRITE_PAT@127.0.0.1:${trapPort}/"]\n\tinsteadOf = ${authTrapServer.origin}/\n`,
            `[url "https::http://hostuser:HELPER_PUSH_PAT@127.0.0.1:${trapPort}/"]\n\tpushInsteadOf = ${authTrapServer.origin}/\n`,
          ]) {
            yield* Effect.promise(() =>
              NodeFSP.writeFile(includedRewriteCfg, badRewriteSection, "utf8"),
            );
            const repoRewriteTrap = yield* runHelper(
              "git",
              ["-C", repoWithUrlRewrite, "ls-remote", `${authTrapServer.origin}/acme/demo.git`],
              isolatedWithHostHome,
            );
            expect(repoRewriteTrap.status).toBe(128);
            expect(repoRewriteTrap.stderr).toContain("url.*.insteadOf");
          }
          // `http.*.cookieFile` supplied via `[include]` must be neutralized so no cookies are sent.
          const trapCookieFile = NodePath.join(repoWithUrlRewrite, ".git", "trap-cookies.txt");
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              trapCookieFile,
              `127.0.0.1\tFALSE\t/\tFALSE\t2147483647\tsession\tHOST_COOKIE_SECRET\n`,
              "utf8",
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              includedRewriteCfg,
              `[http "${authTrapServer.origin}"]\n\tcookieFile = ${trapCookieFile}\n`,
              "utf8",
            ),
          );
          const cookieTrap = yield* runHelper(
            "git",
            ["-C", repoWithUrlRewrite, "ls-remote", `${authTrapServer.origin}/acme/demo.git`],
            isolatedWithHostHome,
          );
          expect(cookieTrap.status).not.toBe(0);
          // Non-credential URL rewrites (e.g. ssh://git@github.com/) must NOT be rejected.
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              includedRewriteCfg,
              [`[url "ssh://git@github.com/"]`, `\tinsteadOf = https://alias.example/`, ""].join(
                "\n",
              ),
              "utf8",
            ),
          );
          const safeRewriteCheck = yield* runHelper(
            "git",
            ["-C", repoWithUrlRewrite, "rev-parse", "--is-inside-work-tree"],
            isolatedWithHostHome,
          );
          expect(safeRewriteCheck.status).toBe(0);
          expect(safeRewriteCheck.stdout.trim()).toBe("true");
          // Submodule-local auth headers/cookies in `.git/modules/<name>/config` MUST also be
          // neutralized during `git submodule update --remote` with zero auth/cookie headers sent.
          const subParentDir = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-sub-parent-"))),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          const subChildSeed = NodePath.join(subParentDir, "seed-child");
          const subParentRepo = NodePath.join(subParentDir, "parent");
          expect((yield* runHelper("git", ["init", subChildSeed], hostEnv)).status).toBe(0);
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(subChildSeed, "README.md"), "sub\n", "utf8"),
          );
          expect(
            (yield* runHelper(
              "git",
              ["-C", subChildSeed, "config", "user.email", "t@e.st"],
              hostEnv,
            )).status,
          ).toBe(0);
          expect(
            (yield* runHelper("git", ["-C", subChildSeed, "config", "user.name", "T"], hostEnv))
              .status,
          ).toBe(0);
          expect(
            (yield* runHelper("git", ["-C", subChildSeed, "add", "README.md"], hostEnv)).status,
          ).toBe(0);
          expect(
            (yield* runHelper("git", ["-C", subChildSeed, "commit", "-m", "init"], hostEnv)).status,
          ).toBe(0);
          expect((yield* runHelper("git", ["init", subParentRepo], hostEnv)).status).toBe(0);
          expect(
            (yield* runHelper(
              "git",
              [
                "-C",
                subParentRepo,
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                subChildSeed,
                "sub",
              ],
              hostEnv,
            )).status,
          ).toBe(0);
          const subModuleCfg = NodePath.join(subParentRepo, ".git", "modules", "sub", "config");
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              subModuleCfg,
              [
                "",
                `[http "${authTrapServer.origin}/"]`,
                `\textraHeader = Authorization: Bearer SUBMODULE_TRAP_SECRET`,
                `\tcookieFile = ${trapCookieFile}`,
                "",
              ].join("\n"),
              "utf8",
            ),
          );
          expect(
            (yield* runHelper(
              "git",
              [
                "-C",
                NodePath.join(subParentRepo, "sub"),
                "remote",
                "set-url",
                "origin",
                `${authTrapServer.origin}/sub/repo.git`,
              ],
              hostEnv,
            )).status,
          ).toBe(0);
          const subUpdateTrap = yield* runHelper(
            "git",
            ["-C", subParentRepo, "submodule", "update", "--remote"],
            isolatedWithHostHome,
          );
          expect(subUpdateTrap.status).not.toBe(0);
          // Standalone embedded `.git` dir submodule (with a space in its `.gitmodules` name)
          // containing a nested submodule MUST also be recursively inspected.
          const outerStandDir = NodePath.join(subParentDir, "outer-standalone");
          const midStandDir = NodePath.join(outerStandDir, "mid sub");
          const innerStandDir = NodePath.join(midStandDir, "inner");
          expect((yield* runHelper("git", ["init", outerStandDir], hostEnv)).status).toBe(0);
          expect((yield* runHelper("git", ["init", midStandDir], hostEnv)).status).toBe(0);
          expect((yield* runHelper("git", ["init", innerStandDir], hostEnv)).status).toBe(0);
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(outerStandDir, ".gitmodules"),
              `[submodule "mid sub"]\n\tpath = mid sub\n\turl = ${authTrapServer.origin}/mid/repo.git\n`,
              "utf8",
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(midStandDir, ".gitmodules"),
              `[submodule "inner sub"]\n\tpath = inner\n\turl = ${authTrapServer.origin}/inner/repo.git\n`,
              "utf8",
            ),
          );
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              NodePath.join(innerStandDir, ".git", "config"),
              `\n[url "http://user:NESTED_PAT@127.0.0.1:${trapPort}/"]\n\tinsteadOf = ${authTrapServer.origin}/\n`,
              "utf8",
            ),
          );
          const nestedSubTrap = yield* runHelper(
            "git",
            ["-C", outerStandDir, "rev-parse", "--is-inside-work-tree"],
            isolatedWithHostHome,
          );
          expect(nestedSubTrap.status).toBe(128);
          expect(nestedSubTrap.stderr).toContain("url.*.insteadOf");
          expect(seenAuthHeaders).toEqual([]);
          expect(seenCookieHeaders).toEqual([]);

          // Real TeamGitHubBroker + bwrapSandbox integration: verify broker-generated env works
          // end-to-end inside Linux bwrap (git/gh wrappers resolve on PATH, GIT_ASKPASS talks over
          // the bound Unix socket, gh-config is RO, and gh-runs is a sandbox-private tmpfs).
          if ((yield* HostProcess.Platform) === "linux") {
            const bwrapCheck = yield* runHelper(
              "bwrap",
              [
                "--ro-bind",
                "/usr",
                "/usr",
                "--ro-bind-try",
                "/bin",
                "/bin",
                "--ro-bind-try",
                "/lib",
                "/lib",
                "--ro-bind-try",
                "/lib64",
                "/lib64",
                "--",
                "true",
              ],
              hostEnv,
            );
            const bwrapWt = yield* Effect.acquireRelease(
              Effect.promise(() =>
                NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-gh-bwrap-wt-")),
              ),
              (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
            );
            const bwrapStateDir = yield* Effect.acquireRelease(
              Effect.promise(() =>
                NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-gh-bwrap-st-")),
              ),
              (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
            );
            const bwrapEnv = applyProviderSessionEnvironmentOverride(
              { ...hostEnv, T3CODE_THREAD_ID: threadB },
              gheSessionOverride,
            );
            const brokerDir = NodePath.dirname(gheSessionOverride.T3_TEAM_GH_BROKER_ENDPOINT!);
            const bwrapScript = [
              `echo "GIT_BIN=$(command -v git)"`,
              `echo "GH_BIN=$(command -v gh)"`,
              `ASK_OUT=$("$GIT_ASKPASS" "Password for 'https://x-access-token@ghe.corp.example': ")`,
              `echo "ASK_OUT=$ASK_OUT"`,
              `if touch "$GH_CONFIG_DIR/poison" 2>/dev/null; then echo "GH_CFG_RW"; else echo "GH_CFG_RO"; fi`,
              `touch "${NodePath.join(brokerDir, "gh-runs", "sandbox-only")}" && echo "GH_RUNS_WRITABLE"`,
            ].join("; ");
            const wrapped = yield* BwrapSandbox.wrapCommandWithBwrap({
              bwrapBinaryPath: "bwrap",
              command: "/bin/sh",
              args: ["-c", bwrapScript],
              cwd: bwrapWt,
              env: bwrapEnv,
              ownStateDir: bwrapStateDir,
            });
            if (bwrapCheck.status === 0) {
              const bwrapRun = yield* runHelper(
                wrapped.command,
                [...wrapped.args],
                wrapped.hostEnv ?? bwrapEnv,
              );
              expect(bwrapRun.status).toBe(0);
              expect(bwrapRun.stdout).toContain(
                `GIT_BIN=${NodePath.join(brokerDir, "bin", "git")}`,
              );
              expect(bwrapRun.stdout).toContain(`GH_BIN=${NodePath.join(brokerDir, "bin", "gh")}`);
              expect(bwrapRun.stdout).toContain("ASK_OUT=PAT_BOB");
              expect(bwrapRun.stdout).toContain("GH_CFG_RO");
              expect(bwrapRun.stdout).toContain("GH_RUNS_WRITABLE");
              // Private tmpfs gh-runs must NEVER leak onto the host directory!
              const hostRuns = yield* Effect.promise(() =>
                NodeFSP.readdir(NodePath.join(brokerDir, "gh-runs")),
              );
              expect(hostRuns).not.toContain("sandbox-only");
            }
          }

          // Verify `git --git-dir=<new> init` works (probe skips init) AND `safe.directory`
          // entries preserved in GIT_CONFIG_* remain active in git subprocesses!
          const freshInitDir = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-git-init-"))),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          const freshInitRes = yield* runHelper(
            "git",
            ["--git-dir", NodePath.join(freshInitDir, "new.git"), "init", "--bare"],
            isolatedWithHostHome,
          );
          expect(freshInitRes.status).toBe(0);
          const envWithSafeDir = applyProviderSessionEnvironmentOverride(
            { ...hostEnv },
            {
              ...gheSessionOverride,
              ...TeamGitHubBroker.buildGitConfigEnv(
                {
                  GIT_CONFIG_COUNT: "1",
                  GIT_CONFIG_KEY_0: "safe.directory",
                  GIT_CONFIG_VALUE_0: "*",
                },
                [
                  { key: "credential.helper", value: "" },
                  { key: "core.askPass", value: gheSessionOverride.GIT_ASKPASS! },
                ],
              ),
            },
          );
          const safeDirCheck = yield* runHelper(
            "git",
            ["-C", repoWithPathHeader, "config", "--get-all", "safe.directory"],
            envWithSafeDir,
          );
          expect(safeDirCheck.status).toBe(0);
          expect(safeDirCheck.stdout.trim()).toBe("*");

          // Single-thread session with omitted or unrelated inherited T3CODE_THREAD_ID MUST still
          // use the broker-resolved lease.threadId when naming gh-runs/ dirs so revokeTurnLease
          // sweeps the live directory immediately!
          const singleThreadId = ThreadId.make("thread-single-sweep");
          const singleSessionId = ProviderSessionId.make("ps-single-sweep");
          const singleOverride = yield* broker.prepareSessionEnvironment({
            providerSessionId: singleSessionId,
            threadId: singleThreadId,
            authorKind: "member",
            authorMemberId: init.owner.id,
          });
          yield* broker.activateLocalTurnLease({
            threadId: singleThreadId,
            turnId: "turn-single-sweep",
            providerSessionId: singleSessionId,
            authorKind: "member",
            authorMemberId: init.owner.id,
          });
          const singleWrapperBin = singleOverride.PATH!.split(NodePath.delimiter)[0]!;
          for (const inheritedThreadId of [undefined, "unrelated-outer-server-thread"]) {
            const singleEnv = applyProviderSessionEnvironmentOverride(
              {
                ...hostEnv,
                PATH: `${singleWrapperBin}${NodePath.delimiter}${slowGhDir}${NodePath.delimiter}${hostEnv.PATH ?? ""}`,
              },
              {
                ...singleOverride,
                PATH: `${singleWrapperBin}${NodePath.delimiter}${slowGhDir}${NodePath.delimiter}${hostEnv.PATH ?? ""}`,
              },
            );
            if (inheritedThreadId === undefined) {
              delete singleEnv.T3CODE_THREAD_ID;
            } else {
              singleEnv.T3CODE_THREAD_ID = inheritedThreadId;
            }
            const liveDir = yield* Effect.promise(
              () =>
                new Promise<{
                  readonly dir: string;
                  readonly child: NodeChildProcess.ChildProcess;
                }>((resolve, reject) => {
                  const child = NodeChildProcess.spawn("gh", ["pr", "list"], {
                    env: singleEnv,
                    stdio: ["ignore", "pipe", "pipe"],
                  });
                  let buf = "";
                  child.stdout.on("data", (chunk: Buffer) => {
                    buf += chunk.toString("utf8");
                    const nl = buf.indexOf("\n");
                    if (nl !== -1) {
                      resolve({ dir: buf.slice(0, nl).trim(), child });
                    }
                  });
                  child.on("error", reject);
                }),
            );
            try {
              yield* broker.revokeTurnLease({
                threadId: singleThreadId,
                turnId: "turn-single-sweep",
              });
              expect(
                yield* Effect.promise(() =>
                  NodeFSP.access(liveDir.dir)
                    .then(() => true)
                    .catch(() => false),
                ),
              ).toBe(false);
            } finally {
              liveDir.child.kill("SIGTERM");
              yield* Effect.promise(
                () =>
                  new Promise<void>((done) => {
                    if (liveDir.child.exitCode !== null || liveDir.child.signalCode !== null) {
                      done();
                    } else {
                      liveDir.child.once("exit", () => done());
                    }
                  }),
              );
            }
            // Re-activate for second iteration
            yield* broker.activateLocalTurnLease({
              threadId: singleThreadId,
              turnId: "turn-single-sweep",
              providerSessionId: singleSessionId,
              authorKind: "member",
              authorMemberId: init.owner.id,
            });
          }
          yield* broker.revokeTurnLease({
            threadId: singleThreadId,
            turnId: "turn-single-sweep",
          });

          // Verify default-environment ACL restriction immediately revokes local turn leases
          // and blocks both resolution and renewal for affected regular members!
          const inviteBob = yield* teamService.createInvite({
            sessionId: ownerSession.sessionId,
            payload: { role: "regular", prefilledPseudo: "bob-local-acl" },
          });
          const bobJoined = yield* teamService.redeemInvite({
            token: inviteBob.token,
            pseudo: "bob-local-acl",
            client: { label: "Bob", deviceType: "desktop", os: "linux" },
          });
          const bobSecretKey = TeamGitHubRepository.teamMemberGitHubSecretKey(
            init.team.id,
            bobJoined.member.id,
          );
          yield* TeamGitHubRepository.writeTeamGitHubSecret(secrets, bobSecretKey, {
            authMethod: "pat",
            accessToken: "PAT_BOB_LOCAL",
            apiBaseUrl: fakeGitHub.baseUrl,
            githubLogin: "bob-local",
            githubName: "Bob Local",
            githubEmail: "bob@acme.dev",
          });
          yield* githubRepo.upsertMemberCredential({
            memberId: bobJoined.member.id,
            teamId: init.team.id,
            authMethod: "pat",
            githubLogin: "bob-local",
            githubName: "Bob Local",
            githubEmail: "bob@acme.dev",
            apiBaseUrl: fakeGitHub.baseUrl,
            secretKey: bobSecretKey,
            connectedAt: "2026-11-26T12:00:00.000Z",
            updatedAt: "2026-11-26T12:05:00.000Z",
          });
          const bobThread = ThreadId.make("thread-bob-default-acl");
          yield* broker.activateLocalTurnLease({
            threadId: bobThread,
            turnId: "turn-bob-default-acl",
            providerSessionId: ProviderSessionId.make("ps-bob-default-acl"),
            authorKind: "member",
            authorMemberId: bobJoined.member.id,
          });
          expect(
            yield* broker.hasActiveTurnLease({
              threadId: bobThread,
              turnId: "turn-bob-default-acl",
            }),
          ).toBe(true);
          const teamState = yield* teamService.getState(ownerSession.sessionId);
          const defaultEnvRecord = teamState.environments?.find((e) => e.isDefault);
          expect(defaultEnvRecord).toBeDefined();
          yield* teamService.updateEnvironment({
            sessionId: ownerSession.sessionId,
            payload: {
              environmentId: defaultEnvRecord!.environmentId,
              accessRule: { roles: ["owner", "admin"], memberIds: [] },
            },
          });
          expect(
            yield* broker.hasActiveTurnLease({
              threadId: bobThread,
              turnId: "turn-bob-default-acl",
            }),
          ).toBe(false);
          expect(
            yield* broker.renewTurnLease({
              threadId: bobThread,
              turnId: "turn-bob-default-acl",
            }),
          ).toBe(false);

          // Verify active local turn lease renewal extends valid leases and fails closed after revocation
          yield* broker.activateLocalTurnLease({
            threadId: threadB,
            turnId: "turn-renew-local",
            providerSessionId: sharedSessionId,
            authorKind: "member",
            authorMemberId: init.owner.id,
            ttlMs: 1_500,
          });
          expect(
            yield* broker.renewTurnLease({
              threadId: threadB,
              turnId: "turn-renew-local",
              ttlMs: 60_000,
            }),
          ).toBe(true);
          yield* broker.revokeTurnLease({ threadId: threadB, turnId: "turn-renew-local" });
          expect(
            yield* broker.renewTurnLease({
              threadId: threadB,
              turnId: "turn-renew-local",
              ttlMs: 60_000,
            }),
          ).toBe(false);
        }).pipe(Effect.provide(stackWithSpacedNode));
      }).pipe(Effect.scoped),
  );

  it.live(
    "forwards per-turn GitHub credentials across two servers (Team Server HTTP -> Remote Runner broker -> immediate revocation)",
    () =>
      Effect.gen(function* () {
        const fakeGitHub = yield* Effect.acquireRelease(
          Effect.promise(() => startFakeGitHubServer()),
          (m) => Effect.promise(() => m.close()),
        );
        yield* withAllowedGitHubOrigins([fakeGitHub.baseUrl]);

        // 1. Start Team Server stack + live HTTP server exposing /api/team/github-lease/*
        const platform = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          FetchHttpClient.layer,
        );
        const teamBase = ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-team-gh-two-server-team-",
        }).pipe(Layer.provideMerge(platform));
        const teamPersistence = SqlitePersistence.layerMemory.pipe(Layer.provide(teamBase));
        const teamSecrets = ServerSecretStore.layer.pipe(Layer.provide(teamBase));
        const teamAuthSessions = AuthSessions.layer.pipe(Layer.provide(teamPersistence));
        const teamServerEnv = ServerEnvironment.layer.pipe(
          Layer.provide(teamSecrets),
          Layer.provide(teamBase),
        );
        const teamSessions = SessionStore.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(teamPersistence, teamSecrets, teamAuthSessions, teamServerEnv),
          ),
          Layer.provide(teamBase),
        );
        const teamEnvAuth = EnvironmentAuth.layer.pipe(
          Layer.provideMerge(teamSessions),
          Layer.provideMerge(teamSecrets),
          Layer.provide(ManagedPolicy.layerTest()),
          Layer.provide(teamBase),
        );
        const teamRepo = TeamRepository.layer.pipe(Layer.provide(teamPersistence));
        const teamAssetsRepo = TeamAssetsRepository.layer.pipe(Layer.provide(teamPersistence));
        const teamGithubRepo = TeamGitHubRepository.layer.pipe(Layer.provide(teamPersistence));
        const teamServiceLayer = TeamService.layer.pipe(
          Layer.provideMerge(teamRepo),
          Layer.provideMerge(teamAssetsRepo),
          Layer.provideMerge(teamGithubRepo),
          Layer.provideMerge(teamSessions),
          Layer.provideMerge(teamSecrets),
          Layer.provideMerge(teamServerEnv),
          Layer.provideMerge(teamBase),
        );
        const teamFullLayer = Layer.mergeAll(
          TeamGitHubBroker.layer.pipe(Layer.provideMerge(teamServiceLayer)),
          teamEnvAuth,
        );

        const remoteEnvId = EnvironmentId.make("remote-runner-env-2");
        const remoteThreadId = ThreadId.make("thread-remote-two-server");
        const remoteTurnId = "turn-remote-1";

        yield* Effect.gen(function* () {
          const team = yield* TeamService.TeamService;
          const repo = yield* TeamRepository.TeamRepository;
          const sessions = yield* SessionStore.SessionStore;

          const aliceSession = yield* sessions.issue({
            subject: "alice",
            scopes: ["orchestration:read", "orchestration:operate", "access:write"],
            client: { label: "Alice", deviceType: "desktop", os: "linux" },
          });
          const init = yield* team.initializeTeam({
            sessionId: aliceSession.sessionId,
            payload: { name: "Acme", ownerPseudo: "alice" },
          });
          yield* team.connectMyGitHub({
            sessionId: aliceSession.sessionId,
            payload: { token: "PAT_ALICE", apiBaseUrl: fakeGitHub.baseUrl },
          });
          yield* repo.createEnvironment({
            id: TeamEnvironmentRecordId.make("te-two-server"),
            teamId: init.team.id,
            environmentId: remoteEnvId,
            name: "Remote Runner",
            isDefault: false,
            peerLinkId: null,
            accessRule: { roles: ["owner", "admin", "regular"], memberIds: [] },
            createdAt: "2026-11-26T12:00:00.000Z",
            updatedAt: "2026-11-26T12:00:00.000Z",
          });
          yield* repo.recordThreadAttribution({
            threadId: remoteThreadId,
            teamId: init.team.id,
            creatorMemberId: init.owner.id,
            viewId: init.team.defaultViewId,
            executionEnvironmentId: remoteEnvId,
            createdAt: "2026-11-26T12:00:00.000Z",
          });
          yield* repo.recordTurnAttribution({
            turnId: remoteTurnId,
            threadId: remoteThreadId,
            authorMemberId: init.owner.id,
            createdAt: "2026-11-26T12:00:00.000Z",
          });
          const localSyncToken = (yield* team.issueLocalSyncToken(aliceSession.sessionId)).token;

          const teamContext = yield* Effect.context<
            | TeamService.TeamService
            | TeamRepository.TeamRepository
            | TeamAssetsRepository.TeamAssetsRepository
            | TeamGitHubBroker.TeamGitHubBroker
            | AuthSessions.AuthSessionRepository
            | EnvironmentAuth.EnvironmentAuth
          >();
          const routerLayer = TeamGitHubHttp.layer.pipe(
            Layer.provideMerge(Layer.succeedContext(teamContext)),
          );
          const { handler, dispose } = HttpRouter.toWebHandler(routerLayer, {
            disableLogger: true,
          });
          yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));

          const teamHttpServer = yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<{ readonly origin: string; readonly close: () => Promise<void> }>(
                  (resolve, reject) => {
                    const srv = NodeHttp.createServer((req, res) => {
                      const chunks: Array<Buffer> = [];
                      req.on("data", (c: Buffer) => chunks.push(c));
                      req.on("end", () => {
                        void (async () => {
                          const body = Buffer.concat(chunks);
                          const webReq = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
                            method: req.method ?? "POST",
                            headers: Object.entries(req.headers).flatMap(([k, v]) =>
                              v === undefined
                                ? []
                                : Array.isArray(v)
                                  ? v.map((item) => [k, item] as [string, string])
                                  : [[k, v] as [string, string]],
                            ),
                            ...(body.byteLength > 0 ? { body } : {}),
                          });
                          const webRes = await handler(webReq);
                          const resBody = Buffer.from(await webRes.arrayBuffer());
                          res.writeHead(
                            webRes.status,
                            Object.fromEntries(webRes.headers.entries()),
                          );
                          res.end(resBody);
                        })();
                      });
                    });
                    srv.on("error", reject);
                    srv.listen(0, "127.0.0.1", () => {
                      const addr = srv.address();
                      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
                      resolve({
                        origin: `http://127.0.0.1:${port}`,
                        close: () =>
                          new Promise<void>((done) => {
                            srv.closeAllConnections?.();
                            srv.close(() => done());
                          }),
                      });
                    });
                  },
                ),
            ),
            (s) => Effect.promise(() => s.close()),
          );

          // 2. Start a completely separate Remote Runner broker (NO local Team DB or PATs!)
          const remoteBrokerLayer = TeamGitHubBroker.layer.pipe(Layer.provide(platform));
          yield* Effect.gen(function* () {
            const remoteBroker = yield* TeamGitHubBroker.TeamGitHubBroker;
            const issued = yield* remoteBroker.requestRemoteTurnLease({
              teamServerUrl: teamHttpServer.origin,
              memberToken: localSyncToken,
              environmentId: remoteEnvId,
              threadId: remoteThreadId,
              turnId: remoteTurnId,
            });
            expect(issued?.hasCredential).toBe(true);
            expect(issued?.identity?.githubLogin).toBe("alice-gh");

            const remoteSessionId = ProviderSessionId.make("ps-remote-1");
            const remoteEnvOverride = yield* remoteBroker.prepareSessionEnvironment({
              providerSessionId: remoteSessionId,
              threadId: remoteThreadId,
              authorKind: "member",
              authorMemberId: null,
              identityOverride: issued!.identity,
            });
            const remoteHostEnv = yield* HostProcess.Environment;
            const remoteChildEnv = applyProviderSessionEnvironmentOverride(
              { ...remoteHostEnv, GH_TOKEN: "REMOTE_HOST_STATIC_TOKEN" },
              remoteEnvOverride,
            );
            expect(remoteChildEnv.GH_TOKEN).toBeUndefined();
            expect(remoteChildEnv.GIT_AUTHOR_NAME).toBe("Alice Owner");
            expect(remoteChildEnv.GIT_AUTHOR_EMAIL).toBe("alice@test.example");

            yield* remoteBroker.activateRemoteTurnLease({
              threadId: remoteThreadId,
              turnId: remoteTurnId,
              providerSessionId: remoteSessionId,
              environmentId: remoteEnvId,
              teamServerUrl: teamHttpServer.origin,
              leaseId: issued!.leaseId!,
              leaseToken: issued!.leaseToken!,
              expiresAt: issued!.expiresAt!,
              authorKind: "member",
              authorMemberId: null,
            });

            // Remote GIT_ASKPASS and gh api both resolve Alice's PAT on-demand from Team Server!
            const remoteAskpass = yield* runHelper(
              remoteChildEnv.GIT_ASKPASS!,
              [`Password for '${fakeGitHub.baseUrl}':`],
              remoteChildEnv,
            );
            expect(remoteAskpass.status).toBe(0);
            expect(remoteAskpass.stdout.trim()).toBe("PAT_ALICE");

            const remoteGhApi = yield* runHelper("gh", ["api", "/user"], remoteChildEnv);
            expect(remoteGhApi.status).toBe(0);
            expect(JSON.parse(remoteGhApi.stdout)).toMatchObject({ login: "alice-gh" });

            // Active remote turn lease can be renewed via Team Server /api/team/github-lease/renew
            expect(
              yield* remoteBroker.renewTurnLease({
                threadId: remoteThreadId,
                turnId: remoteTurnId,
              }),
            ).toBe(true);
            const remoteAfterRenew = yield* runHelper("gh", ["api", "/user"], remoteChildEnv);
            expect(remoteAfterRenew.status).toBe(0);

            // Revoking the turn lease on the remote runner revokes it both locally AND on Team Server
            yield* remoteBroker.revokeTurnLease({
              threadId: remoteThreadId,
              turnId: remoteTurnId,
            });
            const afterRevoke = yield* runHelper("gh", ["api", "/user"], remoteChildEnv);
            expect(afterRevoke.status).not.toBe(0);
          }).pipe(Effect.provide(remoteBrokerLayer));

          // Confirm Team Server's own broker also shows the remote lease is now revoked
          const teamBroker = yield* TeamGitHubBroker.TeamGitHubBroker;
          expect(
            yield* teamBroker.hasActiveTurnLease({
              threadId: remoteThreadId,
              turnId: remoteTurnId,
            }),
          ).toBe(false);
        }).pipe(Effect.provide(teamFullLayer));
      }).pipe(Effect.scoped),
  );
});
