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

const waitUntilGone = (project: string, region: string, name: string) =>
  compute
    .getRegionBackendServices({ project, region, backendService: name })
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
  "create, update, and delete a region backend service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionBackendService("Web", {
            protocol: "HTTP",
            loadBalancingScheme: "INTERNAL_MANAGED",
            description: "alchemy test",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toEqual(expect.any(String));
      expect(created.region).toEqual("us-central1");
      expect(created.protocol).toEqual("HTTP");
      expect(created.loadBalancingScheme).toEqual("INTERNAL_MANAGED");
      expect(created.timeoutSec).toEqual(30);
      expect(created.description).toEqual("alchemy test");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* compute.getRegionBackendServices({
        project: created.project,
        region: created.region,
        backendService: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.protocol).toEqual("HTTP");
      expect(fetched.loadBalancingScheme).toEqual("INTERNAL_MANAGED");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("env=test");
      expect(fetched.description).toContain("alchemy test");
      expect(fetched.timeoutSec).toEqual(30);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionBackendService("Web", {
            name: created.name,
            region: created.region,
            protocol: "HTTP",
            loadBalancingScheme: "INTERNAL_MANAGED",
            timeoutSec: 60,
            localityLbPolicy: "ROUND_ROBIN",
            description: "updated",
            labels: { env: "prod", role: "lb" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.timeoutSec).toEqual(60);
      expect(updated.localityLbPolicy).toEqual("ROUND_ROBIN");
      expect(updated.description).toEqual("updated");
      expect(updated.labels).toMatchObject({ env: "prod", role: "lb" });

      const fetchedUpdate = yield* compute.getRegionBackendServices({
        project: created.project,
        region: created.region,
        backendService: created.name,
      });
      expect(fetchedUpdate.timeoutSec).toEqual(60);
      expect(fetchedUpdate.localityLbPolicy).toEqual("ROUND_ROBIN");
      expect(fetchedUpdate.description).toContain("env=prod");
      expect(fetchedUpdate.description).toContain("role=lb");
      expect(fetchedUpdate.description).toContain("updated");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.region,
        created.name,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 120_000 },
);
