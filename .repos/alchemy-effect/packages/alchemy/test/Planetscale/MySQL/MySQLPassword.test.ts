import * as Planetscale from "@/Planetscale";
import * as Provider from "@/Provider";
import * as RemovalPolicy from "@/RemovalPolicy.ts";
import * as Test from "@/Test/Alchemy";
import * as ops from "@distilled.cloud/planetscale/Operations";
import { describe, expect } from "alchemy-test";
import { Data, Schedule } from "effect";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: Planetscale.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

describe
  .skipIf(!process.env.PLANETSCALE_TEST)
  .concurrent("MySQLPassword", () => {
    // Read-only: PARENT FAN-OUT enumeration (org -> databases -> branches ->
    // passwords) against the live org, without provisioning anything.
    test.provider("list enumerates passwords (read-only)", () =>
      Effect.gen(function* () {
        const provider = yield* Provider.findProvider(
          Planetscale.MySQLPassword,
        );
        const all = yield* provider.list();

        expect(Array.isArray(all)).toBe(true);
        for (const p of all) {
          expect(p).toMatchObject({
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
      "list finds a freshly deployed password",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database, password } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.MySQLDatabase("ListDb", {
                name: "alchemy-mysql-pw-list",
                clusterSize: "PS_10",
              });
              const password = yield* Planetscale.MySQLPassword(
                "ListPassword",
                {
                  database,
                  role: "reader",
                },
              );
              return { database, password };
            }),
          );

          const provider = yield* Provider.findProvider(
            Planetscale.MySQLPassword,
          );
          const all = yield* provider.list();

          expect(
            all.some(
              (p) =>
                p.organization === database.organization &&
                p.database === database.name &&
                p.id === password.id,
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
      "create, update, and delete password",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database, branch, password } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.MySQLDatabase("Database", {
                clusterSize: "PS_10",
              });

              const branch = yield* Planetscale.MySQLBranch("Branch", {
                database,
                parentBranch: "main",
                isProduction: false,
              });

              const password = yield* Planetscale.MySQLPassword("Password", {
                database,
                branch,
                role: "reader",
              });

              return { database, branch, password };
            }),
          );

          expect(password).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            role: "reader",
            host: expect.any(String),
            username: expect.any(String),
            organization: expect.any(String),
            database: database.name,
            branch: branch.name,
          });

          // Verify password was created by querying the API directly
          const fetched = yield* ops.getPassword({
            organization: database.organization,
            database: database.name,
            branch: branch.name,
            id: password.id,
          });

          expect(fetched.id).toEqual(password.id);
          expect(fetched.name).toEqual(password.name);
          expect(fetched.role).toEqual("reader");

          // Update the password (only name and cidrs should trigger update, not replace)
          const { updatedPassword } = yield* stack.deploy(
            Effect.gen(function* () {
              const sameDatabase = yield* Planetscale.MySQLDatabase(
                "Database",
                {
                  clusterSize: "PS_10",
                },
              );

              const sameBranch = yield* Planetscale.MySQLBranch("Branch", {
                database: sameDatabase,
                parentBranch: "main",
                isProduction: false,
              });

              const updatedPassword = yield* Planetscale.MySQLPassword(
                "Password",
                {
                  name: "test-updated-password-name",
                  database: sameDatabase.name,
                  branch: sameBranch.name,
                  role: "reader",
                },
              );

              return { updatedPassword };
            }),
          );

          expect(updatedPassword.id).toEqual(password.id);
          expect(updatedPassword.name).not.toEqual(password.name);

          // Verify password was updated
          const fetchedUpdated = yield* ops.getPassword({
            organization: database.organization,
            database: database.name,
            branch: branch.name,
            id: updatedPassword.id,
          });

          expect(fetchedUpdated.id).toEqual(password.id);
          expect(fetchedUpdated.name).toEqual(updatedPassword.name);

          yield* stack.destroy();

          yield* waitForDatabaseToBeDeleted(
            database.name,
            database.organization,
          );
        }).pipe(logLevel),
      5_000_000,
    );

    test.provider(
      "password gets replaced when properties other than name and cidrs change",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const { database, branch, password } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.MySQLDatabase("Database", {
                clusterSize: "PS_10",
              });

              const branch = yield* Planetscale.MySQLBranch("Branch", {
                database,
                parentBranch: "main",
                isProduction: false,
              });

              const password = yield* Planetscale.MySQLPassword("Password", {
                database,
                branch,
                role: "reader",
                ttl: 3600,
                cidrs: ["0.0.0.0/0"],
              });
              return { database, branch, password };
            }),
          );

          const originalId = password.id;
          expect(password.role).toEqual("reader");
          expect(password.ttl).toEqual(3600);

          // Change role from reader -> writer (should trigger replace).
          const { replacedPassword } = yield* stack.deploy(
            Effect.gen(function* () {
              const database = yield* Planetscale.MySQLDatabase("Database", {
                clusterSize: "PS_10",
              });

              const branch = yield* Planetscale.MySQLBranch("Branch", {
                database,
                parentBranch: "main",
                isProduction: false,
              });

              const replacedPassword = yield* Planetscale.MySQLPassword(
                "Password",
                {
                  database,
                  branch,
                  role: "writer",
                  ttl: 3600,
                  cidrs: ["0.0.0.0/0"],
                },
              );
              return { replacedPassword };
            }),
          );

          // New ID due to replacement.
          expect(replacedPassword.id).not.toEqual(originalId);
          expect(replacedPassword.role).toEqual("writer");

          // Old password should have been deleted as part of the replace.
          const oldExit = yield* ops
            .getPassword({
              organization: database.organization,
              database: database.name,
              branch: branch.name,
              id: originalId,
            })
            .pipe(Effect.exit);
          expect(Exit.isFailure(oldExit)).toBe(true);
          if (Exit.isFailure(oldExit)) {
            expect(Cause.pretty(oldExit.cause)).toContain("NotFound");
          }

          // New password exists with the new role.
          const newFetched = yield* ops.getPassword({
            organization: database.organization,
            database: database.name,
            branch: branch.name,
            id: replacedPassword.id,
          });
          expect(newFetched.id).toEqual(replacedPassword.id);
          expect(newFetched.role).toEqual("writer");

          yield* stack.destroy();
          yield* waitForDatabaseToBeDeleted(
            database.name,
            database.organization,
          );
        }).pipe(logLevel),
      5_000_000,
    );

    test.provider(
      "password with RemovalPolicy.retain(true) should not be deleted via API",
      (stack) =>
        Effect.gen(function* () {
          const dbName = `alchemy-test-pwd-retain`;
          const passwordName = `retain-password`;

          yield* stack.destroy();

          const { database, password } = yield* stack.deploy(
            Effect.gen(function* () {
              // Retain the database too — otherwise deleting it would cascade
              // to the password and we couldn't observe the retain behavior.
              const database = yield* Planetscale.MySQLDatabase("Database", {
                name: dbName,
                clusterSize: "PS_10",
              }).pipe(RemovalPolicy.retain(true));
              const password = yield* Planetscale.MySQLPassword("Password", {
                name: passwordName,
                database,
                role: "reader",
              }).pipe(RemovalPolicy.retain(true));
              return { database, password };
            }),
          );

          // Password exists post-deploy.
          const fetched = yield* ops.getPassword({
            organization: database.organization,
            database: database.name,
            branch: "main",
            id: password.id,
          });
          expect(fetched.id).toEqual(password.id);

          // Destroy the stack — both retained, so neither should be removed.
          yield* stack.destroy();

          const { organization } = yield* yield* Planetscale.Credentials;

          // Database should still exist and be ready.
          const liveDb = yield* Planetscale.waitForDatabaseReady(
            organization,
            dbName,
          );
          expect(liveDb.name).toEqual(dbName);

          // Password should still exist (was not deleted via API).
          const stillExists = yield* ops.getPassword({
            organization,
            database: dbName,
            branch: "main",
            id: password.id,
          });
          expect(stillExists.id).toEqual(password.id);
          expect(stillExists.name).toEqual(password.name);

          // Manual cleanup for the test.
          yield* ops
            .deletePassword({
              organization,
              database: dbName,
              branch: "main",
              id: password.id,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));

          yield* ops
            .deleteDatabase({
              organization,
              database: dbName,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));

          yield* waitForDatabaseToBeDeleted(dbName, organization);
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
