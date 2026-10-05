import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "getProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations on a missing workstation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        workstations.getProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations(
          {
            name: `projects/${project}/locations/us-central1/workstationClusters/alchemy-missing-cluster/workstationConfigs/alchemy-missing-config/workstations/alchemy-missing-station`,
          },
        ),
      );
      expect(error._tag).toEqual("NotFound");

      const page =
        yield* workstations.listProjectsLocationsWorkstationClustersWorkstationConfigsWorkstations(
          {
            parent: `projects/${project}/locations/-/workstationClusters/-/workstationConfigs/-`,
            pageSize: 10,
          },
        );
      expect(
        (page.workstations ?? []).filter((item) =>
          (item.name ?? "").includes("alchemy-missing"),
        ),
      ).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workstations", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create against a missing config is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Workstations.WorkstationClustersWorkstationConfigsWorkstation(
              "Mine",
              {
                workstationConfig: `projects/${project}/locations/us-central1/workstationClusters/alchemy-missing-cluster/workstationConfigs/alchemy-missing-config`,
                displayName: "alchemy-test-station",
                labels: { env: "test" },
              },
            );
          }),
        ),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workstations", "live"],
    timeout: 90_000,
  },
);
