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
  spanner.getProjectsInstanceConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstanceConfigs on a missing config fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const missing = yield* Effect.flip(
        spanner.getProjectsInstanceConfigs({
          name: `projects/${project}/instanceConfigs/custom-alchemy-missing`,
        }),
      );
      expect(missing._tag).toBe("NotFound");

      const base = yield* spanner.getProjectsInstanceConfigs({
        name: `projects/${project}/instanceConfigs/regional-us-central1`,
      });
      expect(base.name).toContain("regional-us-central1");
      expect((base.replicas ?? []).length).toBeGreaterThan(0);

      const page = yield* spanner.listProjectsInstanceConfigs({
        parent: `projects/${project}`,
        pageSize: 10,
      });
      expect(
        (page.instanceConfigs ?? []).map((item) => item.name?.split("/").pop()),
      ).not.toContain("custom-alchemy-missing");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a user-managed instance config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Spanner.InstanceConfig("Custom", {
            baseConfig: "regional-us-central1",
            displayName: "alchemy-test-cfg",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/instanceConfigs/");
      expect(created.instanceConfigId.startsWith("custom-")).toEqual(true);
      expect(created.baseConfig).toContain("regional-us-central1");
      expect(created.configType).toEqual("USER_MANAGED");
      expect(created.displayName).toEqual("alchemy-test-cfg");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("READY");
      expect(created.replicas.length).toBeGreaterThan(0);

      const fetched = yield* spanner.getProjectsInstanceConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("alchemy-test-cfg");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Spanner.InstanceConfig("Custom", {
            instanceConfigId: created.instanceConfigId,
            baseConfig: "regional-us-central1",
            displayName: "alchemy-prod-cfg",
            labels: { env: "prod", role: "cfg" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-prod-cfg");
      expect(updated.labels).toMatchObject({ env: "prod", role: "cfg" });

      const refetched = yield* spanner.getProjectsInstanceConfigs({
        name: created.name,
      });
      expect(refetched.displayName).toEqual("alchemy-prod-cfg");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("cfg");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:spanner", "live"], timeout: 180_000 },
);
