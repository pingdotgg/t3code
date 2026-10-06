import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

// Health Check as a Service is allowlisted; without it insert fails with
// `BadRequest: Invalid resource usage: 'HealthCheck as a Service feature is
// not available for this project.'`. Set GCP_TEST_HCAAS=1 on an allowlisted
// project.
const runLifecycle = !!process.env.GCP_TEST_HCAAS && !process.env.FAST;

const region = "us-central1";

const waitUntilGone = (
  project: string,
  regionName: string,
  healthCheckService: string,
) =>
  compute
    .getRegionHealthCheckServices({
      project,
      region: regionName,
      healthCheckService,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "insertRegionHealthCheckServices without the feature fails with HealthCheckServiceNotAvailable",
  () =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        compute.insertRegionHealthCheckServices({
          project,
          region,
          body: {
            name: "alchemy-hcss-probe",
            description: "alchemy entitlement probe",
            healthChecks: [
              `projects/${project}/regions/${region}/healthChecks/does-not-exist`,
            ],
          },
        }),
      );
      expect(error._tag).toEqual("HealthCheckServiceNotAvailable");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a region health check service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const check = yield* GCP.Compute.RegionHealthCheck("Api", {
            region,
            httpHealthCheck: {
              port: 80,
              portSpecification: "USE_FIXED_PORT",
              requestPath: "/health",
            },
          });
          return yield* GCP.Compute.RegionHealthCheckService("Hcss", {
            region,
            healthChecks: [check.selfLink.as<string>()],
            description: "endpoint health",
          });
        }),
      );

      expect(created.serviceName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.description).toEqual("endpoint health");
      expect(created.healthChecks.length).toBeGreaterThan(0);
      expect(created.healthStatusAggregationPolicy).toEqual("NO_AGGREGATION");

      const fetched = yield* compute.getRegionHealthCheckServices({
        project: created.project,
        region,
        healthCheckService: created.serviceName,
      });
      expect(fetched.name).toEqual(created.serviceName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("endpoint health");
      expect(fetched.healthChecks?.length).toBeGreaterThan(0);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const check = yield* GCP.Compute.RegionHealthCheck("Api", {
            region,
            httpHealthCheck: {
              port: 80,
              portSpecification: "USE_FIXED_PORT",
              requestPath: "/health",
            },
          });
          return yield* GCP.Compute.RegionHealthCheckService("Hcss", {
            serviceName: created.serviceName,
            region,
            healthChecks: [check.selfLink.as<string>()],
            description: "updated health",
          });
        }),
      );

      expect(updated.serviceName).toEqual(created.serviceName);
      expect(updated.description).toEqual("updated health");

      const refetched = yield* compute.getRegionHealthCheckServices({
        project: updated.project,
        region,
        healthCheckService: updated.serviceName,
      });
      expect(refetched.description).toContain("updated health");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        region,
        created.serviceName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
