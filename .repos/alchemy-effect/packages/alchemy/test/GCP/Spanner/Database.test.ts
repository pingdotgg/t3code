import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  spanner.getProjectsInstancesDatabases({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesDatabases on a missing database fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        spanner.getProjectsInstancesDatabases({
          name: `projects/${project}/instances/alchemy-spanner-missing/databases/alchemy-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      const page = yield* spanner.listProjectsInstances({
        parent: `projects/${project}`,
        pageSize: 10,
      });
      expect(
        (page.instances ?? []).map((item) => item.name?.split("/").pop()),
      ).not.toContain("alchemy-spanner-missing");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, query, and delete a spanner database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("App", {
            config: "regional-us-central1",
            processingUnits: 100,
            displayName: "alchemy-db-spnr",
            defaultBackupScheduleType: "NONE",
          });
          const database = yield* GCP.Spanner.Database("AppDb", {
            instance: instance.instanceId,
            extraStatements: [
              "CREATE TABLE Users (UserId INT64 NOT NULL) PRIMARY KEY (UserId)",
            ],
          });
          return { instance, database };
        }),
      );

      expect(created.database.name).toContain("/databases/");
      expect(created.database.databaseId).toEqual(expect.any(String));
      expect(created.database.instanceId).toEqual(created.instance.instanceId);
      expect(created.database.enableDropProtection).toEqual(false);
      expect(created.database.state).toEqual("READY");

      const fetched = yield* spanner.getProjectsInstancesDatabases({
        name: created.database.name,
      });
      expect(fetched.name).toEqual(created.database.name);
      expect(fetched.enableDropProtection === true).toEqual(false);

      const ddl = yield* spanner.getDdlProjectsInstancesDatabases({
        database: created.database.name,
      });
      expect(
        ddl.statements?.some((statement) => statement.includes("Users")),
      ).toEqual(true);

      const session = yield* spanner.createProjectsInstancesDatabasesSessions({
        database: created.database.name,
        body: { session: {} },
      });
      const result = yield* spanner
        .executeSqlProjectsInstancesDatabasesSessions({
          session: session.name ?? "",
          body: { sql: "SELECT 1 AS n" },
        })
        .pipe(
          Effect.ensuring(
            session.name
              ? spanner
                  .deleteProjectsInstancesDatabasesSessions({
                    name: session.name,
                  })
                  .pipe(
                    Effect.catchTag("NotFound", () => Effect.void),
                    Effect.ignore,
                  )
              : Effect.void,
          ),
        );
      expect((result.rows ?? []).length).toBeGreaterThan(0);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Spanner.Instance("App", {
            instanceId: created.instance.instanceId,
            config: "regional-us-central1",
            processingUnits: 100,
            displayName: "alchemy-db-spnr",
            defaultBackupScheduleType: "NONE",
          });
          const database = yield* GCP.Spanner.Database("AppDb", {
            instance: instance.instanceId,
            databaseId: created.database.databaseId,
            extraStatements: [
              "CREATE TABLE Users (UserId INT64 NOT NULL) PRIMARY KEY (UserId)",
            ],
            enableDropProtection: true,
          });
          return { instance, database };
        }),
      );

      expect(updated.database.name).toEqual(created.database.name);
      expect(updated.database.enableDropProtection).toEqual(true);

      const refetched = yield* spanner.getProjectsInstancesDatabases({
        name: created.database.name,
      });
      expect(refetched.enableDropProtection).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.database.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 180_000 },
);
