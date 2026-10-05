import * as AWS from "@/AWS";
import { Subnet, Vpc } from "@/AWS/EC2";
import type { ClientVpnEndpointProps } from "@/AWS/EC2/ClientVpnEndpoint.ts";
import { createInternalTags, createTagsList } from "@/Tags.ts";
import { withProviders } from "@/Test/Core.ts";
import * as acm from "@distilled.cloud/aws/acm";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  CLIENT_VPN_CA_PEM,
  CLIENT_VPN_CERTIFICATE_PEM,
  CLIENT_VPN_PRIVATE_KEY_PEM,
} from "./client-vpn-certificate.ts";

// A lifecycle test performs several create, replacement, and delete operations.
export const clientVpnTestTimeout =
  Number(process.env.AWS_CLIENT_VPN_TEST_TIMEOUT_MINUTES ?? 60) * 60_000;
if (!Number.isFinite(clientVpnTestTimeout) || clientVpnTestTimeout <= 0) {
  throw new RangeError(
    "AWS_CLIENT_VPN_TEST_TIMEOUT_MINUTES must be positive and finite",
  );
}

class ClientVpnFixtureNotReady extends Data.TaggedError(
  "ClientVpnFixtureNotReady",
)<{ readonly resource: string }> {}

// ACM.Certificate only requests public certificates; VPN mutual auth needs an imported CA chain.
export const importClientVpnCertificate = (stackName: string) =>
  withProviders(
    Effect.acquireRelease(
      Effect.gen(function* () {
        const tags = yield* createInternalTags("Certificate");
        const pem = yield* Effect.sync(() => {
          const encoder = new TextEncoder();
          return {
            Certificate: encoder.encode(CLIENT_VPN_CERTIFICATE_PEM),
            PrivateKey: Redacted.make(
              encoder.encode(CLIENT_VPN_PRIVATE_KEY_PEM),
            ),
            CertificateChain: encoder.encode(CLIENT_VPN_CA_PEM),
          };
        });
        const imported = yield* acm.importCertificate({
          ...pem,
          Tags: createTagsList(tags),
        });
        if (!imported.CertificateArn) {
          return yield* Effect.fail(
            new ClientVpnFixtureNotReady({
              resource: "ACM certificate import",
            }),
          );
        }
        return imported.CertificateArn;
      }),
      (certificateArn) =>
        acm.deleteCertificate({ CertificateArn: certificateArn }).pipe(
          Effect.retry({
            while: (error) => error._tag === "ResourceInUseException",
            schedule: Schedule.spaced("5 seconds").pipe(
              Schedule.upTo({ duration: clientVpnTestTimeout }),
            ),
          }),
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          Effect.orDie,
        ),
    ),
    { providers: AWS.providers() },
    stackName,
  );

export const assertClientVpnCertificateDeleted = (certificateArn: string) =>
  withProviders(
    acm.describeCertificate({ CertificateArn: certificateArn }).pipe(
      Effect.flatMap(() =>
        Effect.fail(new ClientVpnFixtureNotReady({ resource: certificateArn })),
      ),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    ),
    { providers: AWS.providers() },
    "ClientVpnCertificateCleanup",
  );

export const clientVpnEndpointProps = (
  certificateArn: string,
): ClientVpnEndpointProps => ({
  clientCidrBlock: "172.20.0.0/22",
  serverCertificateArn: certificateArn,
  authenticationOptions: [
    {
      type: "certificate-authentication",
      mutualAuthentication: {
        clientRootCertificateChainArn: certificateArn,
      },
    },
  ],
});

export const clientVpnAvailabilityZones = withProviders(
  Effect.gen(function* () {
    const zones = yield* ec2.describeAvailabilityZones({
      Filters: [
        { Name: "state", Values: ["available"] },
        { Name: "zone-type", Values: ["availability-zone"] },
      ],
    });
    const [firstZone, secondZone] = (zones.AvailabilityZones ?? [])
      .map((zone) => zone.ZoneName)
      .filter((name): name is string => name !== undefined)
      .sort();
    if (!firstZone || !secondZone) {
      return yield* Effect.fail(
        new ClientVpnFixtureNotReady({
          resource: "two AWS availability zones",
        }),
      );
    }
    return { firstZone, secondZone };
  }),
  { providers: AWS.providers() },
  "ClientVpnNetworkPrerequisites",
);

export const clientVpnNetwork = ({
  firstZone,
  secondZone,
}: {
  firstZone: string;
  secondZone: string;
}) =>
  Effect.gen(function* () {
    const vpc = yield* Vpc("Vpc", {
      cidrBlock: "10.171.0.0/16",
      enableDnsSupport: true,
      enableDnsHostnames: true,
    });
    const firstSubnet = yield* Subnet("FirstSubnet", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.171.1.0/24",
      availabilityZone: firstZone,
    });
    const secondSubnet = yield* Subnet("SecondSubnet", {
      vpcId: vpc.vpcId,
      cidrBlock: "10.171.2.0/24",
      availabilityZone: secondZone,
    });
    return { vpc, firstSubnet, secondSubnet };
  });

export const waitForClientVpn = <A, E, R>(
  observed: Effect.Effect<A, E, R>,
  ready: (value: A) => boolean,
  resource: string,
) =>
  observed.pipe(
    Effect.flatMap((value) =>
      ready(value)
        ? Effect.succeed(value)
        : Effect.fail(new ClientVpnFixtureNotReady({ resource })),
    ),
    Effect.retry({
      while: (error) => error instanceof ClientVpnFixtureNotReady,
      schedule: Schedule.spaced("5 seconds").pipe(
        Schedule.upTo({ duration: clientVpnTestTimeout }),
      ),
    }),
  );

export const readClientVpnEndpoint = (clientVpnEndpointId: string) =>
  ec2
    .describeClientVpnEndpoints({
      ClientVpnEndpointIds: [clientVpnEndpointId],
    })
    .pipe(
      Effect.map((response) =>
        response.ClientVpnEndpoints?.find(
          (endpoint) => endpoint.ClientVpnEndpointId === clientVpnEndpointId,
        ),
      ),
      Effect.catchTag("InvalidClientVpnEndpointId.NotFound", () =>
        Effect.succeed(undefined),
      ),
    );

export const assertClientVpnEndpointDeleted = (clientVpnEndpointId: string) =>
  waitForClientVpn(
    readClientVpnEndpoint(clientVpnEndpointId),
    (endpoint) => endpoint === undefined || endpoint.Status?.Code === "deleted",
    clientVpnEndpointId,
  );

export const readClientVpnAuthorizationRules = (clientVpnEndpointId: string) =>
  ec2.describeClientVpnAuthorizationRules
    .items({ ClientVpnEndpointId: clientVpnEndpointId })
    .pipe(Stream.runCollect);

export const readClientVpnTargetNetworks = (clientVpnEndpointId: string) =>
  ec2.describeClientVpnTargetNetworks
    .items({ ClientVpnEndpointId: clientVpnEndpointId })
    .pipe(Stream.runCollect);

export const readClientVpnRoutes = (clientVpnEndpointId: string) =>
  ec2.describeClientVpnRoutes
    .items({ ClientVpnEndpointId: clientVpnEndpointId })
    .pipe(Stream.runCollect);

export const assertClientVpnAuthorizationDeleted = (
  clientVpnEndpointId: string,
  targetNetworkCidr: string,
) =>
  waitForClientVpn(
    readClientVpnAuthorizationRules(clientVpnEndpointId),
    (rules) =>
      !rules.some(
        (rule) =>
          rule.DestinationCidr === targetNetworkCidr &&
          rule.Status?.Code !== "revoked",
      ),
    `authorization ${targetNetworkCidr}`,
  );

export const assertClientVpnAssociationDeleted = (
  clientVpnEndpointId: string,
  associationId: string,
) =>
  waitForClientVpn(
    readClientVpnTargetNetworks(clientVpnEndpointId),
    (networks) =>
      !networks.some(
        (network) =>
          network.AssociationId === associationId &&
          network.Status?.Code !== "disassociated",
      ),
    associationId,
  );

export const assertClientVpnRouteDeleted = (
  clientVpnEndpointId: string,
  destinationCidrBlock: string,
  targetVpcSubnetId: string,
) =>
  waitForClientVpn(
    readClientVpnRoutes(clientVpnEndpointId),
    (routes) =>
      !routes.some(
        (route) =>
          route.DestinationCidr === destinationCidrBlock &&
          route.TargetSubnet === targetVpcSubnetId &&
          route.Status?.Code !== "deleted",
      ),
    `route ${destinationCidrBlock} via ${targetVpcSubnetId}`,
  );

export const expectClientVpnOwnershipTags = (
  tags: ec2.Tag[] | undefined,
  stack: { name: string; stage: string },
  id: string,
) => {
  expect(tags).toEqual(
    expect.arrayContaining([
      { Key: "alchemy::stack", Value: stack.name },
      { Key: "alchemy::stage", Value: stack.stage },
      { Key: "alchemy::id", Value: id },
    ]),
  );
};
