// @effect-diagnostics nodeBuiltinImport:off -- Local mock OAuth token endpoint and temp profile dir for testing server-side refresh/fallback.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient } from "effect/http";
import { describe, expect, it } from "@effect/vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  issueEphemeralTeamProviderLease,
  readLinkedServerInstanceIdFromConfig,
  readTeamProviderSecret,
  resolveLinkedServerProviderProfileDir,
  teamProviderSecretKey,
  writeTeamProviderSecret,
} from "./TeamProviderLeaseService.ts";

const makeTestLayer = () => {
  const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer);
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-lease-test-" }).pipe(
    Layer.provideMerge(platform),
  );
  return ServerSecretStore.layer.pipe(Layer.provideMerge(config));
};

describe("TeamProviderLeaseService", () => {
  it.live(
    "refreshes near-expiry OAuth tokens server-side, persists rotated tokens, and strictly strips refresh_token",
    () =>
      Effect.gen(function* () {
        let refreshHits = 0;
        const server = NodeHttp.createServer((req, res) => {
          if (req.method === "POST" && req.url === "/token") {
            refreshHits += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                access_token: `fresh-access-${refreshHits}`,
                refresh_token: `rotated-refresh-${refreshHits}`,
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
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())),
        );
        const addr = server.address() as { port: number };
        const tokenEndpoint = `http://127.0.0.1:${addr.port}/token`;

        try {
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          const httpClient = yield* HttpClient.HttpClient;
          const secretKey = teamProviderSecretKey("team-1", "team-agy");

          // Store a near-expiry token (expires in 2 minutes -> < 10 min threshold).
          const nearExpiry = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 2 }));
          yield* writeTeamProviderSecret(secrets, secretKey, {
            oauthAccessToken: "stale-access",
            oauthRefreshToken: "super-secret-company-refresh",
            oauthExpiresAt: nearExpiry,
            oauthTokenEndpoint: tokenEndpoint,
            oauthClientId: "cid-1",
            oauthClientSecret: "csecret-1",
          });

          const lease = yield* issueEphemeralTeamProviderLease({
            secrets,
            httpClient,
            secretKey,
            providerInstanceId: ProviderInstanceId.make("team-agy"),
            driver: ProviderDriverKind.make("antigravity"),
          });

          expect(refreshHits).toBe(1);
          expect(lease.accessToken).toBe("fresh-access-1");
          // Strictly no refresh_token or clientSecret in the returned lease!
          const serialized = JSON.stringify(lease);
          expect(serialized).not.toContain("super-secret-company-refresh");
          expect(serialized).not.toContain("rotated-refresh-1");
          expect(serialized).not.toContain("csecret-1");

          // Rotated refresh token was persisted on the Team Server.
          const persisted = yield* readTeamProviderSecret(secrets, secretKey);
          expect(persisted?.oauthRefreshToken).toBe("rotated-refresh-1");

          // Subsequent lease while > 10 min remain reuses cached access token without calling upstream again.
          const lease2 = yield* issueEphemeralTeamProviderLease({
            secrets,
            httpClient,
            secretKey,
            providerInstanceId: ProviderInstanceId.make("team-agy"),
            driver: ProviderDriverKind.make("antigravity"),
          });
          expect(refreshHits).toBe(1);
          expect(lease2.accessToken).toBe("fresh-access-1");
        } finally {
          yield* Effect.promise(
            () => new Promise<void>((resolve) => server.close(() => resolve())),
          );
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.live(
    "leases ephemeral tokens from a linked server provider profile directory when no manual secret is stored, without exposing refresh_token",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-linked-profile-")),
        );
        try {
          const expiresAt = DateTime.toEpochMillis(DateTime.add(yield* DateTime.now, { hours: 1 }));
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(tempDir, ".credentials.json"),
              JSON.stringify({
                claudeAiOauth: {
                  accessToken: "linked-server-access-token",
                  refreshToken: "linked-server-secret-refresh",
                  expiresAt,
                },
              }),
              "utf8",
            ),
          );

          const secrets = yield* ServerSecretStore.ServerSecretStore;
          const httpClient = yield* HttpClient.HttpClient;
          const secretKey = teamProviderSecretKey("team-1", "team-linked-claude");

          const lease = yield* issueEphemeralTeamProviderLease({
            secrets,
            httpClient,
            secretKey,
            providerInstanceId: ProviderInstanceId.make("team-linked-claude"),
            driver: ProviderDriverKind.make("claudeAgent"),
            fallbackProfileDir: tempDir,
          });

          expect(lease.accessToken).toBe("linked-server-access-token");
          expect(JSON.stringify(lease)).not.toContain("linked-server-secret-refresh");

          // Subsequent CLI rotation on disk is picked up immediately without serving a stale snapshot,
          // and linked mode never forwards linked refresh tokens to a manual oauthTokenEndpoint.
          let unexpectedEndpointHits = 0;
          const rogueServer = NodeHttp.createServer((_req, res) => {
            unexpectedEndpointHits += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ access_token: "should-not-happen", expires_in: 3600 }));
          });
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve) => rogueServer.listen(0, "127.0.0.1", () => resolve())),
          );
          try {
            const rogueAddr = rogueServer.address() as { port: number };
            yield* writeTeamProviderSecret(secrets, secretKey, {
              oauthAccessToken: "stale-manual-snapshot",
              oauthRefreshToken: "manual-refresh",
              oauthTokenEndpoint: `http://127.0.0.1:${rogueAddr.port}/steal`,
            });
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(tempDir, ".credentials.json"),
                JSON.stringify({
                  claudeAiOauth: {
                    accessToken: "rotated-live-disk-token",
                    refreshToken: "linked-server-secret-refresh-2",
                    expiresAt,
                  },
                }),
                "utf8",
              ),
            );
            const rotatedLease = yield* issueEphemeralTeamProviderLease({
              secrets,
              httpClient,
              secretKey,
              providerInstanceId: ProviderInstanceId.make("team-linked-claude"),
              driver: ProviderDriverKind.make("claudeAgent"),
              fallbackProfileDir: tempDir,
              forceRefresh: true,
            });
            expect(rotatedLease.accessToken).toBe("rotated-live-disk-token");
            expect(unexpectedEndpointHits).toBe(0);
          } finally {
            yield* Effect.promise(
              () => new Promise<void>((resolve) => rogueServer.close(() => resolve())),
            );
          }
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(tempDir, { recursive: true, force: true }));
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it("rejects virtual team: instance IDs and resolves per-instance custom homePath/env for linked profiles", () => {
    expect(
      readLinkedServerInstanceIdFromConfig({ linkedServerInstanceId: "team:t1:claude" }),
    ).toBeNull();
    expect(
      resolveLinkedServerProviderProfileDir({
        stateDir: "/state",
        driver: "claudeAgent",
        linkedServerInstanceId: "team:t1:claude",
      }),
    ).toBeNull();

    const serverSettings = {
      providerInstances: {
        "claude-work": {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: "/custom/claude-work" },
        },
        "codex-work": {
          driver: ProviderDriverKind.make("codex"),
          environment: [{ name: "CODEX_HOME", value: "/custom/codex-work", sensitive: false }],
        },
        "codex-shadow": {
          driver: ProviderDriverKind.make("codex"),
          config: {
            homePath: "/custom/codex-base",
            shadowHomePath: "/custom/codex-shadow",
          },
        },
      },
    } as never;

    expect(
      resolveLinkedServerProviderProfileDir({
        stateDir: "/state",
        driver: "claudeAgent",
        linkedServerInstanceId: "claude-work",
        serverSettings,
      }),
    ).toBe("/custom/claude-work");
    expect(
      resolveLinkedServerProviderProfileDir({
        stateDir: "/state",
        driver: "codex",
        linkedServerInstanceId: "codex-work",
        serverSettings,
      }),
    ).toBe("/custom/codex-work");
    // Codex authOverlay keeps its private auth.json in shadowHomePath, which must win over homePath.
    expect(
      resolveLinkedServerProviderProfileDir({
        stateDir: "/state",
        driver: "codex",
        linkedServerInstanceId: "codex-shadow",
        serverSettings,
      }),
    ).toBe("/custom/codex-shadow");
    // Stock built-in default instances (synthesized when providerInstances is empty) must resolve cleanly.
    expect(
      resolveLinkedServerProviderProfileDir({
        stateDir: "/state",
        driver: "claudeAgent",
        linkedServerInstanceId: "claudeAgent",
        serverSettings: DEFAULT_SERVER_SETTINGS,
      }),
    ).not.toBeNull();
    expect(
      resolveLinkedServerProviderProfileDir({
        stateDir: "/state",
        driver: "codex",
        linkedServerInstanceId: "codex",
        serverSettings: DEFAULT_SERVER_SETTINGS,
      }),
    ).not.toBeNull();
    expect(
      resolveLinkedServerProviderProfileDir({
        stateDir: "/state",
        driver: "antigravity",
        linkedServerInstanceId: "antigravity",
        serverSettings: DEFAULT_SERVER_SETTINGS,
      }),
    ).toContain(NodePath.join("/state", "providers", "antigravity"));
    // Explicit null serverSettings (read failure) must fail closed rather than falling back to host defaults.
    expect(
      resolveLinkedServerProviderProfileDir({
        stateDir: "/state",
        driver: "codex",
        linkedServerInstanceId: "codex",
        serverSettings: null,
      }),
    ).toBeNull();
    // Driver mismatch or unknown instance ID must return null.
    expect(
      resolveLinkedServerProviderProfileDir({
        stateDir: "/state",
        driver: "codex",
        linkedServerInstanceId: "claude-work",
        serverSettings,
      }),
    ).toBeNull();
    expect(
      resolveLinkedServerProviderProfileDir({
        stateDir: "/state",
        driver: "claudeAgent",
        linkedServerInstanceId: "non-existent",
        serverSettings: DEFAULT_SERVER_SETTINGS,
      }),
    ).toBeNull();
    const inheritedProviderInstances = Object.create({
      "inherited-claude": {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { homePath: "/evil/inherited-claude" },
      },
    });
    expect(
      resolveLinkedServerProviderProfileDir({
        stateDir: "/state",
        driver: "claudeAgent",
        linkedServerInstanceId: "inherited-claude",
        serverSettings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: inheritedProviderInstances,
        } as never,
      }),
    ).toBeNull();
  });
});
