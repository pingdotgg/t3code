import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (
  project: string,
  region: string,
  subnetworkName: string,
) =>
  compute.getSubnetworks({ project, region, subnetwork: subnetworkName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a subnetwork",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
          });
          const subnetwork = yield* GCP.Compute.Subnetwork("Subnet", {
            network: network.networkName,
            region: "us-central1",
            ipCidrRange: "10.20.0.0/24",
            description: "test subnet",
          });
          return { network, subnetwork };
        }),
      );

      expect(created.subnetwork.subnetworkName).toEqual(expect.any(String));
      expect(created.subnetwork.region).toEqual("us-central1");
      expect(created.subnetwork.ipCidrRange).toEqual("10.20.0.0/24");
      expect(created.subnetwork.privateIpGoogleAccess).toEqual(false);
      expect(created.subnetwork.description).toEqual("test subnet");
      expect(created.subnetwork.secondaryIpRanges).toEqual([]);

      const fetched = yield* compute.getSubnetworks({
        project: created.subnetwork.project,
        region: created.subnetwork.region,
        subnetwork: created.subnetwork.subnetworkName,
      });
      expect(fetched.name).toEqual(created.subnetwork.subnetworkName);
      expect(fetched.ipCidrRange).toEqual("10.20.0.0/24");
      expect(fetched.privateIpGoogleAccess).toEqual(false);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("test subnet");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("Vpc", {
            networkName: created.network.networkName,
            autoCreateSubnetworks: false,
          });
          const subnetwork = yield* GCP.Compute.Subnetwork("Subnet", {
            subnetworkName: created.subnetwork.subnetworkName,
            network: network.networkName,
            region: "us-central1",
            ipCidrRange: "10.20.0.0/24",
            description: "test subnet",
            privateIpGoogleAccess: true,
            secondaryIpRanges: [
              { rangeName: "pods", ipCidrRange: "10.20.1.0/24" },
            ],
          });
          return { network, subnetwork };
        }),
      );

      expect(updated.subnetwork.subnetworkName).toEqual(
        created.subnetwork.subnetworkName,
      );
      expect(updated.subnetwork.privateIpGoogleAccess).toEqual(true);
      expect(updated.subnetwork.secondaryIpRanges).toEqual([
        { rangeName: "pods", ipCidrRange: "10.20.1.0/24" },
      ]);

      const fetchedUpdate = yield* compute.getSubnetworks({
        project: created.subnetwork.project,
        region: created.subnetwork.region,
        subnetwork: created.subnetwork.subnetworkName,
      });
      expect(fetchedUpdate.privateIpGoogleAccess).toEqual(true);
      expect(
        (fetchedUpdate.secondaryIpRanges ?? []).map((range) => ({
          rangeName: range.rangeName,
          ipCidrRange: range.ipCidrRange,
        })),
      ).toEqual([{ rangeName: "pods", ipCidrRange: "10.20.1.0/24" }]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.subnetwork.project,
        created.subnetwork.region,
        created.subnetwork.subnetworkName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 360_000 },
);
