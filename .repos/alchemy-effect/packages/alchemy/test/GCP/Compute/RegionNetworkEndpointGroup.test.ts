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
  networkEndpointGroup: string,
) =>
  compute
    .getRegionNetworkEndpointGroups({
      project,
      region,
      networkEndpointGroup,
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
  "create, replace, and delete a regional network endpoint group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionNetworkEndpointGroup("Neg", {
            region: "us-central1",
            networkEndpointType: "SERVERLESS",
            cloudRun: { urlMask: "<service>" },
            description: "serverless neg",
          });
        }),
      );

      expect(created.networkEndpointGroupName).toEqual(expect.any(String));
      expect(created.region).toEqual("us-central1");
      expect(created.networkEndpointType).toEqual("SERVERLESS");
      expect(created.description).toEqual("serverless neg");
      expect(created.cloudRun?.urlMask).toEqual("<service>");

      const fetched = yield* compute.getRegionNetworkEndpointGroups({
        project: created.project,
        region: created.region,
        networkEndpointGroup: created.networkEndpointGroupName,
      });
      expect(fetched.name).toEqual(created.networkEndpointGroupName);
      expect(fetched.networkEndpointType).toEqual("SERVERLESS");
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("serverless neg");
      expect(fetched.cloudRun?.urlMask).toEqual("<service>");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RegionNetworkEndpointGroup("Neg", {
            networkEndpointGroupName: created.networkEndpointGroupName,
            region: "us-central1",
            networkEndpointType: "SERVERLESS",
            cloudRun: { urlMask: "<service>" },
            description: "run backends",
          });
        }),
      );

      expect(replaced.networkEndpointGroupName).toEqual(
        created.networkEndpointGroupName,
      );
      expect(replaced.networkEndpointType).toEqual("SERVERLESS");
      expect(replaced.description).toEqual("run backends");
      expect(replaced.cloudRun?.urlMask).toEqual("<service>");

      const fetchedReplaced = yield* compute.getRegionNetworkEndpointGroups({
        project: replaced.project,
        region: replaced.region,
        networkEndpointGroup: replaced.networkEndpointGroupName,
      });
      expect(fetchedReplaced.description).toContain("[alchemy ");
      expect(fetchedReplaced.description).toContain("run backends");
      expect(fetchedReplaced.cloudRun?.urlMask).toEqual("<service>");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.region,
        created.networkEndpointGroupName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
