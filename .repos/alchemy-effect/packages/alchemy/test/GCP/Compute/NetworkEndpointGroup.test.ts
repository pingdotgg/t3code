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

const zone = "us-central1-a";

const waitUntilGone = (networkEndpointGroup: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getNetworkEndpointGroups({
          project,
          zone,
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
        ),
    ),
  );

test.provider(
  "create, replace, and delete a network endpoint group",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.NetworkEndpointGroup("Web", {
            zone,
            description: "zonal backends",
            network: "default",
            defaultPort: 80,
          });
        }),
      );

      expect(created.networkEndpointGroupName).toEqual(expect.any(String));
      expect(created.zone).toEqual(zone);
      expect(created.description).toEqual("zonal backends");
      expect(created.networkEndpointType).toEqual("GCE_VM_IP_PORT");
      expect(created.defaultPort).toEqual(80);
      expect(created.size).toEqual(0);

      const fetched = yield* compute.getNetworkEndpointGroups({
        project,
        zone,
        networkEndpointGroup: created.networkEndpointGroupName,
      });
      expect(fetched.name).toEqual(created.networkEndpointGroupName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("zonal backends");
      expect(fetched.networkEndpointType).toEqual("GCE_VM_IP_PORT");
      expect(fetched.defaultPort).toEqual(80);
      expect(fetched.network).toContain("default");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.NetworkEndpointGroup("Web", {
            networkEndpointGroupName: created.networkEndpointGroupName,
            zone,
            description: "replaced backends",
            network: "default",
            defaultPort: 8080,
          });
        }),
      );

      expect(replaced.networkEndpointGroupName).toEqual(
        created.networkEndpointGroupName,
      );
      expect(replaced.description).toEqual("replaced backends");
      expect(replaced.defaultPort).toEqual(8080);
      expect(replaced.id).not.toEqual(created.id);

      const replacedFetched = yield* compute.getNetworkEndpointGroups({
        project,
        zone,
        networkEndpointGroup: replaced.networkEndpointGroupName,
      });
      expect(replacedFetched.description).toContain("replaced backends");
      expect(replacedFetched.defaultPort).toEqual(8080);
      expect(replacedFetched.id).toEqual(replaced.id);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.networkEndpointGroupName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
