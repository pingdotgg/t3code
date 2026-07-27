import * as Planetscale from "@/Planetscale";
import * as Provider from "@/Provider";
import * as RemovalPolicy from "@/RemovalPolicy.ts";
import * as Test from "@/Test/Alchemy";
import * as ops from "@distilled.cloud/planetscale/Operations";
import { describe, expect } from "alchemy-test";
import { Redacted } from "effect";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Planetscale.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
describe
  .skipIf(!process.env.PLANETSCALE_TEST)
  .concurrent("PostgresRole", () => {
    // Read-only: PARENT FAN-OUT enumeration (org -> databases -> branches ->
    // default role) against the live org, without provisioning anything.
    test.provider("list enumerates default roles (read-only)", () =>
      Effect.gen(function* () {
        const provider = yield* Provider.findProvider(
          Planetscale.PostgresDefaultRole,
        );
        const all = yield* provider.list();

        expect(Array.isArray(all)).toBe(true);
        for (const r of all) {
          expect(r).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            organization: expect.any(String),
            database: expect.any(String),
            branch: expect.any(String),
          });
        }
      }).pipe(logLevel),
    );

    // Deploy-and-find coverage, opt-in only (slow provisioning).
    test.provider.skipIf(!process.env.PLANETSCALE_DEPLOY_TEST)(
      "list finds a freshly deployed default role",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database, role } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("ListDb", {
                name: "alchemy-pg-default-list",
                clusterSize: "PS_10",
                arch: "arm",
              });
              const role = yield* Planetscale.PostgresDefaultRole("ListRole", {
                database,
                forceReset: true,
              });
              return { database, role };
            }),
          );

          const provider = yield* Provider.findProvider(
            Planetscale.PostgresDefaultRole,
          );
          const all = yield* provider.list();

          expect(
            all.some(
              (r) =>
                r.organization === database.organization &&
                r.database === database.name &&
                r.branch === role.branch,
            ),
          ).toBe(true);

          yield* stack.destroy();
          yield* waitForDatabaseToBeDeleted(
            database.name,
            database.organization,
          );
        }).pipe(logLevel),
      5_000_000,
    );

    // Read-only: PARENT FAN-OUT enumeration (org -> databases -> branches ->
    // roles, excluding the default role) against the live org, without
    // provisioning anything.
    test.provider("list enumerates roles (read-only)", () =>
      Effect.gen(function* () {
        const provider = yield* Provider.findProvider(Planetscale.PostgresRole);
        const all = yield* provider.list();

        expect(Array.isArray(all)).toBe(true);
        for (const r of all) {
          expect(r).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            organization: expect.any(String),
            database: expect.any(String),
            branch: expect.any(String),
          });
        }
      }).pipe(logLevel),
    );

    // Deploy-and-find coverage, opt-in only (slow provisioning).
    test.provider.skipIf(!process.env.PLANETSCALE_DEPLOY_TEST)(
      "list finds a freshly deployed role",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database, role } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("ListDb", {
                name: "alchemy-pg-role-list",
                clusterSize: "PS_10",
                arch: "arm",
              });
              const role = yield* Planetscale.PostgresRole("ListRole", {
                database,
                inheritedRoles: ["pg_read_all_data"],
              });
              return { database, role };
            }),
          );

          const provider = yield* Provider.findProvider(
            Planetscale.PostgresRole,
          );
          const all = yield* provider.list();

          expect(
            all.some(
              (r) =>
                r.organization === database.organization &&
                r.database === database.name &&
                r.id === role.id,
            ),
          ).toBe(true);

          yield* stack.destroy();
          yield* waitForDatabaseToBeDeleted(
            database.name,
            database.organization,
          );
        }).pipe(logLevel),
      5_000_000,
    );

    test.provider(
      "default role - create, duplicate fails, forceReset returns new id",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // First: create default role, expect success
          const { database, role1 } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
                arch: "arm",
              });
              const role1 = yield* Planetscale.PostgresDefaultRole("Role1", {
                database,
              });

              return { role1, database };
            }),
          );

          expect(role1).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            host: expect.any(String),
            username: expect.any(String),
            password: expect.any(Object),
            databaseName: "postgres",
            branch: "main",
            organization: database.organization,
          });

          // Second: create again without forceReset — should fail (default already exists)
          const exit = yield* stack
            .deploy(
              Effect.gen(function* () {
                const database = yield* Planetscale.PostgresDatabase(
                  "Database",
                  {
                    clusterSize: "PS_10",
                    arch: "arm",
                  },
                );
                const role2 = yield* Planetscale.PostgresDefaultRole("Role2", {
                  database,
                });

                return { role2 };
              }),
            )
            .pipe(Effect.exit);

          expect(Exit.isFailure(exit)).toBe(true);

          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toMatch(
              /Default role already exists.*Use forceReset/,
            );
          }

          // Third: create with forceReset — should succeed and return a different role id
          const { role3 } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
                arch: "arm",
              });
              const role3 = yield* Planetscale.PostgresDefaultRole("Role3", {
                database,
                forceReset: true,
              });

              return { role3, database };
            }),
          );

          expect(role3).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            host: expect.any(String),
            username: expect.any(String),
            password: expect.any(Object),
            databaseName: "postgres",
            branch: "main",
            organization: database.organization,
          });

          // the default role ID is the same, but the password is different
          expect(Redacted.value(role3.password)).not.toEqual(
            Redacted.value(role1.password),
          );

          yield* stack.destroy();
          yield* waitForDatabaseToBeDeleted(
            database.name,
            database.organization,
          );
        }).pipe(logLevel),
      5_000_000,
    );

    test.provider(
      "create and delete role",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // Create a role
          const { database, role } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
                arch: "arm",
              });
              const role = yield* Planetscale.PostgresRole("Role", {
                database,
                // Empty array means no permissions, which is fine for testing.
                inheritedRoles: [],
              });

              return { database, role };
            }),
          );

          expect(role).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            host: expect.any(String),
            username: expect.any(String),
            password: expect.any(Object),
          });

          // Update role with different ttl (should trigger replacement)
          const { updatedRole } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
                arch: "arm",
              });
              const updatedRole = yield* Planetscale.PostgresRole("Role", {
                database,
                ttl: 3600,
                inheritedRoles: [],
              });

              return { database, updatedRole };
            }),
          );

          expect(role.id).not.toEqual(updatedRole.id);
          expect(updatedRole.ttl).toEqual(3600);

          const found = yield* ops
            .getRole({
              id: role.id,
              database: database.name,
              organization: database.organization,
              branch: "main",
            })
            .pipe(
              Effect.map(() => true),
              Effect.catchTag("NotFound", () => Effect.succeed(false)),
            );

          expect(found).toBe(false);

          const updatedRoleFromApi = yield* ops.getRole({
            id: updatedRole.id,
            database: database.name,
            organization: database.organization,
            branch: "main",
          });

          expect(updatedRoleFromApi.ttl).toEqual(3600);

          yield* stack.destroy();

          yield* waitForDatabaseToBeDeleted(
            database.name,
            database.organization,
          );
        }).pipe(logLevel),
      5_000_000,
    );

    test.provider(
      "role gets replaced when properties change",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database, role1 } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
                arch: "arm",
              });
              const role1 = yield* Planetscale.PostgresRole("RoleReplace", {
                database: database,
                inheritedRoles: ["pg_read_all_data"],
                ttl: 3600,
              });

              return { database, role1 };
            }),
          );

          expect(role1).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            inheritedRoles: ["pg_read_all_data"],
          });

          const originalId = role1.id;
          const originalName = role1.name;

          const { role2 } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
                arch: "arm",
              });
              const role2 = yield* Planetscale.PostgresRole("RoleReplace", {
                database: database,
                inheritedRoles: ["postgres"],
                ttl: 7200,
              });

              return { role2 };
            }),
          );

          expect(role2).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            inheritedRoles: ["postgres"],
          });

          expect(role2.id).not.toEqual(originalId);
          expect(role2.name).not.toEqual(originalName);

          yield* stack.destroy();

          yield* waitForDatabaseToBeDeleted(
            database.name,
            database.organization,
          );
        }).pipe(logLevel),
      5_000_000,
    );

    test.provider(
      "role with RemovalPolicy.retain(true) should not be deleted via API",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { organization } = yield* yield* Planetscale.Credentials;

          const { database, role } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
                arch: "arm",
              }).pipe(RemovalPolicy.retain(true));
              const role = yield* Planetscale.PostgresRole(
                "RoleRetainRemoval",
                {
                  database,
                  inheritedRoles: ["postgres"],
                },
              ).pipe(RemovalPolicy.retain(true));

              return { database, role };
            }),
          );

          expect(role).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            database: database.name,
            inheritedRoles: ["postgres"],
          });

          yield* stack.destroy();

          const liveRole = yield* ops
            .getRole({
              organization,
              database: database.name,
              branch: "main",
              id: role.id,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

          expect(liveRole).toBeDefined();
          expect(liveRole?.id).toEqual(role.id);

          // deleting the db takes care of deleting the role
          yield* ops
            .deleteDatabase({
              organization,
              database: database.name,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));

          yield* waitForDatabaseToBeDeleted(
            database.name,
            database.organization,
          );
        }).pipe(logLevel),
      5_000_000,
    );

    test.provider(
      "role update: successor is updatable without replacement",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database, role1 } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
                arch: "arm",
              });
              const role1 = yield* Planetscale.PostgresRole("RoleSuccessor", {
                database,
                inheritedRoles: ["postgres"],
                successor: "postgres",
              });

              return { database, role1 };
            }),
          );

          expect(role1).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            successor: "postgres",
          });

          const originalId = role1.id;

          const { role2 } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
                arch: "arm",
              });
              const role2 = yield* Planetscale.PostgresRole("RoleSuccessor", {
                database,
                inheritedRoles: ["postgres"],
                successor: "pg_read_all_data",
              });

              return { role2 };
            }),
          );

          expect(role2).toMatchObject({
            id: originalId,
            successor: "pg_read_all_data",
          });

          expect(role2.id).toEqual(originalId);

          yield* stack.destroy();

          yield* waitForDatabaseToBeDeleted(
            database.name,
            database.organization,
          );
        }).pipe(logLevel),
      5_000_000,
    );

    test.provider(
      "role with custom branch",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database, branch, role } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.PostgresDatabase("Database", {
                clusterSize: "PS_10",
                arch: "arm",
              });

              const branch = yield* Planetscale.PostgresBranch("CustomBranch", {
                database,
              });

              const role = yield* Planetscale.PostgresRole("RoleCustomBranch", {
                database,
                branch,
                inheritedRoles: ["postgres"],
              });

              return { database, branch, role };
            }),
          );

          expect(role).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            database: database.name,
            branch: branch.name,
            inheritedRoles: ["postgres"],
          });

          yield* stack.destroy();

          yield* waitForDatabaseToBeDeleted(
            database.name,
            database.organization,
          );
        }).pipe(logLevel),
      5_000_000,
    );
  });
const waitForDatabaseToBeDeleted = Effect.fn(function* (
  database: string,
  organization: string,
) {
  yield* ops
    .getDatabase({
      organization,
      database,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new DatabaseStillExists())),
      Effect.retry({
        while: (e): e is DatabaseStillExists =>
          e instanceof DatabaseStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("NotFound", () => Effect.void),
    );
});

class DatabaseStillExists extends Data.TaggedError("DatabaseStillExists") {}
