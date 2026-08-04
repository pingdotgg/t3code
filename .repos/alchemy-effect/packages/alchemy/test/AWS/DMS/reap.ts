import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Out-of-band orphan reaper for the DMS test suites.
 *
 * `test.provider` scratch stacks keep their state IN MEMORY, so a run that is
 * hard-killed (vitest SIGKILL, outer `timeout`, OOM) between deploy and the
 * `Effect.ensuring(scratch.destroy())` finalizer orphans the whole fixture —
 * VPC, subnets, DMS subnet group, and (for the SLOW-gated test) a replication
 * instance — with no state left to destroy from. A post-wave account nuke
 * found exactly this: a leaked DMS test VPC stack.
 *
 * The reaper finds the fixtures by their DETERMINISTIC VPC CIDRs
 * (`10.91.0.0/16` in ReplicationSubnetGroup.test.ts, `10.92.0.0/16` in
 * ReplicationInstance.test.ts — unique across the test suite) and deletes
 * everything inside dependency-first with typed, idempotent calls:
 * replication instances → subnet groups → ENIs → IGWs → route tables →
 * security groups → subnets → VPC.
 *
 * It runs as a delete-if-exists pre-clean at the top of each test body and as
 * an `Effect.ensuring` finalizer around it, so any run converges the account
 * to zero leftovers regardless of how the previous one ended. A clean account
 * costs one `describeVpcs` call.
 *
 * NOTE: the account-wide `dms-vpc-role` IAM role is owned and cleaned by the
 * ReplicationSubnetGroup provider when Alchemy created it and the last subnet
 * group is gone. The network reaper does not delete foreign/pre-existing IAM
 * roles with that AWS-mandated name.
 */

/** Fixed CIDRs of the DMS test VPCs (see the two test files). */
const VPC_CIDRS = ["10.91.0.0/16", "10.92.0.0/16"];

class OrphanStillPresent extends Data.TaggedError("OrphanStillPresent")<{
  readonly kind: string;
}> {}

/** ~10 minute ceiling for slow asynchronous releases (DMS instance deletes, ENIs). */
const slowRelease = Schedule.max([
  Schedule.spaced("15 seconds"),
  Schedule.recurs(40),
]);
/** ~2 minute ceiling for ordinary dependency-violation races. */
const dependencyRelease = Schedule.max([
  Schedule.spaced("10 seconds"),
  Schedule.recurs(12),
]);

const findTestVpcIds = ec2
  .describeVpcs({ Filters: [{ Name: "cidr", Values: VPC_CIDRS }] })
  .pipe(
    Effect.map((response) =>
      (response.Vpcs ?? []).flatMap((vpc) => (vpc.VpcId ? [vpc.VpcId] : [])),
    ),
  );

/** Count replication instances still placed in the given VPCs. */
const countInstancesIn = (vpcIds: ReadonlySet<string>) =>
  dms.describeReplicationInstances({}).pipe(
    Effect.catchTag("ResourceNotFoundFault", () =>
      Effect.succeed({ ReplicationInstances: [] }),
    ),
    Effect.map(
      (response) =>
        (response.ReplicationInstances ?? []).filter(
          (instance): boolean =>
            !!instance.ReplicationSubnetGroup?.VpcId &&
            vpcIds.has(instance.ReplicationSubnetGroup.VpcId),
        ).length,
    ),
  );

/**
 * Delete any replication instance placed in a test VPC and wait until it is
 * fully gone — its ENIs block subnet/VPC deletion until then.
 */
const reapReplicationInstances = Effect.fn(function* (
  vpcIds: ReadonlySet<string>,
) {
  const response = yield* dms
    .describeReplicationInstances({})
    .pipe(
      Effect.catchTag("ResourceNotFoundFault", () =>
        Effect.succeed({ ReplicationInstances: [] }),
      ),
    );
  const arns = (response.ReplicationInstances ?? [])
    .filter(
      (instance): boolean =>
        !!instance.ReplicationSubnetGroup?.VpcId &&
        vpcIds.has(instance.ReplicationSubnetGroup.VpcId),
    )
    .flatMap((instance) =>
      instance.ReplicationInstanceArn ? [instance.ReplicationInstanceArn] : [],
    );
  yield* Effect.forEach(
    arns,
    (ReplicationInstanceArn) =>
      Effect.logInfo(
        `DMS reap: deleting replication instance ${ReplicationInstanceArn}`,
      ).pipe(
        Effect.andThen(
          dms.deleteReplicationInstance({ ReplicationInstanceArn }),
        ),
        // InvalidResourceStateFault: already deleting — the wait below
        // confirms it actually goes away.
        Effect.catchTag(
          ["ResourceNotFoundFault", "InvalidResourceStateFault"],
          () => Effect.void,
        ),
      ),
    { discard: true },
  );
  if (arns.length > 0) {
    yield* countInstancesIn(vpcIds).pipe(
      Effect.repeat({ schedule: slowRelease, until: (n) => n === 0 }),
      Effect.flatMap((n) =>
        n === 0
          ? Effect.void
          : Effect.fail(
              new OrphanStillPresent({ kind: "DMS replication instances" }),
            ),
      ),
    );
  }
});

/** Delete any replication subnet group whose subnets live in a test VPC. */
const reapSubnetGroups = Effect.fn(function* (vpcIds: ReadonlySet<string>) {
  const response = yield* dms
    .describeReplicationSubnetGroups({})
    .pipe(
      Effect.catchTag("ResourceNotFoundFault", () =>
        Effect.succeed({ ReplicationSubnetGroups: [] }),
      ),
    );
  const identifiers = (response.ReplicationSubnetGroups ?? [])
    .filter((group): boolean => !!group.VpcId && vpcIds.has(group.VpcId))
    .flatMap((group) =>
      group.ReplicationSubnetGroupIdentifier
        ? [group.ReplicationSubnetGroupIdentifier]
        : [],
    );
  yield* Effect.forEach(
    identifiers,
    (ReplicationSubnetGroupIdentifier) =>
      Effect.logInfo(
        `DMS reap: deleting subnet group ${ReplicationSubnetGroupIdentifier}`,
      ).pipe(
        Effect.andThen(
          dms.deleteReplicationSubnetGroup({
            ReplicationSubnetGroupIdentifier,
          }),
        ),
        // InvalidResourceStateFault: an instance is still detaching from the
        // group (instance reap above waits, but deletion lag can linger).
        Effect.retry({
          while: (e): boolean => e._tag === "InvalidResourceStateFault",
          schedule: dependencyRelease,
        }),
        Effect.catchTag("ResourceNotFoundFault", () => Effect.void),
      ),
    { discard: true },
  );
});

/**
 * ENIs (e.g. from a deleted replication instance) release asynchronously and
 * block subnet/VPC deletion. Each pass deletes the ENIs that have reached
 * `available`, then re-counts.
 */
const sweepNetworkInterfaces = Effect.fn(function* (vpcId: string) {
  const describe = ec2
    .describeNetworkInterfaces({
      Filters: [{ Name: "vpc-id", Values: [vpcId] }],
    })
    .pipe(Effect.map((response) => response.NetworkInterfaces ?? []));
  yield* Effect.gen(function* () {
    const enis = yield* describe;
    yield* Effect.forEach(
      enis.filter(
        (eni): boolean =>
          eni.Status === "available" && !!eni.NetworkInterfaceId,
      ),
      (eni) =>
        Effect.logInfo(`DMS reap: deleting ENI ${eni.NetworkInterfaceId}`).pipe(
          Effect.andThen(
            ec2.deleteNetworkInterface({
              NetworkInterfaceId: eni.NetworkInterfaceId,
            }),
          ),
          Effect.catchTag(
            [
              "InvalidNetworkInterfaceID.NotFound",
              "InvalidNetworkInterface.InUse",
            ],
            () => Effect.void,
          ),
        ),
      { discard: true },
    );
    return (yield* describe).length;
  }).pipe(
    Effect.repeat({ schedule: slowRelease, until: (n) => n === 0 }),
    Effect.flatMap((n) =>
      n === 0
        ? Effect.void
        : Effect.fail(
            new OrphanStillPresent({ kind: `network interfaces in ${vpcId}` }),
          ),
    ),
  );
});

const reapVpc = Effect.fn(function* (vpcId: string) {
  yield* Effect.logInfo(`DMS reap: tearing down VPC ${vpcId}`);
  yield* sweepNetworkInterfaces(vpcId);

  // Internet gateways: detach, then delete.
  const igws = yield* ec2
    .describeInternetGateways({
      Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }],
    })
    .pipe(
      Effect.map((response) =>
        (response.InternetGateways ?? []).flatMap((igw) =>
          igw.InternetGatewayId ? [igw.InternetGatewayId] : [],
        ),
      ),
    );
  yield* Effect.forEach(
    igws,
    (InternetGatewayId) =>
      Effect.logInfo(
        `DMS reap: detaching + deleting IGW ${InternetGatewayId}`,
      ).pipe(
        Effect.andThen(
          ec2
            .detachInternetGateway({ InternetGatewayId, VpcId: vpcId })
            .pipe(
              Effect.catchTag(
                ["Gateway.NotAttached", "InvalidInternetGatewayID.NotFound"],
                () => Effect.void,
              ),
            ),
        ),
        Effect.andThen(ec2.deleteInternetGateway({ InternetGatewayId })),
        Effect.retry({
          while: (e): boolean => e._tag === "DependencyViolation",
          schedule: dependencyRelease,
        }),
        Effect.catchTag("InvalidInternetGatewayID.NotFound", () => Effect.void),
      ),
    { discard: true },
  );

  // Non-main route tables: disassociate subnet associations, then delete.
  const routeTables = yield* ec2
    .describeRouteTables({
      Filters: [{ Name: "vpc-id", Values: [vpcId] }],
    })
    .pipe(Effect.map((response) => response.RouteTables ?? []));
  yield* Effect.forEach(
    routeTables,
    (table) =>
      Effect.gen(function* () {
        const associations = table.Associations ?? [];
        if (associations.some((a): boolean => a.Main === true)) return;
        yield* Effect.forEach(
          associations.flatMap((a) =>
            a.RouteTableAssociationId ? [a.RouteTableAssociationId] : [],
          ),
          (AssociationId) =>
            ec2
              .disassociateRouteTable({ AssociationId })
              .pipe(
                Effect.catchTag(
                  "InvalidAssociationID.NotFound",
                  () => Effect.void,
                ),
              ),
          { discard: true },
        );
        if (table.RouteTableId) {
          yield* Effect.logInfo(
            `DMS reap: deleting route table ${table.RouteTableId}`,
          ).pipe(
            Effect.andThen(
              ec2.deleteRouteTable({ RouteTableId: table.RouteTableId }),
            ),
            Effect.retry({
              while: (e): boolean => e._tag === "DependencyViolation",
              schedule: dependencyRelease,
            }),
            Effect.catchTag("InvalidRouteTableID.NotFound", () => Effect.void),
          );
        }
      }),
    { discard: true },
  );

  // Non-default security groups.
  const groups = yield* ec2
    .describeSecurityGroups({
      Filters: [{ Name: "vpc-id", Values: [vpcId] }],
    })
    .pipe(
      Effect.map((response) =>
        (response.SecurityGroups ?? []).filter(
          (group): boolean => group.GroupName !== "default" && !!group.GroupId,
        ),
      ),
    );
  yield* Effect.forEach(
    groups,
    (group) =>
      Effect.logInfo(
        `DMS reap: deleting security group ${group.GroupId} (${group.GroupName})`,
      ).pipe(
        Effect.andThen(ec2.deleteSecurityGroup({ GroupId: group.GroupId })),
        Effect.retry({
          while: (e): boolean => e._tag === "DependencyViolation",
          schedule: dependencyRelease,
        }),
        Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
      ),
    { discard: true },
  );

  // Subnets.
  const subnets = yield* ec2
    .describeSubnets({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] })
    .pipe(
      Effect.map((response) =>
        (response.Subnets ?? []).flatMap((subnet) =>
          subnet.SubnetId ? [subnet.SubnetId] : [],
        ),
      ),
    );
  yield* Effect.forEach(
    subnets,
    (SubnetId) =>
      Effect.logInfo(`DMS reap: deleting subnet ${SubnetId}`).pipe(
        Effect.andThen(ec2.deleteSubnet({ SubnetId })),
        Effect.retry({
          while: (e): boolean => e._tag === "DependencyViolation",
          schedule: dependencyRelease,
        }),
        Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
      ),
    { discard: true },
  );

  yield* ec2.deleteVpc({ VpcId: vpcId }).pipe(
    Effect.retry({
      while: (e): boolean => e._tag === "DependencyViolation",
      schedule: dependencyRelease,
    }),
    Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
  );
});

/**
 * Delete every leftover DMS fixture resource, in dependency order.
 * Idempotent: a run against a clean account is a single `describeVpcs`.
 *
 * Requires the AWS provider environment (available inside `test.provider`
 * bodies; wrap with `Core.withProviders` elsewhere).
 */
export const reapDmsOrphans = Effect.gen(function* () {
  const vpcIdList = yield* findTestVpcIds;
  if (vpcIdList.length === 0) return;
  const vpcIds: ReadonlySet<string> = new Set(vpcIdList);
  yield* reapReplicationInstances(vpcIds);
  yield* reapSubnetGroups(vpcIds);
  yield* Effect.forEach(vpcIdList, reapVpc, { discard: true });
});
