import * as AWS from "@alchemy.run/aws";
import { ClientVpnEndpoint } from "@alchemy.run/aws/EC2/ClientVpnEndpoint";
import {
  ClientVpnTargetNetworkAssociation,
  type ClientVpnTargetNetworkAssociationProps,
} from "@alchemy.run/aws/EC2/ClientVpnTargetNetworkAssociation";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import {
  assertClientVpnAssociationDeleted,
  assertClientVpnCertificateDeleted,
  clientVpnAvailabilityZones,
  clientVpnEndpointProps,
  clientVpnTestTimeout,
  clientVpnNetwork,
  importClientVpnCertificate,
  readClientVpnTargetNetworks,
  waitForClientVpn,
} from "./fixtures/client-vpn.ts";

describe(
  "Client VPN target networks",
  { tags: ["provider:aws", "provider:aws:acm", "provider:aws:ec2", "live"] },
  () => {
    const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
      providers: AWS.providers(),
    });
    const certificate = beforeAll(importClientVpnCertificate("ClientVpnAssociationPrerequisites"));
    const zones = beforeAll(clientVpnAvailabilityZones);
    const Stack = Alchemy.Stack(
      "ClientVpnAssociationPrerequisites",
      { providers: AWS.providers(), state: Alchemy.localState() },
      Effect.gen(function* () {
        const certificateArn = yield* certificate;
        const network = yield* clientVpnNetwork(yield* zones);
        const endpoint = yield* ClientVpnEndpoint("Endpoint", {
          ...clientVpnEndpointProps(certificateArn),
          vpcId: network.vpc.vpcId,
          splitTunnel: true,
        });
        return { ...network, endpoint };
      }),
    );
    const prerequisites = beforeAll(deploy(Stack), { timeout: clientVpnTestTimeout });
    afterAll(
      destroy(Stack).pipe(
        Effect.andThen(certificate.pipe(Effect.flatMap(assertClientVpnCertificateDeleted))),
      ),
      { timeout: clientVpnTestTimeout },
    );

    test.provider.skipIf(!!process.env.FAST)(
      "creates, lists, retains, replaces, and deletes target network associations",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { endpoint, vpc, firstSubnet, secondSubnet } = yield* prerequisites;
          const clientVpnEndpointId = endpoint.clientVpnEndpointId;
          const deployAssociation = (
            subnetId: ClientVpnTargetNetworkAssociationProps["subnetId"],
          ) =>
            stack.deploy(
              ClientVpnTargetNetworkAssociation("Association", { clientVpnEndpointId, subnetId }),
            );
          const created = yield* deployAssociation(firstSubnet.subnetId);
          expect(created.associationId).toMatch(/^cvpn-assoc-/);
          expect(created.clientVpnEndpointId).toBe(clientVpnEndpointId);
          expect(created.subnetId).toBe(firstSubnet.subnetId);
          const networks = yield* waitForClientVpn(
            readClientVpnTargetNetworks(clientVpnEndpointId),
            (items) =>
              items.some(
                (network) =>
                  network.AssociationId === created.associationId &&
                  network.Status?.Code === "associated",
              ),
            "associated target network",
          );
          expect(networks).toContainEqual(
            expect.objectContaining({
              AssociationId: created.associationId,
              ClientVpnEndpointId: clientVpnEndpointId,
              TargetNetworkId: firstSubnet.subnetId,
              VpcId: vpc.vpcId,
            }),
          );
          const provider = yield* Provider.findProvider(ClientVpnTargetNetworkAssociation);
          const listed = yield* waitForClientVpn(
            provider.list(),
            (items) => items.some((network) => network.associationId === created.associationId),
            "target network provider list",
          );
          expect(listed).toContainEqual(
            expect.objectContaining({
              associationId: created.associationId,
              clientVpnEndpointId,
              subnetId: firstSubnet.subnetId,
            }),
          );
          const retained = yield* deployAssociation(firstSubnet.subnetId);
          expect(retained.associationId).toBe(created.associationId);
          expect(
            (yield* readClientVpnTargetNetworks(clientVpnEndpointId)).filter(
              (network) =>
                network.TargetNetworkId === firstSubnet.subnetId &&
                network.Status?.Code === "associated",
            ),
          ).toHaveLength(1);

          // Both subnet dependencies survive the replacement; they occupy different AZs.
          const replaced = yield* deployAssociation(secondSubnet.subnetId);
          expect(replaced.associationId).not.toBe(created.associationId);
          expect(replaced.subnetId).toBe(secondSubnet.subnetId);
          yield* waitForClientVpn(
            readClientVpnTargetNetworks(clientVpnEndpointId),
            (items) =>
              items.some(
                (network) =>
                  network.AssociationId === replaced.associationId &&
                  network.TargetNetworkId === secondSubnet.subnetId &&
                  network.Status?.Code === "associated",
              ),
            "replacement target network",
          );
          yield* assertClientVpnAssociationDeleted(clientVpnEndpointId, created.associationId);
          yield* stack.destroy();
          yield* assertClientVpnAssociationDeleted(clientVpnEndpointId, replaced.associationId);
        }),
      { timeout: clientVpnTestTimeout },
    );
  },
);
