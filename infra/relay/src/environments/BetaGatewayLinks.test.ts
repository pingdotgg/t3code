// @effect-diagnostics-next-line nodeBuiltinImport:off -- PgClient accepts a Node Duplex for PostgreSQL wire-protocol fixtures.
import * as NodeStream from "node:stream";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { describe, expect, it } from "@effect/vitest";
import { PGlite } from "@electric-sql/pglite";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayEnvironmentLinkProofPayload } from "@t3tools/contracts/relay";
import { sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as BetaGatewayLinks from "./BetaGatewayLinks.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as ManagedTunnelLimits from "./ManagedTunnelLimits.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";

const betaDomain = "beta.example.test";
const testDb = Layer.unwrap(
  Effect.gen(function* () {
    const pg = yield* Effect.acquireRelease(
      Effect.promise(() => PGlite.create()),
      (client) => Effect.promise(() => client.close()),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* path.fromFileUrl(new URL("../../migrations/postgres/", import.meta.url));
    for (const entry of (yield* fs.readDirectory(dir)).toSorted()) {
      const migration = yield* fs.readFileString(path.join(dir, entry, "migration.sql"));
      yield* Effect.promise(() => pg.exec(migration));
    }
    return Layer.effect(RelayDb.RelayDb, PgDrizzle.makeWithDefaults()).pipe(
      Layer.provide(
        PgClient.layer({
          username: "postgres",
          database: "postgres",
          password: Redacted.make("password"),
          maxConnections: 1,
          stream: () =>
            new NodeStream.Duplex({
              read() {},
              write(chunk: Buffer, _encoding, callback) {
                void pg.execProtocolRaw(chunk).then((response) => {
                  if (response.byteLength > 0) this.push(response);
                  callback();
                }, callback);
              },
            }),
        }),
      ),
    );
  }),
).pipe(Layer.provide(NodeServices.layer));

const services = BetaGatewayLinks.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(EnvironmentCredentials.layer, EnvironmentLinks.layer, ManagedTunnelLimits.layer),
  ),
  Layer.provideMerge(testDb),
  Layer.provide(Layer.mock(T3ChatAccounts.T3ChatAccounts, { available: false })),
  Layer.provide(
    RelayConfiguration.layer({
      relayIssuer: "https://relay.example.test",
      apns: null,
      clerkSecretKey: Redacted.make("secret"),
      clerkPublishableKey: "pub",
      clerkJwtAudience: "relay",
      apnsDeliveryJobSigningSecret: Redacted.make("job"),
      cloudMintPrivateKey: Redacted.make("private"),
      cloudMintPublicKey: "pub",
      managedEndpointBaseDomain: undefined,
      betaGatewayDomain: betaDomain,
      betaGatewayTesters: new Set(["user", "other"]),
      managedEndpointNamespace: "test",
    }),
  ),
  Layer.provideMerge(NodeCrypto.layer),
);

const enrollment = (userId: string, id: string) => {
  const environmentId = EnvironmentId.make(id);
  return {
    userId,
    challengeExpiresAt: 60,
    request: {
      proof: "validated",
      notificationsEnabled: true,
      liveActivitiesEnabled: false,
      managedTunnelsEnabled: true,
    },
    proof: {
      iss: `t3-env:${id}`,
      aud: "relay",
      sub: id,
      jti: "nonce",
      iat: 0,
      exp: 60,
      challenge: "challenge",
      environmentId,
      environmentPublicKey: `key-${id}`,
      descriptor: {
        environmentId,
        label: "host",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "test",
        capabilities: { repositoryIdentity: true },
      },
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      endpoint: {
        providerKind: "t3_relay",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773/ws",
      },
      scopes: ["managed_tunnels"],
    } satisfies RelayEnvironmentLinkProofPayload,
  };
};

describe("beta gateway links", () => {
  it.effect("an unlink ahead of a delayed enrollment cancels only that signed attempt", () =>
    Effect.gen(function* () {
      const beta = yield* BetaGatewayLinks.BetaGatewayLinks;
      const attempt = enrollment("user", "pending");
      yield* beta.revoke({
        userId: "user",
        environmentId: "pending",
        attemptId: attempt.proof.jti,
      });
      expect((yield* Effect.flip(beta.enroll(attempt)))._tag).toBe("BetaGatewayLinkConflict");
      expect(
        (yield* beta.enroll({ ...attempt, proof: { ...attempt.proof, jti: "fresh" } }))
          .environmentId,
      ).toBe("pending");
      expect(
        yield* beta.revoke({
          userId: "user",
          environmentId: "pending",
          attemptId: attempt.proof.jti,
        }),
      ).toBeNull();
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      expect(yield* links.getForUser({ userId: "user", environmentId: "pending" })).not.toBeNull();
    }).pipe(Effect.provide(services)),
  );
  it.effect(
    "admits one competing 100th link, rotates credentials on relink, and frees the slot on unlink",
    () =>
      Effect.gen(function* () {
        const db = yield* RelayDb.RelayDb;
        const beta = yield* BetaGatewayLinks.BetaGatewayLinks;
        const links = yield* EnvironmentLinks.EnvironmentLinks;
        const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
        const digest = yield* Digest.Digest;
        const tokenHash = (token: string) =>
          digest
            .digest(Digest.sha256, new TextEncoder().encode(token))
            .pipe(Effect.map(Hex.encode));
        yield* db.execute(sql`insert into relay_environment_links (user_id, environment_id, environment_public_key, endpoint_http_base_url, endpoint_ws_base_url, endpoint_provider_kind, managed_tunnels_enabled, created_at, updated_at)
        select 'user', 'env-' || n, 'public-key', 'https://env.test/', 'wss://env.test/ws', 't3_relay', true, '2026-01-01', '2026-01-01' from generate_series(1,99) n`);
        const classic = enrollment("user", "classic-online");
        yield* links.upsert({
          ...classic,
          endpoint: { ...classic.proof.endpoint, providerKind: "cloudflare_tunnel" },
        });
        const outcomes = yield* Effect.forEach(
          ["one", "two"],
          (id) => beta.enroll(enrollment("user", id)).pipe(Effect.result),
          { concurrency: 2 },
        );
        const admitted = outcomes.find(Result.isSuccess)?.success;
        const rejected = outcomes.find(Result.isFailure)?.failure;
        if (!admitted || rejected?._tag !== "ManagedTunnelLimitExceeded")
          throw new Error("Expected exactly one competing link to fit");
        expect(rejected.activeTunnels).toBe(100);
        const key = { userId: "user", environmentId: admitted.environmentId };
        const hash = yield* tokenHash(admitted.endpointRuntime.connectorToken);
        const hostname = new URL(admitted.endpoint.httpBaseUrl).hostname;
        expect(yield* beta.authorizeBetaConnectors([hash, "unknown"])).toEqual([
          { tokenHash: hash, hostname },
        ]);
        const saved = yield* links.getForUser(key);
        if (!saved?.betaEndpointKey) throw new Error("missing hook key");
        expect(yield* beta.findHookEndpoint(saved.betaEndpointKey)).toMatchObject({
          httpBaseUrl: admitted.endpoint.httpBaseUrl,
          environmentId: admitted.environmentId,
        });
        expect(
          yield* limits
            .withCapacity(key, Effect.die("must not allocate classic"))
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "BetaGatewayLinkConflict" });
        const changedIdentity = enrollment("user", admitted.environmentId);
        changedIdentity.proof.environmentPublicKey = "another-host";
        expect(yield* beta.enroll(changedIdentity).pipe(Effect.flip)).toMatchObject({
          _tag: "BetaGatewayLinkConflict",
        });

        const renewed = yield* beta.enroll(enrollment("user", admitted.environmentId));
        expect(renewed.endpoint).toEqual(admitted.endpoint);
        const newHash = yield* tokenHash(renewed.endpointRuntime.connectorToken);
        expect(yield* beta.authorizeBetaConnectors([hash, newHash])).toEqual([
          { tokenHash: newHash, hostname },
        ]);
        yield* links.revokeForUser(key);
        expect(yield* beta.authorizeBetaConnectors([newHash])).toEqual([]);
        expect(yield* beta.findHookEndpoint(saved.betaEndpointKey)).toBeNull();
        expect((yield* Effect.flip(beta.enroll(changedIdentity)))._tag).toBe(
          "BetaGatewayLinkConflict",
        );
        expect(
          (yield* links.getForUser({ ...key, includeRetiringBeta: true }))?.betaEndpointKey,
        ).toBe(saved.betaEndpointKey);
        yield* beta.finishBetaRetirement({ ...key, endpointKey: saved.betaEndpointKey });
        const replacement = yield* beta.enroll(changedIdentity);
        expect(replacement.endpoint.httpBaseUrl).not.toBe(renewed.endpoint.httpBaseUrl);
        expect(yield* beta.findHookEndpoint(saved.betaEndpointKey)).toBeNull();
        const replacementKey = new URL(replacement.endpoint.httpBaseUrl).hostname.split(".")[0]!;
        expect(yield* beta.findHookEndpoint(replacementKey)).toMatchObject({
          httpBaseUrl: replacement.endpoint.httpBaseUrl,
        });
        yield* links.revokeForUser(key);
        expect((yield* beta.enroll(enrollment("user", rejected.environmentId))).environmentId).toBe(
          rejected.environmentId,
        );
        expect(
          (yield* beta.enroll(enrollment("other", admitted.environmentId))).endpoint,
        ).not.toEqual(admitted.endpoint);
      }).pipe(Effect.provide(services)),
  );
  it.effect(
    "refuses accounts outside the testers and classic reservations, and rolls back a failed environment credential write",
    () =>
      Effect.gen(function* () {
        const beta = yield* BetaGatewayLinks.BetaGatewayLinks;
        const links = yield* EnvironmentLinks.EnvironmentLinks;
        const db = yield* RelayDb.RelayDb;
        expect(yield* beta.enroll(enrollment("outsider", "env")).pipe(Effect.flip)).toMatchObject({
          _tag: "BetaGatewayUnavailable",
        });
        expect(yield* links.getForUser({ userId: "outsider", environmentId: "env" })).toBeNull();
        yield* db.execute(sql`insert into relay_managed_endpoint_allocations (user_id,environment_id,hostname,tunnel_name,created_at,updated_at)
        values ('user','classic','classic.example.test','classic','2026-01-01','2026-01-01')`);
        expect(yield* beta.enroll(enrollment("user", "classic")).pipe(Effect.flip)).toMatchObject({
          _tag: "BetaGatewayLinkConflict",
        });
        yield* db.execute(
          sql`alter table relay_environment_credentials add check (environment_id <> 'refused')`,
        );
        expect(yield* beta.enroll(enrollment("user", "refused")).pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentCredentialCreatePersistenceError",
        });
        expect(yield* links.getForUser({ userId: "user", environmentId: "refused" })).toBeNull();
      }).pipe(Effect.provide(services)),
  );
});
