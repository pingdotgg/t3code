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

const waitUntilGone = (
  project: string,
  region: string,
  targetHttpProxyName: string,
) =>
  compute
    .getRegionTargetHttpProxies({
      project,
      region,
      targetHttpProxy: targetHttpProxyName,
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

const resourceTail = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

test.provider(
  "create, update, and delete a regional target http proxy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const map = yield* GCP.Compute.RegionUrlMap("Web", {
            region: "us-central1",
            description: "https redirect",
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.com",
              stripQuery: false,
            },
          });
          return yield* GCP.Compute.RegionTargetHttpProxy("Proxy", {
            region: "us-central1",
            description: "http frontend",
            urlMap: map.urlMapName,
          });
        }),
      );

      expect(created.targetHttpProxyName).toEqual(expect.any(String));
      expect(created.region).toEqual("us-central1");
      expect(created.description).toEqual("http frontend");
      expect(resourceTail(created.urlMap).length).toBeGreaterThan(0);

      const fetched = yield* compute.getRegionTargetHttpProxies({
        project: created.project,
        region: created.region,
        targetHttpProxy: created.targetHttpProxyName,
      });
      expect(fetched.name).toEqual(created.targetHttpProxyName);
      expect(resourceTail(fetched.urlMap)).toEqual(
        resourceTail(created.urlMap),
      );
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("http frontend");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* GCP.Compute.RegionUrlMap("Web", {
            region: "us-central1",
            description: "https redirect",
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.com",
              stripQuery: false,
            },
          });
          const other = yield* GCP.Compute.RegionUrlMap("Other", {
            region: "us-central1",
            description: "alt redirect",
            defaultUrlRedirect: {
              httpsRedirect: true,
              hostRedirect: "example.org",
              stripQuery: true,
            },
          });
          return yield* GCP.Compute.RegionTargetHttpProxy("Proxy", {
            targetHttpProxyName: created.targetHttpProxyName,
            region: "us-central1",
            description: "http frontend",
            urlMap: other.urlMapName,
          });
        }),
      );

      expect(updated.targetHttpProxyName).toEqual(created.targetHttpProxyName);
      expect(updated.region).toEqual("us-central1");
      expect(resourceTail(updated.urlMap)).toEqual(expect.any(String));

      const refetched = yield* compute.getRegionTargetHttpProxies({
        project: updated.project,
        region: updated.region,
        targetHttpProxy: updated.targetHttpProxyName,
      });
      expect(resourceTail(refetched.urlMap)).toEqual(
        resourceTail(updated.urlMap),
      );
      expect(resourceTail(refetched.urlMap)).not.toEqual(
        resourceTail(created.urlMap),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.region,
        created.targetHttpProxyName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
