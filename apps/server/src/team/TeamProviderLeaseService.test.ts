// @effect-diagnostics nodeBuiltinImport:off -- Local mock OAuth token endpoint and temp profile dir for testing server-side refresh/fallback.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient } from "effect/http";
import { describe, expect, it } from "@effect/vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  issueEphemeralTeamProviderLease,
  readTeamProviderSecret,
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
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(tempDir, { recursive: true, force: true }));
        }
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
