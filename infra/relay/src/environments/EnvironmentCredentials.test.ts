import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as RelayDb from "../db.ts";
import { makePgliteRelayDb } from "../persistence/pgliteTestDb.ts";
import { relayEnvironmentCredentials } from "../persistence/schema.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";

describe("EnvironmentCredentials", () => {
  it.effect("does not retain credential tokens when lookup persistence fails", () => {
    const cause = new Error("database unavailable");
    const token = "t3env_sensitive-credential-token";
    const whereConditions: Array<unknown> = [];
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => {
          expect(table).toBe(relayEnvironmentCredentials);
          return {
            where: (condition: unknown) => ({
              limit: () => {
                whereConditions.push(condition);
                return Effect.fail(cause);
              },
            }),
          };
        },
      }),
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
      const error = yield* Effect.flip(credentials.authenticate(token));

      expect(error).toMatchObject({
        _tag: "EnvironmentCredentialAuthenticatePersistenceError",
        stage: "lookup-credential",
      });
      expect(error.cause).toBe(cause);
      expect(error).not.toHaveProperty("token");
      expect(whereConditions).toHaveLength(1);

      const query = new PgDialect().sqlToQuery(whereConditions[0] as never);
      expect(query.sql).toContain("exists");
      expect(query.sql).toContain('"relay_environment_links"."environment_id"');
      expect(query.sql).toContain('"relay_environment_links"."environment_public_key"');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
    }).pipe(
      Effect.provide(
        EnvironmentCredentials.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect(
    "creates opaque credentials and revokes only older credentials for the same key",
    () => {
      const insertedValues: Array<{
        readonly credentialId: string;
        readonly environmentId: string;
        readonly environmentPublicKey: string;
        readonly credentialHash: string;
        readonly revokedAt: null;
        readonly createdAt: string;
        readonly updatedAt: string;
      }> = [];
      const staleCredentialRevocations: Array<{
        readonly values: Record<string, unknown>;
        readonly condition: unknown;
      }> = [];

      const fakeDb = {
        insert: (table: unknown) => {
          expect(table).toBe(relayEnvironmentCredentials);
          return {
            values: (values: (typeof insertedValues)[number]) => {
              insertedValues.push(values);
              return Effect.void;
            },
          };
        },
        update: (table: unknown) => {
          expect(table).toBe(relayEnvironmentCredentials);
          return {
            set: (values: Record<string, unknown>) => ({
              where: (condition: unknown) => {
                staleCredentialRevocations.push({ values, condition });
                return Effect.void;
              },
            }),
          };
        },
      } as unknown as RelayDb.RelayDb["Service"];

      return Effect.gen(function* () {
        const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
        const token = yield* credentials.create({
          environmentId: "env_test",
          environmentPublicKey: "environment-public-key",
        });
        const [, credentialId, secret] = token.split("_");

        expect(token).toMatch(/^t3env_[0-9a-f]{64}_[0-9a-f]{96}$/);
        expect(credentialId).toHaveLength(64);
        expect(secret).toHaveLength(96);
        expect(insertedValues).toHaveLength(1);
        expect(insertedValues[0]).toMatchObject({
          credentialId,
          environmentId: "env_test",
          environmentPublicKey: "environment-public-key",
          revokedAt: null,
        });
        expect(insertedValues[0]?.credentialHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(insertedValues[0]?.credentialHash).not.toContain(token);
        expect(insertedValues[0]?.createdAt).toBe(insertedValues[0]?.updatedAt);
        expect(staleCredentialRevocations).toHaveLength(1);
        expect(staleCredentialRevocations[0]?.values.revokedAt).toEqual(
          staleCredentialRevocations[0]?.values.updatedAt,
        );

        const query = new PgDialect().sqlToQuery(staleCredentialRevocations[0]?.condition as never);
        expect(query.sql).toContain('"relay_environment_credentials"."environment_id" = $1');
        expect(query.sql).toContain(
          '"relay_environment_credentials"."environment_public_key" = $2',
        );
        expect(query.sql).toContain('"relay_environment_credentials"."credential_id" <> $3');
        expect(query.sql).toContain('"relay_environment_credentials"."revoked_at" is null');
        expect(query.params).toEqual(["env_test", "environment-public-key", credentialId]);
      }).pipe(
        Effect.provide(
          EnvironmentCredentials.layer.pipe(
            Layer.provide(NodeCryptoLayer.layer),
            Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
          ),
        ),
      );
    },
  );

  it.effect("revokes active credentials for an environment public key", () => {
    const updateValues: Array<Record<string, unknown>> = [];
    const whereConditions: Array<unknown> = [];
    const fakeDb = {
      update: (table: unknown) => {
        expect(table).toBe(relayEnvironmentCredentials);
        return {
          set: (values: Record<string, unknown>) => {
            updateValues.push(values);
            return {
              where: (condition: unknown) => {
                whereConditions.push(condition);
                return {
                  returning: () => {
                    return Effect.succeed([{ credentialId: "credential-1" }]);
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as RelayDb.RelayDb["Service"];

    return Effect.gen(function* () {
      const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
      const revoked = yield* credentials.revokeForEnvironmentPublicKey({
        environmentId: "env_test",
        environmentPublicKey: "environment-public-key",
      });

      expect(revoked).toBe(true);
      expect(updateValues).toHaveLength(1);
      expect(updateValues[0]?.revokedAt).toEqual(updateValues[0]?.updatedAt);
      expect(whereConditions).toHaveLength(1);

      const query = new PgDialect().sqlToQuery(whereConditions[0] as never);
      expect(query.sql).toContain('"relay_environment_credentials"."environment_id" = $1');
      expect(query.sql).toContain('"relay_environment_credentials"."environment_public_key" = $2');
      expect(query.sql).toContain('"relay_environment_credentials"."revoked_at" is null');
      expect(query.sql).toContain("not exists");
      expect(query.sql).toContain('"relay_environment_links"."environment_id" = $3');
      expect(query.sql).toContain('"relay_environment_links"."environment_public_key" = $4');
      expect(query.sql).toContain('"relay_environment_links"."revoked_at" is null');
      expect(query.params).toEqual([
        "env_test",
        "environment-public-key",
        "env_test",
        "environment-public-key",
      ]);
    }).pipe(
      Effect.provide(
        EnvironmentCredentials.layer.pipe(
          Layer.provide(NodeCryptoLayer.layer),
          Layer.provide(Layer.succeed(RelayDb.RelayDb, fakeDb)),
        ),
      ),
    );
  });

  it.effect("prunes credentials revoked over 30 days ago", () =>
    Effect.gen(function* () {
      const now = Date.parse("2026-06-01T00:00:00.000Z");
      yield* TestClock.setTime(now);
      const daysAgo = (days: number) =>
        DateTime.formatIso(DateTime.makeUnsafe(now - days * 86_400_000));
      const { db, layer } = yield* makePgliteRelayDb;
      const credential = (credentialId: string, revokedAt: string | null) => ({
        credentialId,
        environmentId: "env-1",
        environmentPublicKey: "key-1",
        credentialHash: `hash-${credentialId}`,
        revokedAt,
        createdAt: daysAgo(90),
        updatedAt: revokedAt ?? daysAgo(90),
      });
      yield* Effect.promise(() =>
        db
          .insert(relayEnvironmentCredentials)
          .values([
            credential("old-revoked", daysAgo(31)),
            credential("recently-revoked", daysAgo(29)),
            credential("active", null),
          ]),
      );
      const credentials = yield* Effect.service(EnvironmentCredentials.EnvironmentCredentials).pipe(
        Effect.provide(
          EnvironmentCredentials.layer.pipe(
            Layer.provide(NodeCryptoLayer.layer),
            Layer.provide(layer),
          ),
        ),
      );

      expect(yield* credentials.pruneRevoked).toBe(1);
      const remaining = yield* Effect.promise(() => db.select().from(relayEnvironmentCredentials));
      expect(remaining.map((row) => row.credentialId).toSorted()).toEqual([
        "active",
        "recently-revoked",
      ]);
    }),
  );
});
