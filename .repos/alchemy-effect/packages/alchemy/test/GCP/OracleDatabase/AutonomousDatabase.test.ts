import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
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

// Oracle Database@Google Cloud is not enabled in the test project
// (ServiceDisabled) and needs an Oracle Cloud subscription. Set
// GCP_TEST_ORACLE=1 in a project that has one.
const runLifecycle = !!process.env.GCP_TEST_ORACLE && !process.env.FAST;

const waitUntilGone = (name: string) =>
  oracle.getProjectsLocationsAutonomousDatabases({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "getProjectsLocationsAutonomousDatabases without Oracle Database enabled fails with ServiceDisabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        oracle.getProjectsLocationsAutonomousDatabases({
          name: `projects/${project}/locations/us-central1/autonomousDatabases/alchemy-oracle-missing`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:oracledatabase", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an autonomous database",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OracleDatabase.AutonomousDatabase("AppDb", {
            location: "us-central1",
            network: "default",
            cidr: "10.10.0.0/24",
            adminPassword: "AlchemyTest1!",
            displayName: "alchemy-test-adb",
            labels: { env: "test" },
            licenseType: "LICENSE_INCLUDED",
            dbWorkload: "OLTP",
            cpuCoreCount: 2,
            dataStorageSizeGb: 20,
          });
        }),
      );

      expect(created.name).toContain("/autonomousDatabases/");
      expect(created.autonomousDatabaseId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* oracle.getProjectsLocationsAutonomousDatabases({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OracleDatabase.AutonomousDatabase("AppDb", {
            autonomousDatabaseId: created.autonomousDatabaseId,
            location: "us-central1",
            network: "default",
            cidr: "10.10.0.0/24",
            licenseType: "LICENSE_INCLUDED",
            dbWorkload: "OLTP",
            cpuCoreCount: 2,
            dataStorageSizeGb: 20,
            labels: { env: "prod", role: "db" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "db" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:oracledatabase", "live"],
    timeout: 120_000,
  },
);
