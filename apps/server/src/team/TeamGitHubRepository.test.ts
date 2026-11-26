// @effect-diagnostics nodeBuiltinImport:off -- Local HTTP mock server for GitHub API verification tests.
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_GITHUB_API_BASE_URL,
  TeamId,
  TeamMemberId,
  TeamViewId,
  type TeamPseudo,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient, HttpClient } from "effect/http";
import { describe, expect, it } from "@effect/vitest";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TeamGitHubRepository from "./TeamGitHubRepository.ts";
import * as TeamRepository from "./TeamRepository.ts";

interface MockGitHubServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

function startMockGitHubApi(
  handler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => void,
): Promise<MockGitHubServer> {
  return new Promise((resolve, reject) => {
    const server = NodeHttp.createServer(handler);
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
  });
}

const testPersistenceLayer = () => {
  const base = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-team-gh-repo-test-",
  }).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer)),
  );
  const sqliteLayer = SqlitePersistence.layerMemory.pipe(Layer.provide(base));
  return Layer.mergeAll(
    base,
    sqliteLayer,
    TeamRepository.layer.pipe(Layer.provide(sqliteLayer)),
    TeamGitHubRepository.layer.pipe(Layer.provide(sqliteLayer)),
    ServerSecretStore.layer.pipe(Layer.provide(base)),
  );
};

describe("TeamGitHubRepository", () => {
  it.live("normalizes GitHub API base URLs and rejects invalid or credential-bearing URLs", () =>
    Effect.gen(function* () {
      const defaultUrl = yield* TeamGitHubRepository.normalizeGitHubApiBaseUrl();
      expect(defaultUrl).toBe(DEFAULT_GITHUB_API_BASE_URL);

      const gheUrl = yield* TeamGitHubRepository.normalizeGitHubApiBaseUrl(
        "https://ghe.acme.internal/api/v3///",
      );
      expect(gheUrl).toBe("https://ghe.acme.internal/api/v3");

      const withCreds = yield* Effect.result(
        TeamGitHubRepository.normalizeGitHubApiBaseUrl("https://user:pass@api.github.com"),
      );
      expect(withCreds._tag).toBe("Failure");

      const nonHttp = yield* Effect.result(
        TeamGitHubRepository.normalizeGitHubApiBaseUrl("file:///etc/passwd"),
      );
      expect(nonHttp._tag).toBe("Failure");
    }),
  );

  it.live(
    "verifies PATs against the GitHub API, resolves private primary email, and refuses redirects/401",
    () =>
      Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockGitHubApi((req, res) => {
              const auth = req.headers.authorization;
              if (req.url === "/redirect/user") {
                res.writeHead(302, { location: "http://127.0.0.1:9/steal" });
                res.end();
                return;
              }
              if (auth === "Bearer PAT_ALICE") {
                if (req.url === "/user") {
                  res.writeHead(200, { "content-type": "application/json" });
                  res.end(
                    JSON.stringify({ id: 42, login: "alice-gh", name: "Alice Dev", email: null }),
                  );
                  return;
                }
                if (req.url === "/user/emails") {
                  res.writeHead(200, { "content-type": "application/json" });
                  res.end(
                    JSON.stringify([
                      { email: "secondary@acme.dev", primary: false, verified: true },
                      { email: "alice@acme.dev", primary: true, verified: true },
                    ]),
                  );
                  return;
                }
              }
              if (auth === "Bearer PAT_NO_EMAIL") {
                if (req.url === "/user") {
                  res.writeHead(200, { "content-type": "application/json" });
                  res.end(JSON.stringify({ id: 99, login: "bot-user", name: null, email: null }));
                  return;
                }
                if (req.url === "/user/emails") {
                  res.writeHead(403, { "content-type": "application/json" });
                  res.end(JSON.stringify({ message: "Forbidden" }));
                  return;
                }
              }
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ message: "Bad credentials" }));
            }),
          ),
          (m) => Effect.promise(() => m.close()),
        );
        const httpClient = yield* HttpClient.HttpClient;

        const verifiedAlice = yield* TeamGitHubRepository.verifyGitHubToken({
          httpClient,
          token: "PAT_ALICE",
          apiBaseUrl: mock.baseUrl,
        });
        expect(verifiedAlice.githubLogin).toBe("alice-gh");
        expect(verifiedAlice.githubName).toBe("Alice Dev");
        expect(verifiedAlice.githubEmail).toBe("alice@acme.dev");

        const verifiedNoEmail = yield* TeamGitHubRepository.verifyGitHubToken({
          httpClient,
          token: "PAT_NO_EMAIL",
          apiBaseUrl: mock.baseUrl,
        });
        expect(verifiedNoEmail.githubLogin).toBe("bot-user");
        expect(verifiedNoEmail.githubName).toBe("bot-user");
        expect(verifiedNoEmail.githubEmail).toBe("99+bot-user@users.noreply.github.com");

        const rejected = yield* Effect.result(
          TeamGitHubRepository.verifyGitHubToken({
            httpClient,
            token: "BAD_PAT",
            apiBaseUrl: mock.baseUrl,
          }),
        );
        expect(rejected._tag).toBe("Failure");
        if (rejected._tag === "Failure") {
          expect(rejected.failure.code).toBe("github_verification_failed");
        }

        const redirected = yield* Effect.result(
          TeamGitHubRepository.verifyGitHubToken({
            httpClient,
            token: "PAT_ALICE",
            apiBaseUrl: `${mock.baseUrl}/redirect`,
          }),
        );
        expect(redirected._tag).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );

  it.live(
    "persists member & automation credentials, syncs team_members columns, and stores secrets encrypted",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const teamRepo = yield* TeamRepository.TeamRepository;
        const githubRepo = yield* TeamGitHubRepository.TeamGitHubRepository;
        const secrets = yield* ServerSecretStore.ServerSecretStore;

        const now = "2026-11-26T12:00:00.000Z";
        const teamId = TeamId.make("team-gh-1");
        const memberId = TeamMemberId.make("member-alice");
        const defaultViewId = TeamViewId.make("view-default");
        yield* teamRepo.initializeWorkspace({
          team: {
            id: teamId,
            name: "Acme",
            defaultViewId,
            createdAt: now,
            updatedAt: now,
          },
          owner: {
            id: memberId,
            teamId,
            pseudo: "alice" as TeamPseudo,
            role: "owner",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
          ownerSessionId: "sess-1" as never,
        });

        const secretKey = TeamGitHubRepository.teamMemberGitHubSecretKey(teamId, memberId);
        yield* TeamGitHubRepository.writeTeamGitHubSecret(secrets, secretKey, {
          authMethod: "pat",
          accessToken: "PAT_SECRET_ALICE",
          apiBaseUrl: DEFAULT_GITHUB_API_BASE_URL,
          githubLogin: "alice-gh",
          githubName: "Alice",
          githubEmail: "alice@acme.dev",
        });
        yield* githubRepo.upsertMemberCredential({
          memberId,
          teamId,
          authMethod: "pat",
          githubLogin: "alice-gh",
          githubName: "Alice",
          githubEmail: "alice@acme.dev",
          apiBaseUrl: DEFAULT_GITHUB_API_BASE_URL,
          secretKey,
          connectedAt: now,
          updatedAt: now,
        });

        const stored = yield* githubRepo.getMemberCredential(memberId);
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          expect(stored.value.githubLogin).toBe("alice-gh");
          expect(stored.value.authMethod).toBe("pat");
        }

        const memberRows = yield* sql<{
          readonly github_login: string | null;
          readonly github_name: string | null;
          readonly github_email: string | null;
        }>`SELECT github_login, github_name, github_email FROM team_members WHERE id = ${memberId}`;
        expect(memberRows[0]).toEqual({
          github_login: "alice-gh",
          github_name: "Alice",
          github_email: "alice@acme.dev",
        });

        const secretRead = yield* TeamGitHubRepository.readTeamGitHubSecret(secrets, secretKey);
        expect(secretRead?.accessToken).toBe("PAT_SECRET_ALICE");

        // Delete clears both sidecar table and team_members columns
        const removedKey = yield* githubRepo.deleteMemberCredential(memberId);
        expect(Option.getOrNull(removedKey)).toBe(secretKey);
        yield* TeamGitHubRepository.removeTeamGitHubSecret(secrets, secretKey);
        expect(yield* TeamGitHubRepository.readTeamGitHubSecret(secrets, secretKey)).toBeNull();

        const clearedRows = yield* sql<{
          readonly github_login: string | null;
        }>`SELECT github_login FROM team_members WHERE id = ${memberId}`;
        expect(clearedRows[0]?.github_login).toBeNull();

        // Automation credential CRUD
        const autoKey = TeamGitHubRepository.teamAutomationGitHubSecretKey(teamId);
        yield* githubRepo.upsertAutomationCredential({
          teamId,
          authMethod: "github_app",
          githubLogin: "acme-bot",
          githubName: "Acme Bot",
          githubEmail: "bot@acme.dev",
          apiBaseUrl: DEFAULT_GITHUB_API_BASE_URL,
          secretKey: autoKey,
          updatedByMemberId: memberId,
          connectedAt: now,
          updatedAt: now,
        });
        const autoOpt = yield* githubRepo.getAutomationCredential(teamId);
        expect(Option.isSome(autoOpt)).toBe(true);
        if (Option.isSome(autoOpt)) {
          expect(autoOpt.value.githubLogin).toBe("acme-bot");
          expect(autoOpt.value.authMethod).toBe("github_app");
        }
        const removedAutoKey = yield* githubRepo.deleteAutomationCredential(teamId);
        expect(Option.getOrNull(removedAutoKey)).toBe(autoKey);
        expect(Option.isNone(yield* githubRepo.getAutomationCredential(teamId))).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(testPersistenceLayer())),
  );
});
