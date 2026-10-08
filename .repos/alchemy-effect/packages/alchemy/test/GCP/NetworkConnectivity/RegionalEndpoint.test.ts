import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { DEFAULT_NETWORK, defaultNetworkSelfLink } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  networkconnectivity.getProjectsLocationsRegionalEndpoints({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsRegionalEndpoints on a missing endpoint fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkconnectivity.getProjectsLocationsRegionalEndpoints({
          name: `projects/${project}/locations/us-central1/regionalEndpoints/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a regional endpoint",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const subnet = yield* GCP.Compute.Subnetwork("RepSubnet", {
            network: DEFAULT_NETWORK,
            ipCidrRange: "172.20.11.0/24",
            privateIpGoogleAccess: true,
          });
          const endpoint = yield* GCP.NetworkConnectivity.RegionalEndpoint(
            "Storage",
            {
              targetGoogleApi: "storage.us-central1.p.rep.googleapis.com",
              accessType: "REGIONAL",
              network: defaultNetworkSelfLink(project),
              subnetwork: subnet.selfLink.as<string>(),
              description: "rep a",
              labels: { env: "test" },
            },
          );
          return { subnet, endpoint };
        }),
      );

      expect(created.endpoint.name).toContain("/regionalEndpoints/");
      expect(created.endpoint.location).toEqual("us-central1");
      expect(created.endpoint.targetGoogleApi).toEqual(
        "storage.us-central1.p.rep.googleapis.com",
      );
      expect(created.endpoint.accessType).toEqual("REGIONAL");
      expect(created.endpoint.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networkconnectivity.getProjectsLocationsRegionalEndpoints({
          name: created.endpoint.name,
        });
      expect(fetched.name).toEqual(created.endpoint.name);
      expect(fetched.targetGoogleApi).toEqual(
        "storage.us-central1.p.rep.googleapis.com",
      );
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.endpoint.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkconnectivity", "live"],
    timeout: 600_000,
  },
);
