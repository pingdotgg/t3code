import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as SqlError from "effect/sql/SqlError";
import * as Semaphore from "effect/Semaphore";

import * as RelayDb from "../db.ts";
import { relayEnvironmentCredentials } from "../persistence/schema.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";

const layerWithDb = (db: RelayDb.RelayDb["Service"]) =>
  EnvironmentCredentials.layer.pipe(
    Layer.provide(NodeCryptoLayer.layer),
    Layer.provide(Layer.succeed(RelayDb.RelayDb, db)),
  );

// Models one environment/key pair; SQL predicates are covered by the existing tests below.
const makeCredentialStore = (options: {
  readonly beforeRevoke?: Effect.Effect<void, Error>;
  readonly onLockWait?: Effect.Effect<void>;
  readonly commit?: Effect.Effect<void, SqlError.SqlError>;
}) => {
  let active = new Set<string>();
  const lock = Semaphore.makeUnsafe(1);
  const db = {
    execute: () =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          if (!(yield* lock.takeIfAvailable(1))) {
            yield* options.onLockWait ?? Effect.void;
            yield* lock.take(1);
          }
        }),
        () => lock.release(1),
      ),
    insert: () => ({
      values: ({ credentialId }: { credentialId: string }) =>
        Effect.sync(() => active.add(credentialId)),
    }),
    update: () => ({
      set: () => ({
        where: (condition: unknown) =>
          Effect.gen(function* () {
            yield* options.beforeRevoke ?? Effect.void;
            const keep = new PgDialect().sqlToQuery(condition as never).params[2];
            for (const id of active) {
              if (id !== keep) active.delete(id);
            }
          }),
      }),
    }),
    $client: {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          const snapshot = new Set(active);
          return Effect.scoped(
            effect.pipe(
              Effect.tap(() => options.commit ?? Effect.void),
              Effect.onError(() =>
                Effect.sync(() => {
                  active = snapshot;
                }),
              ),
            ),
          );
        }),
    },
  } as unknown as RelayDb.RelayDb["Service"];
  return { db, active: () => [...active] };
};

const credentialIdOf = (token: string) => token.split("_")[1];

describe("EnvironmentCredentials", () => {
  it.effect(
    "reports the credential creation persistence stage and rolls back the new credential",
    () => {
      const cause = new Error("database unavailable");
      const store = makeCredentialStore({
        beforeRevoke: Effect.suspend(() =>
          store.active().length > 1 ? Effect.fail(cause) : Effect.void,
        ),
      });

      return Effect.gen(function* () {
        const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
        const input = {
          environmentId: "env_test",
          environmentPublicKey: "sensitive-public-key-material",
        };
        const previous = yield* credentials.create(input);
        const error = yield* Effect.flip(credentials.create(input));

        expect(error).toMatchObject({
          _tag: "EnvironmentCredentialCreatePersistenceError",
          stage: "revoke-previous-credentials",
          environmentId: "env_test",
        });
        expect(error.credentialId).toMatch(/^[0-9a-f]{64}$/);
        expect(error.cause).toBe(cause);
        expect(error).not.toHaveProperty("environmentPublicKey");
        expect(store.active()).toEqual([credentialIdOf(previous)]);
      }).pipe(Effect.provide(layerWithDb(store.db)));
    },
  );

  it.effect("reports a failed commit as a credential persistence error", () => {
    const commitFailure = new SqlError.SqlError({
      reason: new SqlError.ConnectionError({ cause: new Error("connection reset") }),
    });
    const store = makeCredentialStore({ commit: Effect.fail(commitFailure) });

    return Effect.gen(function* () {
      const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
      const error = yield* credentials
        .create({ environmentId: "env_test", environmentPublicKey: "public-key" })
        .pipe(Effect.match({ onFailure: (cause) => cause, onSuccess: () => undefined }));

      expect(error).toMatchObject({
        _tag: "EnvironmentCredentialCreatePersistenceError",
        stage: "transaction",
        environmentId: "env_test",
      });
      expect(error?.cause).toBe(commitFailure);
    }).pipe(Effect.provide(layerWithDb(store.db)));
  });

  it.effect("keeps the newest credential valid when links rotate concurrently", () => {
    const firstAwaitingRevoke = Deferred.makeUnsafe<void>();
    const secondSettledOrWaiting = Deferred.makeUnsafe<void>();
    const store = makeCredentialStore({
      // The first insert must precede the second rotation, but its revoke must wait.
      beforeRevoke: Effect.gen(function* () {
        if (yield* Deferred.succeed(firstAwaitingRevoke, undefined)) {
          yield* Deferred.await(secondSettledOrWaiting);
        }
      }),
      onLockWait: Deferred.succeed(secondSettledOrWaiting, undefined).pipe(Effect.asVoid),
    });

    return Effect.gen(function* () {
      const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
      const input = { environmentId: "env_test", environmentPublicKey: "environment-public-key" };
      const first = yield* Effect.forkChild(credentials.create(input));
      yield* Deferred.await(firstAwaitingRevoke);
      const second = yield* credentials
        .create(input)
        .pipe(
          Effect.ensuring(Deferred.succeed(secondSettledOrWaiting, undefined)),
          Effect.forkChild,
        );
      yield* Fiber.join(first);
      const secondToken = yield* Fiber.join(second);

      expect(store.active()).toEqual([credentialIdOf(secondToken)]);
    }).pipe(Effect.provide(layerWithDb(store.db)));
  });

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
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
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
        execute: () => Effect.void,
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
        $client: { withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect },
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
      }).pipe(Effect.provide(layerWithDb(fakeDb)));
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
                  returning: (selection: unknown) => {
                    expect(selection).toBeDefined();
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
    }).pipe(Effect.provide(layerWithDb(fakeDb)));
  });
});
