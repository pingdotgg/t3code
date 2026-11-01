import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datastream from "@distilled.cloud/gcp/datastream_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  LOCATION,
  logLevel,
  currentProject,
  runSlowLifecycle,
  waitUntilGone,
} from "./common.ts";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsPrivateConnections on a missing connection fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datastream.getProjectsLocationsPrivateConnections({
          name: `projects/${project}/locations/${LOCATION}/privateConnections/alchemy-missing-pconn`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datastream", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runSlowLifecycle)(
  "create and delete a private connection",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("DsVpc", {
            autoCreateSubnetworks: false,
          });
          const peering = yield* GCP.Datastream.PrivateConnection("DsPeer", {
            location: LOCATION,
            displayName: "ds-peer",
            labels: { env: "test" },
            force: true,
            vpcPeeringConfig: {
              vpc: network.networkName,
              subnet: "10.9.0.0/29",
            },
          });
          return { network, peering };
        }),
      );

      expect(created.peering.privateConnectionId).toEqual(expect.any(String));
      expect(created.peering.name).toEqual(
        `projects/${project}/locations/${LOCATION}/privateConnections/${created.peering.privateConnectionId}`,
      );
      expect(created.peering.location).toEqual(LOCATION);
      expect(created.peering.displayName).toEqual("ds-peer");
      expect(created.peering.labels).toMatchObject({ env: "test" });
      expect(created.peering.vpcPeeringConfig?.subnet).toEqual("10.9.0.0/29");

      const fetched = yield* datastream.getProjectsLocationsPrivateConnections({
        name: created.peering.name,
      });
      expect(fetched.name).toEqual(created.peering.name);
      expect(fetched.displayName).toEqual("ds-peer");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.vpcPeeringConfig?.subnet).toEqual("10.9.0.0/29");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datastream.getProjectsLocationsPrivateConnections({
          name: created.peering.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  {
    tags: ["provider:gcp", "provider:gcp:datastream", "live"],
    timeout: 900_000,
  },
);
