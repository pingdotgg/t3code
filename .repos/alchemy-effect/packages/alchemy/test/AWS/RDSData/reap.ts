import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as iam from "@distilled.cloud/aws/iam";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as rds from "@distilled.cloud/aws/rds";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * Out-of-band orphan reaper for the RDSData bindings fixture.
 *
 * The suite's scratch stack keeps its state IN MEMORY, so a run that dies
 * between deploy and a completed destroy (Aurora SV2 provisioning/teardown
 * runs 10+ minutes — an easy target for a killed process) orphans the whole
 * fixture with no state left to destroy from. This reaper finds fixture
 * resources by their deterministic physical-name prefix (`RDSDataBindings-`,
 * from `createPhysicalName`'s `{stack}-{id}-{stage}-` scheme) and the
 * `alchemy::stack` ownership tag / fixed `10.61.0.0/16` CIDR for EC2, and
 * deletes them with typed, idempotent calls.
 *
 * It runs as a pre-clean in `beforeAll` (before deploy) and as an
 * `Effect.ensuring` finalizer in `afterAll` (even when destroy fails), so a
 * SLOW run converges to zero leftovers regardless of how the previous run
 * ended. Every delete catches its not-found tag; bounded retries cover
 * `DependencyViolation` (Lambda ENIs release asynchronously after function
 * deletion) and in-flight RDS state transitions.
 */

/** Stack name of the scratch stack in Bindings.test.ts. */
const STACK = "RDSDataBindings";
/** Physical names are `{stack}-{id}-{stage}-{suffix}`; RDS lowercases identifiers. */
const PREFIX = `${STACK.toLowerCase()}-`;
/** The fixture VPC's deterministic CIDR (see infra.ts). */
const VPC_CIDR = "10.61.0.0/16";

const matches = (name: string | undefined): name is string =>
  !!name && name.toLowerCase().startsWith(PREFIX);

class OrphanStillPresent extends Data.TaggedError("OrphanStillPresent")<{
  readonly kind: string;
}> {}

/** ~10 minute ceiling for slow asynchronous releases (RDS deletes, Lambda ENIs). */
const slowRelease = Schedule.max([
  Schedule.spaced("15 seconds"),
  Schedule.recurs(40),
]);
/** ~2 minute ceiling for ordinary dependency-violation races. */
const dependencyRelease = Schedule.max([
  Schedule.spaced("10 seconds"),
  Schedule.recurs(12),
]);

const reapFunctions = Effect.gen(function* () {
  const pages = yield* lambda.listFunctions.pages({}).pipe(Stream.runCollect);
  const names = Array.from(pages)
    .flatMap((page) => page.Functions ?? [])
    .map((fn) => fn.FunctionName)
    .filter(matches);
  yield* Effect.forEach(
    names,
    (FunctionName) =>
      Effect.logInfo(
        `RDSData reap: deleting Lambda function ${FunctionName}`,
      ).pipe(
        Effect.andThen(lambda.deleteFunction({ FunctionName })),
        Effect.retry({
          while: (e) =>
            e._tag === "ResourceConflictException" ||
            e._tag === "TooManyRequestsException",
          schedule: dependencyRelease,
        }),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      ),
    { discard: true },
  );
});

const reapLogGroups = Effect.gen(function* () {
  const pages = yield* logs.describeLogGroups
    .pages({ logGroupNamePrefix: `/aws/lambda/${STACK}-` })
    .pipe(Stream.runCollect);
  const names = Array.from(pages)
    .flatMap((page) => page.logGroups ?? [])
    .flatMap((group) => (group.logGroupName ? [group.logGroupName] : []));
  yield* Effect.forEach(
    names,
    (logGroupName) =>
      Effect.logInfo(`RDSData reap: deleting log group ${logGroupName}`).pipe(
        Effect.andThen(logs.deleteLogGroup({ logGroupName })),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      ),
    { discard: true },
  );
});

const reapRoles = Effect.gen(function* () {
  const pages = yield* iam.listRoles.pages({}).pipe(Stream.runCollect);
  const names = Array.from(pages)
    .flatMap((page) => page.Roles ?? [])
    .map((role) => role.RoleName)
    .filter(matches);
  yield* Effect.forEach(
    names,
    (RoleName) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`RDSData reap: deleting IAM role ${RoleName}`);
        const attached = yield* iam.listAttachedRolePolicies
          .pages({ RoleName })
          .pipe(Stream.runCollect);
        yield* Effect.forEach(
          Array.from(attached)
            .flatMap((page) => page.AttachedPolicies ?? [])
            .flatMap((policy) => (policy.PolicyArn ? [policy.PolicyArn] : [])),
          (PolicyArn) =>
            iam
              .detachRolePolicy({ RoleName, PolicyArn })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              ),
          { discard: true },
        );
        const inline = yield* iam.listRolePolicies
          .pages({ RoleName })
          .pipe(Stream.runCollect);
        yield* Effect.forEach(
          Array.from(inline).flatMap((page) => page.PolicyNames ?? []),
          (PolicyName) =>
            iam
              .deleteRolePolicy({ RoleName, PolicyName })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              ),
          { discard: true },
        );
        yield* iam.deleteRole({ RoleName }).pipe(
          Effect.retry({
            while: (e) => e._tag === "DeleteConflictException",
            schedule: dependencyRelease,
          }),
          Effect.catchTag("NoSuchEntityException", () => Effect.void),
        );
      }).pipe(
        // The role may vanish between the list and the detach walk.
        Effect.catchTag("NoSuchEntityException", () => Effect.void),
      ),
    { discard: true },
  );
});

const countDbInstances = rds.describeDBInstances.pages({}).pipe(
  Stream.runCollect,
  Effect.map(
    (pages) =>
      Array.from(pages)
        .flatMap((page) => page.DBInstances ?? [])
        .filter((instance) => matches(instance.DBInstanceIdentifier)).length,
  ),
);

const reapDbInstances = Effect.gen(function* () {
  const pages = yield* rds.describeDBInstances
    .pages({})
    .pipe(Stream.runCollect);
  const ids = Array.from(pages)
    .flatMap((page) => page.DBInstances ?? [])
    .map((instance) => instance.DBInstanceIdentifier)
    .filter(matches);
  yield* Effect.forEach(
    ids,
    (id) =>
      Effect.logInfo(`RDSData reap: deleting DB instance ${id}`).pipe(
        Effect.andThen(
          rds.deleteDBInstance({
            DBInstanceIdentifier: id,
            SkipFinalSnapshot: true,
            DeleteAutomatedBackups: true,
          }),
        ),
        // InvalidDBInstanceStateFault: already deleting — the wait below
        // confirms it actually goes away.
        Effect.catchTag(
          ["DBInstanceNotFoundFault", "InvalidDBInstanceStateFault"],
          () => Effect.void,
        ),
      ),
    { discard: true },
  );
  if (ids.length > 0) {
    yield* countDbInstances.pipe(
      Effect.repeat({ schedule: slowRelease, until: (n) => n === 0 }),
      Effect.flatMap((n) =>
        n === 0
          ? Effect.void
          : Effect.fail(new OrphanStillPresent({ kind: "RDS DB instances" })),
      ),
    );
  }
});

const countDbClusters = rds.describeDBClusters.pages({}).pipe(
  Stream.runCollect,
  Effect.map(
    (pages) =>
      Array.from(pages)
        .flatMap((page) => page.DBClusters ?? [])
        .filter((cluster) => matches(cluster.DBClusterIdentifier)).length,
  ),
);

const reapDbClusters = Effect.gen(function* () {
  const pages = yield* rds.describeDBClusters.pages({}).pipe(Stream.runCollect);
  const ids = Array.from(pages)
    .flatMap((page) => page.DBClusters ?? [])
    .map((cluster) => cluster.DBClusterIdentifier)
    .filter(matches);
  yield* Effect.forEach(
    ids,
    (id) =>
      Effect.logInfo(`RDSData reap: deleting DB cluster ${id}`).pipe(
        Effect.andThen(
          rds.deleteDBCluster({
            DBClusterIdentifier: id,
            SkipFinalSnapshot: true,
          }),
        ),
        // InvalidDBClusterStateFault: already deleting / member still
        // detaching — the wait below confirms convergence either way.
        Effect.catchTag(
          ["DBClusterNotFoundFault", "InvalidDBClusterStateFault"],
          () => Effect.void,
        ),
      ),
    { discard: true },
  );
  if (ids.length > 0) {
    yield* countDbClusters.pipe(
      Effect.repeat({ schedule: slowRelease, until: (n) => n === 0 }),
      Effect.flatMap((n) =>
        n === 0
          ? Effect.void
          : Effect.fail(new OrphanStillPresent({ kind: "RDS DB clusters" })),
      ),
    );
  }
});

const reapDbSubnetGroups = Effect.gen(function* () {
  const pages = yield* rds.describeDBSubnetGroups
    .pages({})
    .pipe(Stream.runCollect);
  const names = Array.from(pages)
    .flatMap((page) => page.DBSubnetGroups ?? [])
    .map((group) => group.DBSubnetGroupName)
    .filter(matches);
  yield* Effect.forEach(
    names,
    (name) =>
      Effect.logInfo(`RDSData reap: deleting DB subnet group ${name}`).pipe(
        Effect.andThen(rds.deleteDBSubnetGroup({ DBSubnetGroupName: name })),
        Effect.retry({
          while: (e) => e._tag === "InvalidDBSubnetGroupStateFault",
          schedule: dependencyRelease,
        }),
        Effect.catchTag("DBSubnetGroupNotFoundFault", () => Effect.void),
      ),
    { discard: true },
  );
});

const reapSecrets = Effect.gen(function* () {
  const pages = yield* secretsmanager.listSecrets
    .pages({
      IncludePlannedDeletion: true,
      Filters: [{ Key: "name", Values: [STACK] }],
    })
    .pipe(Stream.runCollect);
  const names = Array.from(pages)
    .flatMap((page) => page.SecretList ?? [])
    .map((secret) => secret.Name)
    .filter(matches);
  yield* Effect.forEach(
    names,
    (name) =>
      Effect.logInfo(`RDSData reap: force-deleting secret ${name}`).pipe(
        Effect.andThen(
          secretsmanager.deleteSecret({
            SecretId: name,
            ForceDeleteWithoutRecovery: true,
          }),
        ),
        // InvalidRequestException: deletion already in progress.
        Effect.catchTag(
          ["ResourceNotFoundException", "InvalidRequestException"],
          () => Effect.void,
        ),
      ),
    { discard: true },
  );
});

/**
 * Lambda-managed ENIs release asynchronously (minutes) after their function
 * is deleted; they block SG/subnet/VPC deletion until then. Each pass deletes
 * the ENIs that have reached `available`, then re-counts.
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
        (eni) => eni.Status === "available" && eni.NetworkInterfaceId,
      ),
      (eni) =>
        Effect.logInfo(
          `RDSData reap: deleting ENI ${eni.NetworkInterfaceId}`,
        ).pipe(
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
  yield* Effect.logInfo(`RDSData reap: tearing down VPC ${vpcId}`);
  yield* sweepNetworkInterfaces(vpcId);

  // Security groups: break the LambdaSG <- DbSG ingress cross-reference
  // first, then delete (bounded DependencyViolation retry).
  const groups = yield* ec2
    .describeSecurityGroups({
      Filters: [{ Name: "vpc-id", Values: [vpcId] }],
    })
    .pipe(
      Effect.map((response) =>
        (response.SecurityGroups ?? []).filter(
          (group) => group.GroupName !== "default" && group.GroupId,
        ),
      ),
    );
  yield* Effect.forEach(
    groups,
    (group) =>
      (group.IpPermissions ?? []).length > 0
        ? ec2
            .revokeSecurityGroupIngress({
              GroupId: group.GroupId,
              IpPermissions: group.IpPermissions,
            })
            .pipe(
              Effect.catchTag(
                ["InvalidGroup.NotFound", "InvalidPermission.NotFound"],
                () => Effect.void,
              ),
            )
        : Effect.void,
    { discard: true },
  );
  yield* Effect.forEach(
    groups,
    (group) =>
      Effect.logInfo(
        `RDSData reap: deleting security group ${group.GroupId} (${group.GroupName})`,
      ).pipe(
        Effect.andThen(ec2.deleteSecurityGroup({ GroupId: group.GroupId })),
        Effect.retry({
          while: (e) => e._tag === "DependencyViolation",
          schedule: dependencyRelease,
        }),
        Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
      ),
    { discard: true },
  );

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
      Effect.logInfo(`RDSData reap: deleting subnet ${SubnetId}`).pipe(
        Effect.andThen(ec2.deleteSubnet({ SubnetId })),
        Effect.retry({
          while: (e) => e._tag === "DependencyViolation",
          schedule: dependencyRelease,
        }),
        Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
      ),
    { discard: true },
  );

  yield* ec2.deleteVpc({ VpcId: vpcId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "DependencyViolation",
      schedule: dependencyRelease,
    }),
    Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
  );
});

const reapVpcs = Effect.gen(function* () {
  const byTag = yield* ec2.describeVpcs({
    Filters: [{ Name: "tag:alchemy::stack", Values: [STACK] }],
  });
  const byCidr = yield* ec2.describeVpcs({
    Filters: [{ Name: "cidr", Values: [VPC_CIDR] }],
  });
  const vpcIds = [
    ...new Set(
      [...(byTag.Vpcs ?? []), ...(byCidr.Vpcs ?? [])].flatMap((vpc) =>
        vpc.VpcId ? [vpc.VpcId] : [],
      ),
    ),
  ];
  yield* Effect.forEach(vpcIds, reapVpc, { discard: true });
});

/**
 * Delete every leftover RDSData fixture resource, in dependency order.
 * Idempotent: a run against a clean account is a handful of empty list calls.
 *
 * Requires the AWS provider environment (wrap with `Core.withProviders`).
 */
export const reapRDSDataOrphans = Effect.gen(function* () {
  yield* reapFunctions;
  yield* reapLogGroups;
  yield* reapRoles;
  yield* reapDbInstances;
  yield* reapDbClusters;
  yield* reapDbSubnetGroups;
  yield* reapSecrets;
  yield* reapVpcs;
});
