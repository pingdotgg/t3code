import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const region = "us-central1";

const waitUntilGone = (
  project: string,
  regionName: string,
  healthAggregationPolicy: string,
) =>
  compute
    .getRegionHealthAggregationPolicies({
      project,
      region: regionName,
      healthAggregationPolicy,
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
  "create, update, and delete a region health aggregation policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionHealthAggregationPolicy("Agg", {
            region,
            description: "backend rollup",
            minHealthyThreshold: 1,
            healthyPercentThreshold: 60,
          });
        }),
      );

      expect(created.policyName).toEqual(expect.any(String));
      expect(created.region).toEqual(region);
      expect(created.policyType).toEqual("BACKEND_SERVICE_POLICY");
      expect(created.description).toEqual("backend rollup");
      expect(created.minHealthyThreshold).toEqual(1);
      expect(created.healthyPercentThreshold).toEqual(60);

      const fetched = yield* compute.getRegionHealthAggregationPolicies({
        project: created.project,
        region,
        healthAggregationPolicy: created.policyName,
      });
      expect(fetched.name).toEqual(created.policyName);
      expect(fetched.policyType).toEqual("BACKEND_SERVICE_POLICY");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("backend rollup");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionHealthAggregationPolicy("Agg", {
            policyName: created.policyName,
            region,
            description: "updated rollup",
            minHealthyThreshold: 2,
            healthyPercentThreshold: 80,
          });
        }),
      );

      expect(updated.policyName).toEqual(created.policyName);
      expect(updated.description).toEqual("updated rollup");
      expect(updated.minHealthyThreshold).toEqual(2);
      expect(updated.healthyPercentThreshold).toEqual(80);

      const refetched = yield* compute.getRegionHealthAggregationPolicies({
        project: updated.project,
        region,
        healthAggregationPolicy: updated.policyName,
      });
      expect(refetched.description).toContain("updated rollup");
      expect(refetched.minHealthyThreshold).toEqual(2);
      expect(refetched.healthyPercentThreshold).toEqual(80);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        region,
        created.policyName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
