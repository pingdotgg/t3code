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
  spanner.getProjectsInstances({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstances on a missing instance fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        spanner.getProjectsInstances({
          name: `projects/${project}/instances/alchemy-spanner-missing`,
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
  "create, update, and delete a spanner instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Spanner.Instance("App", {
            config: "regional-us-central1",
            processingUnits: 100,
            displayName: "alchemy-test-spnr",
            labels: { env: "test" },
            defaultBackupScheduleType: "NONE",
          });
        }),
      );

      expect(created.name).toContain("/instances/");
      expect(created.instanceId).toEqual(expect.any(String));
      expect(created.config).toContain("regional-us-central1");
      expect(created.processingUnits).toEqual(100);
      expect(created.displayName).toEqual("alchemy-test-spnr");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("READY");

      const fetched = yield* spanner.getProjectsInstances({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.processingUnits).toEqual(100);
      expect(fetched.displayName).toEqual("alchemy-test-spnr");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Spanner.Instance("App", {
            instanceId: created.instanceId,
            config: "regional-us-central1",
            processingUnits: 100,
            displayName: "alchemy-prod-spnr",
            labels: { env: "prod", role: "db" },
            defaultBackupScheduleType: "NONE",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-prod-spnr");
      expect(updated.labels).toMatchObject({ env: "prod", role: "db" });

      const refetched = yield* spanner.getProjectsInstances({
        name: created.name,
      });
      expect(refetched.displayName).toEqual("alchemy-prod-spnr");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("db");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 180_000 },
);
