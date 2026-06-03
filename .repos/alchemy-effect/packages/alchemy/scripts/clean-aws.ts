#!/usr/bin/env bun

// @ts-nocheck

import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    region: { type: "string", short: "r" },
    profile: { type: "string", short: "p" },
    execute: { type: "boolean" },
    "include-default-vpcs": { type: "boolean" },
    passes: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

const usage = `
Best-effort EC2 regional cleanup using @distilled.cloud/aws.

Usage:
  bun alchemy/scripts/clean-aws.ts --region us-east-1 [--profile dev]
  bun alchemy/scripts/clean-aws.ts --region us-east-1 --execute

Options:
  --region, -r              AWS region to clean
  --profile, -p             Optional AWS profile
  --execute                 Perform deletions (default is dry-run)
  --include-default-vpcs    Also attempt to delete default VPC resources
  --passes                  Cleanup passes to run (default: 1 dry-run, 4 execute)
  --help, -h                Show this help
`;

if (values.help) {
  console.log(usage.trim());
  process.exit(0);
}

const region =
  values.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
if (!region) {
  console.error("Missing --region. Set it explicitly or via AWS_REGION.");
  console.error(usage.trim());
  process.exit(1);
}

if (values.profile) {
  process.env.AWS_PROFILE = values.profile;
}

const execute = values.execute ?? false;
const includeDefaultVpcs = values["include-default-vpcs"] ?? false;
const maxPasses = Number(values.passes ?? (execute ? "4" : "1"));

if (!Number.isFinite(maxPasses) || maxPasses < 1) {
  console.error("--passes must be a positive integer.");
  process.exit(1);
}

const credentialsLayer = values.profile
  ? Layer.provideMerge(
      Credentials.fromSSO(values.profile),
      Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
    )
  : Credentials.fromChain();

const runtime = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  credentialsLayer,
  Layer.succeed(Region, region),
);

const formatError = (error: unknown) => {
  if (typeof error === "object" && error && "_tag" in error) {
    const tagged = error as { _tag: string; message?: string };
    return tagged.message ? `${tagged._tag}: ${tagged.message}` : tagged._tag;
  }
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const log = (message: string) => Effect.sync(() => console.log(message));
const warn = (message: string) => Effect.sync(() => console.warn(message));

const isNotFoundError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  String((error as { _tag: string })._tag).includes("NotFound");

const uniq = <T>(items: ReadonlyArray<T | null | undefined>) => [
  ...new Set(
    items.filter((item): item is T => item !== null && item !== undefined),
  ),
];

const chunk = <T>(items: ReadonlyArray<T>, size: number) => {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
};

const preview = (label: string, ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? Effect.void
    : log(`Found ${ids.length} ${label}: ${ids.join(", ")}`);

const ignoreFailure = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      isNotFoundError(error)
        ? warn(`Already gone ${label}: ${formatError(error)}`)
        : Effect.fail(error as E),
    ),
  );

const deleteEach = <R>(
  label: string,
  ids: ReadonlyArray<string>,
  remove: (id: string) => Effect.Effect<any, any, R>,
) =>
  Effect.gen(function* () {
    if (ids.length === 0) {
      return;
    }

    yield* preview(label, ids);
    if (!execute) {
      return;
    }

    yield* Effect.forEach(
      ids,
      (id) => ignoreFailure(`${label} ${id}`, remove(id)),
      {
        concurrency: 1,
        discard: true,
      },
    );
  });

const repeatUntil = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  attempts: number,
  delayMs: number,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const value = yield* effect;
    if (done(value)) {
      return;
    }
    if (attempts <= 1) {
      yield* warn(`Timed out waiting for ${label}.`);
      return;
    }
    yield* log(`Waiting for ${label}...`);
    yield* Effect.sleep(delayMs);
    yield* repeatUntil(label, effect, done, attempts - 1, delayMs);
  });

const terminateInstances = Effect.gen(function* () {
  const response = yield* ec2.describeInstances({} as any);
  const ids = uniq(
    (response.Reservations ?? []).flatMap((reservation: any) =>
      (reservation.Instances ?? [])
        .filter((instance: any) => {
          const state = instance.State?.Name;
          return state !== "shutting-down" && state !== "terminated";
        })
        .map((instance: any) => instance.InstanceId),
    ),
  );

  if (ids.length === 0) {
    return;
  }

  yield* preview("instance(s)", ids);
  if (!execute) {
    return;
  }

  for (const group of chunk(ids, 100)) {
    yield* ignoreFailure(
      `instances ${group.join(", ")}`,
      ec2.terminateInstances({ InstanceIds: group } as any),
    );
  }

  yield* repeatUntil(
    "instances to terminate",
    ec2
      .describeInstances({} as any)
      .pipe(
        Effect.map((result) =>
          uniq(
            (result.Reservations ?? []).flatMap((reservation: any) =>
              (reservation.Instances ?? [])
                .filter((instance: any) => ids.includes(instance.InstanceId))
                .map((instance: any) => instance.State?.Name),
            ),
          ),
        ),
      ),
    (states) => states.every((state) => state === "terminated"),
    40,
    5_000,
  );
});

const deleteVpcEndpoints = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeVpcEndpoints({} as any)).VpcEndpoints?.map(
      (endpoint: any) => endpoint.VpcEndpointId,
    ),
  );

  if (ids.length === 0) {
    return;
  }

  yield* preview("VPC endpoint(s)", ids);
  if (!execute) {
    return;
  }

  for (const group of chunk(ids, 25)) {
    yield* ignoreFailure(
      `VPC endpoints ${group.join(", ")}`,
      ec2.deleteVpcEndpoints({ VpcEndpointIds: group } as any),
    );
  }

  yield* repeatUntil(
    "VPC endpoints to delete",
    ec2.describeVpcEndpoints({ VpcEndpointIds: ids } as any).pipe(
      Effect.map((result) =>
        uniq(
          (result.VpcEndpoints ?? []).map(
            (endpoint: any) => endpoint.VpcEndpointId,
          ),
        ),
      ),
      Effect.catch((error) =>
        isNotFoundError(error)
          ? Effect.succeed([] as string[])
          : Effect.fail(error),
      ),
    ),
    (remainingIds) => remainingIds.length === 0,
    30,
    5_000,
  );
});

const deleteNatGateways = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeNatGateways({} as any)).NatGateways?.filter(
      (natGateway: any) => natGateway.State !== "deleted",
    ).map((natGateway: any) => natGateway.NatGatewayId),
  );

  if (ids.length === 0) {
    return;
  }

  yield* preview("NAT gateway(s)", ids);
  if (!execute) {
    return;
  }

  yield* Effect.forEach(
    ids,
    (id) =>
      ignoreFailure(
        `NAT gateway ${id}`,
        ec2.deleteNatGateway({ NatGatewayId: id } as any),
      ),
    { concurrency: 1, discard: true },
  );

  yield* repeatUntil(
    "NAT gateways to delete",
    ec2
      .describeNatGateways({} as any)
      .pipe(
        Effect.map((result) =>
          uniq(
            (result.NatGateways ?? [])
              .filter((natGateway: any) =>
                ids.includes(natGateway.NatGatewayId),
              )
              .map((natGateway: any) => natGateway.State),
          ),
        ),
      ),
    (states) => states.every((state) => state === "deleted"),
    30,
    10_000,
  );
});

const deleteNetworkInterfaces = Effect.gen(function* () {
  const interfaces =
    (yield* ec2.describeNetworkInterfaces({} as any)).NetworkInterfaces ?? [];

  const blocked = interfaces.filter(
    (networkInterface: any) =>
      networkInterface.Attachment ||
      networkInterface.RequesterManaged ||
      networkInterface.Status !== "available",
  );

  if (blocked.length > 0) {
    return yield* Effect.fail(
      new Error(
        `Network interfaces still in use: ${blocked
          .map(
            (networkInterface: any) =>
              `${networkInterface.NetworkInterfaceId}(status=${networkInterface.Status ?? "unknown"}, requesterManaged=${networkInterface.RequesterManaged ?? false}, attachment=${networkInterface.Attachment?.AttachmentId ?? "none"})`,
          )
          .join(", ")}`,
      ),
    );
  }

  const ids = uniq(
    interfaces.map(
      (networkInterface: any) => networkInterface.NetworkInterfaceId,
    ),
  );

  yield* deleteEach("network interface(s)", ids, (id) =>
    ec2.deleteNetworkInterface({ NetworkInterfaceId: id } as any),
  );
});

const releaseElasticIps = Effect.gen(function* () {
  const addresses = (yield* ec2.describeAddresses({} as any)).Addresses ?? [];
  const ids = uniq(
    addresses.map((address: any) => address.AllocationId ?? address.PublicIp),
  );

  if (ids.length === 0) {
    return;
  }

  yield* preview("elastic IP(s)", ids);
  if (!execute) {
    return;
  }

  yield* Effect.forEach(
    addresses,
    (address: any) =>
      Effect.gen(function* () {
        if (address.AssociationId) {
          yield* ignoreFailure(
            `elastic IP association ${address.AssociationId}`,
            ec2.disassociateAddress({
              AssociationId: address.AssociationId,
            } as any),
          );
        }
        yield* ignoreFailure(
          `elastic IP ${address.AllocationId ?? address.PublicIp}`,
          ec2.releaseAddress(
            address.AllocationId
              ? ({ AllocationId: address.AllocationId } as any)
              : ({ PublicIp: address.PublicIp } as any),
          ),
        );
      }),
    { concurrency: 1, discard: true },
  );
});

const deleteVpcPeeringConnections = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeVpcPeeringConnections(
      {} as any,
    )).VpcPeeringConnections?.filter(
      (connection: any) => connection.Status?.Code !== "deleted",
    ).map((connection: any) => connection.VpcPeeringConnectionId),
  );

  yield* deleteEach("VPC peering connection(s)", ids, (id) =>
    ec2.deleteVpcPeeringConnection({ VpcPeeringConnectionId: id } as any),
  );
});

const deleteVpnConnections = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeVpnConnections({} as any)).VpnConnections?.filter(
      (connection: any) => connection.State !== "deleted",
    ).map((connection: any) => connection.VpnConnectionId),
  );

  yield* deleteEach("VPN connection(s)", ids, (id) =>
    ec2.deleteVpnConnection({ VpnConnectionId: id } as any),
  );
});

const deleteVpnGateways = Effect.gen(function* () {
  const gateways =
    (yield* ec2.describeVpnGateways({} as any)).VpnGateways ?? [];
  const ids = uniq(
    gateways
      .filter((gateway: any) => gateway.State !== "deleted")
      .map((gateway: any) => gateway.VpnGatewayId),
  );

  if (ids.length === 0) {
    return;
  }

  yield* preview("VPN gateway(s)", ids);
  if (!execute) {
    return;
  }

  yield* Effect.forEach(
    gateways,
    (gateway: any) =>
      Effect.gen(function* () {
        for (const attachment of gateway.VpcAttachments ?? []) {
          if (attachment.VpcId && attachment.State !== "detached") {
            yield* ignoreFailure(
              `VPN gateway attachment ${gateway.VpnGatewayId}`,
              ec2.detachVpnGateway({
                VpcId: attachment.VpcId,
                VpnGatewayId: gateway.VpnGatewayId,
              } as any),
            );
          }
        }

        yield* ignoreFailure(
          `VPN gateway ${gateway.VpnGatewayId}`,
          ec2.deleteVpnGateway({ VpnGatewayId: gateway.VpnGatewayId } as any),
        );
      }),
    { concurrency: 1, discard: true },
  );
});

const deleteCustomerGateways = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeCustomerGateways({} as any)).CustomerGateways?.map(
      (gateway: any) => gateway.CustomerGatewayId,
    ),
  );

  yield* deleteEach("customer gateway(s)", ids, (id) =>
    ec2.deleteCustomerGateway({ CustomerGatewayId: id } as any),
  );
});

const deleteInternetGateways = Effect.gen(function* () {
  const gateways =
    (yield* ec2.describeInternetGateways({} as any)).InternetGateways ?? [];
  const ids = uniq(gateways.map((gateway: any) => gateway.InternetGatewayId));

  if (ids.length === 0) {
    return;
  }

  yield* preview("internet gateway(s)", ids);
  if (!execute) {
    return;
  }

  yield* Effect.forEach(
    gateways,
    (gateway: any) =>
      Effect.gen(function* () {
        for (const attachment of gateway.Attachments ?? []) {
          if (attachment.VpcId) {
            yield* ignoreFailure(
              `internet gateway attachment ${gateway.InternetGatewayId}`,
              ec2.detachInternetGateway({
                InternetGatewayId: gateway.InternetGatewayId,
                VpcId: attachment.VpcId,
              } as any),
            );
          }
        }

        yield* ignoreFailure(
          `internet gateway ${gateway.InternetGatewayId}`,
          ec2.deleteInternetGateway({
            InternetGatewayId: gateway.InternetGatewayId,
          } as any),
        );
      }),
    { concurrency: 1, discard: true },
  );
});

const deleteEgressOnlyInternetGateways = Effect.gen(function* () {
  const gateways =
    (yield* ec2.describeEgressOnlyInternetGateways({} as any))
      .EgressOnlyInternetGateways ?? [];
  const ids = uniq(
    gateways.map((gateway: any) => gateway.EgressOnlyInternetGatewayId),
  );

  yield* deleteEach("egress-only internet gateway(s)", ids, (id) =>
    ec2.deleteEgressOnlyInternetGateway({
      EgressOnlyInternetGatewayId: id,
    } as any),
  );
});

const deleteRouteTables = Effect.gen(function* () {
  const routeTables =
    (yield* ec2.describeRouteTables({} as any)).RouteTables?.filter(
      (routeTable: any) =>
        !(routeTable.Associations ?? []).some(
          (association: any) => association.Main,
        ),
    ) ?? [];

  const ids = uniq(
    routeTables.map((routeTable: any) => routeTable.RouteTableId),
  );

  if (ids.length === 0) {
    return;
  }

  yield* preview("non-main route table(s)", ids);
  if (!execute) {
    return;
  }

  yield* Effect.forEach(
    routeTables,
    (routeTable: any) =>
      Effect.gen(function* () {
        for (const association of routeTable.Associations ?? []) {
          if (!association.Main && association.RouteTableAssociationId) {
            yield* ignoreFailure(
              `route table association ${association.RouteTableAssociationId}`,
              ec2.disassociateRouteTable({
                AssociationId: association.RouteTableAssociationId,
              } as any),
            );
          }
        }

        yield* ignoreFailure(
          `route table ${routeTable.RouteTableId}`,
          ec2.deleteRouteTable({
            RouteTableId: routeTable.RouteTableId,
          } as any),
        );
      }),
    { concurrency: 1, discard: true },
  );
});

const deleteSubnets = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeSubnets({} as any)).Subnets?.filter((subnet: any) =>
      includeDefaultVpcs ? true : !subnet.DefaultForAz,
    ).map((subnet: any) => subnet.SubnetId),
  );

  yield* deleteEach("subnet(s)", ids, (id) =>
    ec2.deleteSubnet({ SubnetId: id } as any),
  );
});

const deleteSecurityGroups = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeSecurityGroups({} as any)).SecurityGroups?.filter(
      (group: any) => group.GroupName !== "default",
    ).map((group: any) => group.GroupId),
  );

  yield* deleteEach("security group(s)", ids, (id) =>
    ec2.deleteSecurityGroup({ GroupId: id } as any),
  );
});

const deleteNetworkAcls = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeNetworkAcls({} as any)).NetworkAcls?.filter(
      (acl: any) => !acl.IsDefault,
    ).map((acl: any) => acl.NetworkAclId),
  );

  yield* deleteEach("network ACL(s)", ids, (id) =>
    ec2.deleteNetworkAcl({ NetworkAclId: id } as any),
  );
});

const deleteAvailableVolumes = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeVolumes({} as any)).Volumes?.filter(
      (volume: any) => volume.State === "available",
    ).map((volume: any) => volume.VolumeId),
  );

  yield* deleteEach("available volume(s)", ids, (id) =>
    ec2.deleteVolume({ VolumeId: id } as any),
  );
});

const deregisterImages = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeImages({ Owners: ["self"] } as any)).Images?.map(
      (image: any) => image.ImageId,
    ),
  );

  yield* deleteEach("AMI(s)", ids, (id) =>
    ec2.deregisterImage({ ImageId: id } as any),
  );
});

const deleteSnapshots = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeSnapshots({
      OwnerIds: ["self"],
    } as any)).Snapshots?.map((snapshot: any) => snapshot.SnapshotId),
  );

  yield* deleteEach("snapshot(s)", ids, (id) =>
    ec2.deleteSnapshot({ SnapshotId: id } as any),
  );
});

const deleteLaunchTemplates = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeLaunchTemplates({} as any)).LaunchTemplates?.map(
      (template: any) => template.LaunchTemplateId,
    ),
  );

  yield* deleteEach("launch template(s)", ids, (id) =>
    ec2.deleteLaunchTemplate({ LaunchTemplateId: id } as any),
  );
});

const deletePlacementGroups = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describePlacementGroups({} as any)).PlacementGroups?.map(
      (group: any) => group.GroupName,
    ),
  );

  yield* deleteEach("placement group(s)", ids, (id) =>
    ec2.deletePlacementGroup({ GroupName: id } as any),
  );
});

const deleteKeyPairs = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeKeyPairs({} as any)).KeyPairs?.map(
      (keyPair: any) => keyPair.KeyPairId,
    ),
  );

  yield* deleteEach("key pair(s)", ids, (id) =>
    ec2.deleteKeyPair({ KeyPairId: id } as any),
  );
});

const deleteVpcs = Effect.gen(function* () {
  const ids = uniq(
    (yield* ec2.describeVpcs({} as any)).Vpcs?.filter((vpc: any) =>
      includeDefaultVpcs ? true : !vpc.IsDefault,
    ).map((vpc: any) => vpc.VpcId),
  );

  yield* deleteEach("VPC(s)", ids, (id) => ec2.deleteVpc({ VpcId: id } as any));
});

const deleteDhcpOptions = Effect.gen(function* () {
  const associatedDhcpOptionsIds = new Set(
    uniq(
      (yield* ec2.describeVpcs({} as any)).Vpcs?.map(
        (vpc: any) => vpc.DhcpOptionsId,
      ),
    ),
  );

  const ids = uniq(
    (yield* ec2.describeDhcpOptions({} as any)).DhcpOptions?.map(
      (dhcpOptions: any) => dhcpOptions.DhcpOptionsId,
    ).filter(
      (id: string) => id !== "default" && !associatedDhcpOptionsIds.has(id),
    ),
  );

  yield* deleteEach("DHCP options set(s)", ids, (id) =>
    ec2.deleteDhcpOptions({ DhcpOptionsId: id } as any),
  );
});

const main = Effect.gen(function* () {
  yield* log(
    [
      `Mode=${execute ? "execute" : "dry-run"}`,
      `Region=${region}`,
      values.profile ? `Profile=${values.profile}` : undefined,
      includeDefaultVpcs ? "Including default VPCs" : "Skipping default VPCs",
    ]
      .filter((value): value is string => !!value)
      .join(" | "),
  );

  for (let pass = 1; pass <= maxPasses; pass++) {
    yield* log(`\n=== Cleanup pass ${pass}/${maxPasses} ===`);

    yield* terminateInstances;
    yield* deleteVpcEndpoints;
    yield* deleteNatGateways;
    yield* deleteNetworkInterfaces;
    yield* releaseElasticIps;
    yield* deleteVpnConnections;
    yield* deleteVpnGateways;
    yield* deleteCustomerGateways;
    yield* deleteVpcPeeringConnections;
    yield* deleteInternetGateways;
    yield* deleteEgressOnlyInternetGateways;
    yield* deleteRouteTables;
    yield* deleteSubnets;
    yield* deleteSecurityGroups;
    yield* deleteNetworkAcls;
    yield* deleteAvailableVolumes;
    yield* deregisterImages;
    yield* deleteSnapshots;
    yield* deleteLaunchTemplates;
    yield* deletePlacementGroups;
    yield* deleteKeyPairs;
    yield* deleteVpcs;
    yield* deleteDhcpOptions;

    if (!execute) {
      yield* log(
        "\nDry-run complete. Re-run with --execute to perform deletions.",
      );
      return;
    }
  }

  yield* log("\nCleanup passes complete.");
});

Effect.runPromise(main.pipe(Effect.provide(runtime))).catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
