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

const region = "us-central1";

const waitUntilGone = (notificationEndpoint: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getRegionNotificationEndpoints({
          project,
          region,
          notificationEndpoint,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (status) => status === "gone",
            times: 10,
          }),
        ),
    ),
  );

test.provider(
  "getRegionNotificationEndpoints on a missing endpoint fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getRegionNotificationEndpoints({
          project,
          region,
          notificationEndpoint: "alchemy-missing-ne",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

// Health Check as a Service is allowlisted; without it insert fails with
// `BadRequest: Invalid resource usage: 'HealthCheck as a Service feature is
// not available for this project.'`. Set GCP_TEST_HCAAS=1 on an allowlisted
// project.
test.provider.skipIf(!!process.env.FAST || !process.env.GCP_TEST_HCAAS)(
  "create, replace, and delete a regional notification endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionNotificationEndpoint("Health", {
            region,
            description: "regional health callbacks",
            grpcSettings: {
              endpoint: "health.example.com:443",
              retryDurationSec: 30,
            },
          });
        }),
      );

      expect(created.notificationEndpointName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.description).toEqual("regional health callbacks");
      expect(created.grpcEndpoint).toEqual("health.example.com:443");
      expect(created.retryDurationSec).toEqual(30);

      const fetched = yield* compute.getRegionNotificationEndpoints({
        project: created.project,
        region,
        notificationEndpoint: created.notificationEndpointName,
      });
      expect(fetched.name).toEqual(created.notificationEndpointName);
      expect(fetched.grpcSettings?.endpoint).toEqual("health.example.com:443");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("regional health callbacks");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionNotificationEndpoint("Health", {
            notificationEndpointName: created.notificationEndpointName,
            region,
            description: "updated health callbacks",
            grpcSettings: {
              endpoint: "health.example.com:443",
              retryDurationSec: 60,
            },
          });
        }),
      );

      expect(updated.notificationEndpointName).toEqual(
        created.notificationEndpointName,
      );
      expect(updated.description).toEqual("updated health callbacks");
      expect(updated.retryDurationSec).toEqual(60);

      const refetched = yield* compute.getRegionNotificationEndpoints({
        project: updated.project,
        region,
        notificationEndpoint: updated.notificationEndpointName,
      });
      expect(refetched.description).toContain("updated health callbacks");
      expect(refetched.grpcSettings?.retryDurationSec).toEqual(60);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.notificationEndpointName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
