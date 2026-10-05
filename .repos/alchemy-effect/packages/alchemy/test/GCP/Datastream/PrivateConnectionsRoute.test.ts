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
  "getProjectsLocationsPrivateConnectionsRoutes on a missing route fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        datastream.getProjectsLocationsPrivateConnectionsRoutes({
          name: `projects/${project}/locations/${LOCATION}/privateConnections/alchemy-missing-pconn/routes/alchemy-missing-route`,
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
  "create and delete a private connection route",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("DsRouteVpc", {
            autoCreateSubnetworks: false,
          });
          const peering = yield* GCP.Datastream.PrivateConnection(
            "DsRoutePeer",
            {
              location: LOCATION,
              displayName: "ds-route-peer",
              force: true,
              vpcPeeringConfig: {
                vpc: network.networkName,
                subnet: "10.9.1.0/29",
              },
            },
          );
          const route = yield* GCP.Datastream.PrivateConnectionsRoute(
            "DbHost",
            {
              privateConnection: peering.name,
              location: LOCATION,
              displayName: "db-host",
              labels: { env: "test" },
              destinationAddress: "10.0.0.8",
              destinationPort: 3306,
            },
          );
          return { network, peering, route };
        }),
      );

      expect(created.route.routeId).toEqual(expect.any(String));
      expect(created.route.name).toEqual(
        `${created.peering.name}/routes/${created.route.routeId}`,
      );
      expect(created.route.privateConnection).toEqual(created.peering.name);
      expect(created.route.displayName).toEqual("db-host");
      expect(created.route.labels).toMatchObject({ env: "test" });
      expect(created.route.destinationAddress).toEqual("10.0.0.8");
      expect(created.route.destinationPort).toEqual(3306);

      const fetched =
        yield* datastream.getProjectsLocationsPrivateConnectionsRoutes({
          name: created.route.name,
        });
      expect(fetched.name).toEqual(created.route.name);
      expect(fetched.displayName).toEqual("db-host");
      expect(fetched.destinationAddress).toEqual("10.0.0.8");
      expect(fetched.labels?.env).toEqual("test");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datastream.getProjectsLocationsPrivateConnectionsRoutes({
          name: created.route.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel, withNetworkSlot),
  {
    tags: ["provider:gcp", "provider:gcp:datastream", "live"],
    timeout: 900_000,
  },
);
