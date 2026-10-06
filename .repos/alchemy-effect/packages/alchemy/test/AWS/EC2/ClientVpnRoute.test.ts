import * as AWS from "@/AWS";
import { ClientVpnEndpoint } from "@/AWS/EC2/ClientVpnEndpoint.ts";
import {
  ClientVpnRoute,
  type ClientVpnRouteProps,
} from "@/AWS/EC2/ClientVpnRoute.ts";
import { ClientVpnTargetNetworkAssociation } from "@/AWS/EC2/ClientVpnTargetNetworkAssociation.ts";
import * as Alchemy from "@/index.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  assertClientVpnCertificateDeleted,
  assertClientVpnRouteDeleted,
  clientVpnAvailabilityZones,
  clientVpnEndpointProps,
  clientVpnTestTimeout,
  clientVpnNetwork,
  importClientVpnCertificate,
  readClientVpnRoutes,
  readClientVpnTargetNetworks,
  waitForClientVpn,
} from "./fixtures/client-vpn.ts";

describe(
  "Client VPN routes",
  { tags: ["provider:aws", "provider:aws:acm", "provider:aws:ec2", "live"] },
  () => {
    const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
      providers: AWS.providers(),
    });
    const certificate = beforeAll(
      importClientVpnCertificate("ClientVpnRoutePrerequisites"),
    );
    const zones = beforeAll(clientVpnAvailabilityZones);
    const Stack = Alchemy.Stack(
      "ClientVpnRoutePrerequisites",
      { providers: AWS.providers(), state: Alchemy.localState() },
      Effect.gen(function* () {
        const certificateArn = yield* certificate;
        const network = yield* clientVpnNetwork(yield* zones);
        const endpoint = yield* ClientVpnEndpoint("Endpoint", {
          ...clientVpnEndpointProps(certificateArn),
          vpcId: network.vpc.vpcId,
          splitTunnel: true,
        });
        const firstAssociation = yield* ClientVpnTargetNetworkAssociation(
          "FirstAssociation",
          {
            clientVpnEndpointId: endpoint.clientVpnEndpointId,
            subnetId: network.firstSubnet.subnetId,
          },
        );
        const secondAssociation = yield* ClientVpnTargetNetworkAssociation(
          "SecondAssociation",
          {
            clientVpnEndpointId: endpoint.clientVpnEndpointId,
            subnetId: network.secondSubnet.subnetId,
          },
        );
        return { ...network, endpoint, firstAssociation, secondAssociation };
      }),
    );
    const prerequisites = beforeAll(deploy(Stack), {
      timeout: clientVpnTestTimeout,
    });
    afterAll(
      destroy(Stack).pipe(
        Effect.andThen(
          certificate.pipe(Effect.flatMap(assertClientVpnCertificateDeleted)),
        ),
      ),
      { timeout: clientVpnTestTimeout },
    );

    test.provider(
      "creates, lists, replaces, repairs, and deletes Client VPN routes",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { endpoint, firstSubnet, secondSubnet } = yield* prerequisites;
          const clientVpnEndpointId = endpoint.clientVpnEndpointId;
          yield* waitForClientVpn(
            readClientVpnTargetNetworks(clientVpnEndpointId),
            (networks) =>
              [firstSubnet.subnetId, secondSubnet.subnetId].every((subnetId) =>
                networks.some(
                  (network) =>
                    network.TargetNetworkId === subnetId &&
                    network.Status?.Code === "associated",
                ),
              ),
            "route target networks",
          );
          const deployRoute = (
            destinationCidrBlock: string,
            targetVpcSubnetId: ClientVpnRouteProps["targetVpcSubnetId"],
            description?: string,
          ) =>
            stack.deploy(
              ClientVpnRoute("Route", {
                clientVpnEndpointId,
                destinationCidrBlock,
                targetVpcSubnetId,
                description,
              }),
            );
          const created = yield* deployRoute(
            "192.168.10.0/24",
            firstSubnet.subnetId,
            "Initial route",
          );
          expect(created.clientVpnEndpointId).toBe(clientVpnEndpointId);
          expect(created.destinationCidrBlock).toBe("192.168.10.0/24");
          expect(created.targetVpcSubnetId).toBe(firstSubnet.subnetId);
          const routes = yield* waitForClientVpn(
            readClientVpnRoutes(clientVpnEndpointId),
            (items) =>
              items.some(
                (route) =>
                  route.DestinationCidr === "192.168.10.0/24" &&
                  route.TargetSubnet === firstSubnet.subnetId &&
                  route.Status?.Code === "active",
              ),
            "active custom route",
          );
          expect(routes).toContainEqual(
            expect.objectContaining({
              DestinationCidr: "192.168.10.0/24",
              TargetSubnet: firstSubnet.subnetId,
              Description: "Initial route",
            }),
          );
          const provider = yield* Provider.findProvider(ClientVpnRoute);
          const listed = yield* waitForClientVpn(
            provider.list(),
            (items) =>
              items.some(
                (route) =>
                  route.clientVpnEndpointId === clientVpnEndpointId &&
                  route.destinationCidrBlock === "192.168.10.0/24" &&
                  route.targetVpcSubnetId === firstSubnet.subnetId,
              ),
            "route provider list",
          );
          expect(listed).toContainEqual(
            expect.objectContaining({
              clientVpnEndpointId,
              destinationCidrBlock: "192.168.10.0/24",
              targetVpcSubnetId: firstSubnet.subnetId,
            }),
          );
          yield* deployRoute(
            "192.168.10.0/24",
            firstSubnet.subnetId,
            "Initial route",
          );
          expect(
            (yield* readClientVpnRoutes(clientVpnEndpointId)).filter(
              (route) =>
                route.DestinationCidr === "192.168.10.0/24" &&
                route.TargetSubnet === firstSubnet.subnetId &&
                route.Status?.Code === "active",
            ),
          ).toHaveLength(1);

          // AWS has no modify-route API; description changes replace the route at the same identity.
          yield* deployRoute(
            "192.168.10.0/24",
            firstSubnet.subnetId,
            "Updated route",
          );
          yield* waitForClientVpn(
            readClientVpnRoutes(clientVpnEndpointId),
            (items) =>
              items.some(
                (route) =>
                  route.DestinationCidr === "192.168.10.0/24" &&
                  route.TargetSubnet === firstSubnet.subnetId &&
                  route.Description === "Updated route" &&
                  route.Status?.Code === "active",
              ),
            "replaced route description",
          );
          yield* deployRoute("192.168.11.0/24", firstSubnet.subnetId);
          yield* assertClientVpnRouteDeleted(
            clientVpnEndpointId,
            "192.168.10.0/24",
            firstSubnet.subnetId,
          );
          const replaced = yield* deployRoute(
            "192.168.11.0/24",
            secondSubnet.subnetId,
          );
          expect(replaced.targetVpcSubnetId).toBe(secondSubnet.subnetId);
          yield* assertClientVpnRouteDeleted(
            clientVpnEndpointId,
            "192.168.11.0/24",
            firstSubnet.subnetId,
          );
          const replacement = yield* waitForClientVpn(
            readClientVpnRoutes(clientVpnEndpointId),
            (items) =>
              items.some(
                (route) =>
                  route.DestinationCidr === "192.168.11.0/24" &&
                  route.TargetSubnet === secondSubnet.subnetId &&
                  route.Status?.Code === "active",
              ),
            "replacement route target",
          );
          expect(
            replacement.find(
              (route) =>
                route.DestinationCidr === "192.168.11.0/24" &&
                route.TargetSubnet === secondSubnet.subnetId,
            )?.Description ?? "",
          ).toBe("");

          yield* ec2.deleteClientVpnRoute({
            ClientVpnEndpointId: clientVpnEndpointId,
            DestinationCidrBlock: "192.168.11.0/24",
            TargetVpcSubnetId: secondSubnet.subnetId,
          });
          yield* assertClientVpnRouteDeleted(
            clientVpnEndpointId,
            "192.168.11.0/24",
            secondSubnet.subnetId,
          );
          yield* deployRoute("192.168.11.0/24", secondSubnet.subnetId);
          yield* waitForClientVpn(
            readClientVpnRoutes(clientVpnEndpointId),
            (items) =>
              items.some(
                (route) =>
                  route.DestinationCidr === "192.168.11.0/24" &&
                  route.TargetSubnet === secondSubnet.subnetId &&
                  route.Status?.Code === "active",
              ),
            "recreated out-of-band deleted route",
          );
          yield* stack.destroy();
          yield* assertClientVpnRouteDeleted(
            clientVpnEndpointId,
            "192.168.11.0/24",
            secondSubnet.subnetId,
          );
          // Deleting a managed route must retain AWS's association-owned VPC routes.
          const remaining = yield* readClientVpnRoutes(clientVpnEndpointId);
          expect(remaining).toContainEqual(
            expect.objectContaining({
              DestinationCidr: "10.171.0.0/16",
              TargetSubnet: firstSubnet.subnetId,
              Status: expect.objectContaining({ Code: "active" }),
            }),
          );
          expect(remaining).toContainEqual(
            expect.objectContaining({
              DestinationCidr: "10.171.0.0/16",
              TargetSubnet: secondSubnet.subnetId,
              Status: expect.objectContaining({ Code: "active" }),
            }),
          );
        }),
      { timeout: clientVpnTestTimeout },
    );
  },
);
