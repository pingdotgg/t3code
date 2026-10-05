import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as servicenetworking from "@distilled.cloud/gcp/servicenetworking_v1";
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

const parent = "services/servicenetworking.googleapis.com";

const waitUntilGone = (consumerNetwork: string) =>
  servicenetworking
    .listServicesConnections({
      parent,
      network: consumerNetwork,
    })
    .pipe(
      Effect.map((page) =>
        (page.connections ?? []).length === 0
          ? ("gone" as const)
          : ("found" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 15,
      }),
    );

test.provider(
  "listServicesConnections on a missing network returns no connections",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const resource = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      const projectNumber = resource.name?.split("/").pop() ?? project;
      const page = yield* servicenetworking.listServicesConnections({
        parent,
        network: `projects/${projectNumber}/global/networks/alchemy-sn-missing`,
      });
      expect(page.connections ?? []).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:servicenetworking", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a service networking connection",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("Vpc", {
            autoCreateSubnetworks: false,
          });
          const range = yield* GCP.Compute.GlobalAddress("PsaRange", {
            addressType: "INTERNAL",
            purpose: "VPC_PEERING",
            network: network.selfLink,
            prefixLength: 24,
          });
          const extra = yield* GCP.Compute.GlobalAddress("PsaExtra", {
            addressType: "INTERNAL",
            purpose: "VPC_PEERING",
            network: network.selfLink,
            prefixLength: 24,
          });
          const connection = yield* GCP.ServiceNetworking.Connection("Psa", {
            network: network.networkName,
            reservedPeeringRanges: [range.addressName],
          });
          return { network, range, extra, connection };
        }),
      );

      expect(created.connection.networkName).toEqual(
        created.network.networkName,
      );
      expect(created.connection.service).toEqual(parent);
      expect(created.connection.peering).toEqual(
        "servicenetworking-googleapis-com",
      );
      expect(created.connection.reservedPeeringRanges).toEqual([
        created.range.addressName,
      ]);
      expect(created.connection.project).toEqual(project);
      expect(created.connection.projectNumber).toEqual(expect.any(String));

      const listed = yield* servicenetworking.listServicesConnections({
        parent,
        network: created.connection.network,
      });
      const fetched = (listed.connections ?? []).find(
        (connection) =>
          (connection.network ?? "") === created.connection.network,
      );
      expect(fetched?.peering).toEqual(created.connection.peering);
      expect(fetched?.reservedPeeringRanges).toEqual([
        created.range.addressName,
      ]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("Vpc", {
            networkName: created.network.networkName,
            autoCreateSubnetworks: false,
          });
          const range = yield* GCP.Compute.GlobalAddress("PsaRange", {
            addressName: created.range.addressName,
            addressType: "INTERNAL",
            purpose: "VPC_PEERING",
            network: network.selfLink,
            prefixLength: 24,
          });
          const extra = yield* GCP.Compute.GlobalAddress("PsaExtra", {
            addressName: created.extra.addressName,
            addressType: "INTERNAL",
            purpose: "VPC_PEERING",
            network: network.selfLink,
            prefixLength: 24,
          });
          const connection = yield* GCP.ServiceNetworking.Connection("Psa", {
            network: network.networkName,
            reservedPeeringRanges: [range.addressName, extra.addressName],
          });
          return { network, range, extra, connection };
        }),
      );

      expect(updated.connection.network).toEqual(created.connection.network);
      expect(updated.connection.peering).toEqual(created.connection.peering);
      expect([...updated.connection.reservedPeeringRanges].sort()).toEqual(
        [created.range.addressName, created.extra.addressName].sort(),
      );

      const listedUpdated = yield* servicenetworking.listServicesConnections({
        parent,
        network: updated.connection.network,
      });
      const fetchedUpdated = (listedUpdated.connections ?? [])[0];
      expect([...(fetchedUpdated?.reservedPeeringRanges ?? [])].sort()).toEqual(
        [created.range.addressName, created.extra.addressName].sort(),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.connection.network);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  {
    tags: ["provider:gcp", "provider:gcp:servicenetworking", "live"],
    timeout: 600_000,
  },
);
