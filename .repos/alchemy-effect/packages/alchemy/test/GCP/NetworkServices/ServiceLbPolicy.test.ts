import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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
  networkservices.getProjectsLocationsServiceLbPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsServiceLbPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsServiceLbPolicies({
          name: `projects/${project}/locations/global/serviceLbPolicies/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a service lb policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.ServiceLbPolicy("Spread", {
            location: "global",
            description: "lb policy a",
            labels: { env: "test" },
            loadBalancingAlgorithm: "SPRAY_TO_REGION",
            autoCapacityDrain: { enable: true },
          });
        }),
      );

      expect(created.name).toContain("/serviceLbPolicies/");
      expect(created.serviceLbPolicyId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.description).toEqual("lb policy a");
      expect(created.loadBalancingAlgorithm).toEqual("SPRAY_TO_REGION");
      expect(created.autoCapacityDrain?.enable).toEqual(true);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkservices.getProjectsLocationsServiceLbPolicies({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("lb policy a");
      expect(fetched.loadBalancingAlgorithm).toEqual("SPRAY_TO_REGION");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkServices.ServiceLbPolicy("Spread", {
            serviceLbPolicyId: created.serviceLbPolicyId,
            location: "global",
            description: "lb policy b",
            labels: { env: "prod", role: "lb" },
            loadBalancingAlgorithm: "WATERFALL_BY_REGION",
            autoCapacityDrain: { enable: false },
            failoverConfig: { failoverHealthThreshold: 70 },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("lb policy b");
      expect(updated.loadBalancingAlgorithm).toEqual("WATERFALL_BY_REGION");
      expect(updated.failoverConfig?.failoverHealthThreshold).toEqual(70);
      expect(updated.labels).toMatchObject({ env: "prod", role: "lb" });

      const refetched =
        yield* networkservices.getProjectsLocationsServiceLbPolicies({
          name: created.name,
        });
      expect(refetched.description).toEqual("lb policy b");
      expect(refetched.loadBalancingAlgorithm).toEqual("WATERFALL_BY_REGION");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("lb");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);
