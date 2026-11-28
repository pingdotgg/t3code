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
  it.live("normalizes GitHub API base URLs and enforces SSRF/destination policy", () =>
    Effect.gen(function* () {
      const defaultUrl = yield* TeamGitHubRepository.normalizeGitHubApiBaseUrl();
      expect(defaultUrl).toBe(DEFAULT_GITHUB_API_BASE_URL);

      const gheUrl = yield* TeamGitHubRepository.normalizeGitHubApiBaseUrl(
        "https://ghe.acme.example/api/v3///",
      );
      expect(gheUrl).toBe("https://ghe.acme.example/api/v3");

      const withCreds = yield* Effect.result(
        TeamGitHubRepository.normalizeGitHubApiBaseUrl("https://user:pass@api.github.com"),
      );
      expect(withCreds._tag).toBe("Failure");

      const nonHttp = yield* Effect.result(
        TeamGitHubRepository.normalizeGitHubApiBaseUrl("file:///etc/passwd"),
      );
      expect(nonHttp._tag).toBe("Failure");

      // Block plain HTTP, loopback, link-local metadata, and private RFC1918/ULA unless explicitly allowlisted
      for (const blocked of [
        "http://api.github.com",
        "http://127.0.0.1:41234",
        "https://127.0.0.1:41234/api/v3",
        "https://localhost/api/v3",
        "https://sub.localhost/api/v3",
        "https://169.254.169.254/latest/meta-data",
        "https://10.0.0.5/api/v3",
        "https://172.16.0.1/api/v3",
        "https://192.168.1.1/api/v3",
        "https://[::1]/api/v3",
        "https://[::ffff:127.0.0.1]/api/v3",
        "https://[fe80::1]/api/v3",
        "https://[fc00::1]/api/v3",
      ]) {
        const res = yield* Effect.result(TeamGitHubRepository.normalizeGitHubApiBaseUrl(blocked));
        expect(res._tag, `expected ${blocked} to be rejected`).toBe("Failure");
      }

      // Explicit server-side allowlist permits internal GHE or local test origins
      const allowlisted = yield* TeamGitHubRepository.normalizeGitHubApiBaseUrl(
        "http://127.0.0.1:41234/api/v3/",
        { allowedApiOrigins: ["http://127.0.0.1:41234"] },
      );
      expect(allowlisted).toBe("http://127.0.0.1:41234/api/v3");
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
          allowedApiOrigins: [mock.baseUrl],
        });
        expect(verifiedAlice.githubLogin).toBe("alice-gh");
        expect(verifiedAlice.githubName).toBe("Alice Dev");
        expect(verifiedAlice.githubEmail).toBe("alice@acme.dev");

        // Without allowlist, loopback HTTP is refused before issuing any outbound request
        const ssrfBlocked = yield* Effect.result(
          TeamGitHubRepository.verifyGitHubToken({
            httpClient,
            token: "PAT_ALICE",
            apiBaseUrl: mock.baseUrl,
          }),
        );
        expect(ssrfBlocked._tag).toBe("Failure");

        // DNS rebinding / custom hostname resolving to private/metadata IP is blocked
        const dnsBlocked = yield* Effect.result(
          TeamGitHubRepository.verifyGitHubToken({
            httpClient,
            token: "PAT_ALICE",
            apiBaseUrl: "https://rebind.evil.example/api/v3",
            resolveHostAddresses: async () => ["169.254.169.254"],
          }),
        );
        expect(dnsBlocked._tag).toBe("Failure");

        const verifiedNoEmail = yield* TeamGitHubRepository.verifyGitHubToken({
          httpClient,
          token: "PAT_NO_EMAIL",
          apiBaseUrl: mock.baseUrl,
          allowedApiOrigins: [mock.baseUrl],
        });
        expect(verifiedNoEmail.githubLogin).toBe("bot-user");
        expect(verifiedNoEmail.githubName).toBe("bot-user");
        expect(verifiedNoEmail.githubEmail).toBe("99+bot-user@users.noreply.github.com");

        const rejected = yield* Effect.result(
          TeamGitHubRepository.verifyGitHubToken({
            httpClient,
            token: "BAD_PAT",
            apiBaseUrl: mock.baseUrl,
            allowedApiOrigins: [mock.baseUrl],
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
            allowedApiOrigins: [mock.baseUrl],
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

        // Verify persisted raw bytes in ServerSecretStore are AES-256-GCM ciphertext (never plaintext PAT)
        const rawStoredBytes = yield* secrets.get(secretKey);
        expect(Option.isSome(rawStoredBytes)).toBe(true);
        if (Option.isSome(rawStoredBytes)) {
          const rawText = new TextDecoder().decode(rawStoredBytes.value);
          expect(rawText).not.toContain("PAT_SECRET_ALICE");
          expect(rawText).not.toContain("alice-gh");
          const envelope = JSON.parse(rawText) as {
            readonly v: number;
            readonly alg: string;
            readonly iv: string;
            readonly tag: string;
            readonly ciphertext: string;
          };
          expect(envelope.v).toBe(1);
          expect(envelope.alg).toBe("aes-256-gcm");
          expect(envelope.ciphertext.length).toBeGreaterThan(0);

          // Transplanting the ciphertext under a different secretKey fails AAD verification
          const transplantedKey = `${secretKey}-other`;
          yield* secrets.set(transplantedKey, rawStoredBytes.value);
          expect(
            yield* TeamGitHubRepository.readTeamGitHubSecret(secrets, transplantedKey),
          ).toBeNull();
        }

        const secretRead = yield* TeamGitHubRepository.readTeamGitHubSecret(secrets, secretKey);
        expect(secretRead?.accessToken).toBe("PAT_SECRET_ALICE");

        // Delete clears both sidecar table and team_members columns AND updates team_members.updated_at
        const disconnectTimestamp = "2026-11-26T13:00:00.000Z";
        const removedKey = yield* githubRepo.deleteMemberCredential(memberId, disconnectTimestamp);
        expect(Option.getOrNull(removedKey)).toBe(secretKey);
        yield* TeamGitHubRepository.removeTeamGitHubSecret(secrets, secretKey);
        expect(yield* TeamGitHubRepository.readTeamGitHubSecret(secrets, secretKey)).toBeNull();

        const clearedRows = yield* sql<{
          readonly github_login: string | null;
          readonly updated_at: string;
        }>`SELECT github_login, updated_at FROM team_members WHERE id = ${memberId}`;
        expect(clearedRows[0]?.github_login).toBeNull();
        expect(clearedRows[0]?.updated_at).toBe(disconnectTimestamp);

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

  it.live(
    "atomically initializes the encryption key across concurrent first writes and rejects malformed keys",
    () =>
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const teamId = TeamId.make("team-concurrent-init");
        const memberKeys = Array.from({ length: 6 }, (_, index) => ({
          key: TeamGitHubRepository.teamMemberGitHubSecretKey(
            teamId,
            TeamMemberId.make(`member-c-${index}`),
          ),
          token: `PAT_CONCURRENT_${index}`,
          login: `user-${index}`,
        }));

        yield* Effect.forEach(
          memberKeys,
          (entry) =>
            TeamGitHubRepository.writeTeamGitHubSecret(secrets, entry.key, {
              authMethod: "pat",
              accessToken: entry.token,
              apiBaseUrl: DEFAULT_GITHUB_API_BASE_URL,
              githubLogin: entry.login,
              githubName: entry.login,
              githubEmail: `${entry.login}@acme.dev`,
            }),
          { concurrency: "unbounded", discard: true },
        );

        // Every concurrently written secret must decrypt cleanly under the single shared key
        for (const entry of memberKeys) {
          const decrypted = yield* TeamGitHubRepository.readTeamGitHubSecret(secrets, entry.key);
          expect(decrypted?.accessToken).toBe(entry.token);
          expect(decrypted?.githubLogin).toBe(entry.login);
        }

        // Malformed encryption key must be rejected instead of silently overwritten
        yield* secrets.set("team-github-encryption-key-v1", new Uint8Array([1, 2, 3]));
        const writeWithMalformed = yield* Effect.result(
          TeamGitHubRepository.writeTeamGitHubSecret(secrets, memberKeys[0]!.key, {
            authMethod: "pat",
            accessToken: "PAT_SHOULD_FAIL",
            apiBaseUrl: DEFAULT_GITHUB_API_BASE_URL,
            githubLogin: "user-0",
            githubName: "user-0",
            githubEmail: "user-0@acme.dev",
          }),
        );
        expect(writeWithMalformed._tag).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(testPersistenceLayer())),
  );
});
