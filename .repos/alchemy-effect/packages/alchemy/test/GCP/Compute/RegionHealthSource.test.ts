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

const waitUntilGone = (healthSource: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getRegionHealthSources({
          project,
          region,
          healthSource,
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

const resourceTail = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

test.provider(
  "getRegionHealthSources on a missing source fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getRegionHealthSources({
          project,
          region,
          healthSource: "alchemy-missing-hs",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a regional health source",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Compute.RegionHealthAggregationPolicy(
            "Agg",
            {
              region,
              description: "backend rollup",
            },
          );
          const backend = yield* GCP.Compute.RegionBackendService("Web", {
            region,
            protocol: "TCP",
            loadBalancingScheme: "INTERNAL_MANAGED",
            description: "health source backend",
          });
          const source = yield* GCP.Compute.RegionHealthSource("Src", {
            region,
            sources: [backend.selfLink.as<string>()],
            healthAggregationPolicy: policy.selfLink.as<string>(),
            description: "internal backends",
          });
          return { policy, backend, source };
        }),
      );

      expect(created.source.sourceName).toEqual(expect.any(String));
      expect(created.source.region).toEqual(region);
      expect(created.source.sourceType).toEqual("BACKEND_SERVICE");
      expect(created.source.description).toEqual("internal backends");
      expect(created.source.sources.length).toBeGreaterThan(0);

      const fetched = yield* compute.getRegionHealthSources({
        project: created.source.project,
        region,
        healthSource: created.source.sourceName,
      });
      expect(fetched.name).toEqual(created.source.sourceName);
      expect(fetched.sourceType).toEqual("BACKEND_SERVICE");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("internal backends");
      expect(resourceTail(fetched.healthAggregationPolicy)).toEqual(
        created.policy.policyName,
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.Compute.RegionHealthAggregationPolicy(
            "Agg",
            {
              policyName: created.policy.policyName,
              region,
              description: "backend rollup",
            },
          );
          const backend = yield* GCP.Compute.RegionBackendService("Web", {
            name: created.backend.name,
            region,
            protocol: "TCP",
            loadBalancingScheme: "INTERNAL_MANAGED",
            description: "health source backend",
          });
          return yield* GCP.Compute.RegionHealthSource("Src", {
            sourceName: created.source.sourceName,
            region,
            sources: [backend.selfLink.as<string>()],
            healthAggregationPolicy: policy.selfLink.as<string>(),
            description: "updated backends",
          });
        }),
      );

      expect(updated.sourceName).toEqual(created.source.sourceName);
      expect(updated.description).toEqual("updated backends");

      const refetched = yield* compute.getRegionHealthSources({
        project: updated.project,
        region,
        healthSource: updated.sourceName,
      });
      expect(refetched.description).toContain("updated backends");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.source.sourceName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
