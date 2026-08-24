import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as iam from "@distilled.cloud/aws/iam";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * Orphan reclaim for the Fargate E2E smoke test (`Task.smoke.test.ts`).
 *
 * The smoke test's scratch stack keeps its state IN MEMORY, so a hard-killed
 * run (vitest hard timeout, OOM, SIGKILL) orphans everything it deployed:
 * the `AWS.ECS.Task` resource's out-of-band IAM roles / ECR repository / log
 * group / task-definition family, the `AWS.ECS.Service`'s ALB + target group,
 * and the EC2 networking chain (VPC/IGW/subnets/route tables/security group).
 * Physical names carry a random per-instance suffix, so a later run cannot
 * reclaim them through the engine — this sweep finds them by their
 * DETERMINISTIC name prefixes (mirroring `createPhysicalName`) and by the
 * `alchemy::stack` ownership tag, and deletes them idempotently.
 *
 * Run it BEFORE the test (pre-clean recovers a previously killed run) and as
 * a finalizer AFTER (a passing run leaves ZERO leftovers — including the
 * INACTIVE task-definition revisions that `deregisterTaskDefinition` alone
 * leaves behind).
 */

/**
 * The exact test title — it becomes the scratch stack name (see
 * `sanitizeStackName` in `Test/Core.ts`), which prefixes every physical name
 * this test creates. The smoke test imports this constant so the title and
 * the sweep can never drift apart.
 */
export const E2E_TEST_TITLE =
  "deploys a real Fargate task that serves HTTP and runs a background loop";

/** Deterministic cluster name pinned by the smoke test's `clusterName` prop. */
export const E2E_CLUSTER_NAME = "alchemy-test-ecs-task-e2e";

// Mirror of Test/Core.ts `sanitizeStackName`.
const STACK_NAME = E2E_TEST_TITLE.replaceAll(/[^a-zA-Z0-9_]/g, "-").replace(
  /-+/g,
  "-",
);

const STAGE = "test";

/**
 * Mirror of `createPhysicalName`'s deterministic portion: the full name is
 * `${stack}-${id}-${stage}-${16-char-suffix}` truncated to `maxLength` by
 * slicing the prefix to `maxLength - 16`. Everything before the random
 * suffix is deterministic — that's what we prefix-match on.
 */
const physicalNamePrefix = (
  id: string,
  { maxLength, lowercase = false }: { maxLength: number; lowercase?: boolean },
) => {
  const prefix = `${STACK_NAME}-${id}-${STAGE}-`;
  const sliced =
    prefix.length + 16 > maxLength ? prefix.slice(0, maxLength - 16) : prefix;
  return (lowercase ? sliced.toLowerCase() : sliced).replaceAll(
    lowercase ? /[^a-z0-9-]/g : /[^a-zA-Z0-9-]/g,
    "-",
  );
};

// AWS.ECS.Task out-of-band names (logical id "EcsE2ETask").
const ROLE_PREFIX = physicalNamePrefix("EcsE2ETask-task-role", {
  maxLength: 64,
});
const REPO_PREFIX = physicalNamePrefix("EcsE2ETask-repo", {
  maxLength: 256,
  lowercase: true,
});
const LOG_GROUP_PREFIX = physicalNamePrefix("EcsE2ETask-logs", {
  maxLength: 512,
  lowercase: true,
});
const FAMILY_PREFIX = physicalNamePrefix("EcsE2ETask", {
  maxLength: 255,
  lowercase: true,
});
// AWS.ECS.Service managed ingress (logical id "EcsE2EService"). ALB/TG names
// are capped at 32 chars, so only the first 16 chars are deterministic —
// broad, so matches are additionally verified against the `alchemy::stack`
// tag before deletion.
const ALB_PREFIX = physicalNamePrefix("EcsE2EService-alb", {
  maxLength: 32,
  lowercase: true,
});
const TG_PREFIX = physicalNamePrefix("EcsE2EService-tg", {
  maxLength: 32,
  lowercase: true,
});

/**
 * Bounded wait for the dependency-drain errors every step of the teardown can
 * hit while ECS task / ALB ENIs release (~55s budget per step, only paid when
 * an orphan actually exists).
 */
const drainSchedule = Schedule.spaced("5 seconds");
const DRAIN_ATTEMPTS = 11;

const reclaimEcsCluster = Effect.gen(function* () {
  // Delete any services in the deterministic cluster (force detaches them
  // from the ALB and stops their tasks).
  const serviceArns = yield* ecs
    .listServices({ cluster: E2E_CLUSTER_NAME })
    .pipe(
      Effect.map((r) => r.serviceArns ?? []),
      Effect.catchTag("ClusterNotFoundException", () =>
        Effect.succeed([] as string[]),
      ),
    );
  yield* Effect.forEach(serviceArns, (serviceArn) =>
    ecs
      .deleteService({
        cluster: E2E_CLUSTER_NAME,
        service: serviceArn,
        force: true,
      })
      .pipe(
        Effect.catchTag(
          ["ServiceNotFoundException", "ClusterNotFoundException"],
          () => Effect.void,
        ),
      ),
  );

  // Stop any straggler tasks so the cluster drains quickly.
  const taskArns = yield* ecs.listTasks({ cluster: E2E_CLUSTER_NAME }).pipe(
    Effect.map((r) => r.taskArns ?? []),
    Effect.catchTag("ClusterNotFoundException", () =>
      Effect.succeed([] as string[]),
    ),
  );
  yield* Effect.forEach(taskArns, (taskArn) =>
    ecs
      .stopTask({
        cluster: E2E_CLUSTER_NAME,
        task: taskArn,
        reason: "Task.smoke.test.ts orphan reclaim",
      })
      .pipe(
        Effect.catchTag(
          ["ClusterNotFoundException", "InvalidParameterException"],
          () => Effect.void,
        ),
      ),
  );

  yield* ecs.deleteCluster({ cluster: E2E_CLUSTER_NAME }).pipe(
    Effect.retry({
      while: (e) =>
        e._tag === "ClusterContainsServicesException" ||
        e._tag === "ClusterContainsTasksException" ||
        e._tag === "UpdateInProgressException",
      schedule: drainSchedule,
      times: DRAIN_ATTEMPTS,
    }),
    Effect.catchTag("ClusterNotFoundException", () => Effect.void),
    Effect.asVoid,
  );
});

// True when the resource's ELBv2 tags brand it as owned by this test's stack.
const isOwnedElbResource = (arn: string) =>
  elbv2
    .describeTags({ ResourceArns: [arn] })
    .pipe(
      Effect.map((r) =>
        (r.TagDescriptions?.[0]?.Tags ?? []).some(
          (tag) => tag.Key === "alchemy::stack" && tag.Value === STACK_NAME,
        ),
      ),
    );

const reclaimIngress = Effect.gen(function* () {
  const loadBalancers = yield* elbv2.describeLoadBalancers.items({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  for (const lb of loadBalancers) {
    if (
      !lb.LoadBalancerArn ||
      !lb.LoadBalancerName?.startsWith(ALB_PREFIX) ||
      !(yield* isOwnedElbResource(lb.LoadBalancerArn))
    ) {
      continue;
    }
    yield* elbv2
      .deleteLoadBalancer({ LoadBalancerArn: lb.LoadBalancerArn })
      .pipe(
        Effect.catchTag("LoadBalancerNotFoundException", () => Effect.void),
        Effect.asVoid,
      );
  }

  const targetGroups = yield* elbv2.describeTargetGroups.items({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  for (const tg of targetGroups) {
    if (
      !tg.TargetGroupArn ||
      !tg.TargetGroupName?.startsWith(TG_PREFIX) ||
      !(yield* isOwnedElbResource(tg.TargetGroupArn))
    ) {
      continue;
    }
    // A TG stays in-use until its ALB's deletion propagates.
    yield* elbv2.deleteTargetGroup({ TargetGroupArn: tg.TargetGroupArn }).pipe(
      Effect.retry({
        while: (e) => e._tag === "ResourceInUseException",
        schedule: drainSchedule,
        times: DRAIN_ATTEMPTS,
      }),
      Effect.asVoid,
    );
  }
});

const reclaimNetworking = Effect.gen(function* () {
  const vpcs = yield* ec2
    .describeVpcs({
      Filters: [{ Name: "tag:alchemy::stack", Values: [STACK_NAME] }],
    })
    .pipe(Effect.map((r) => r.Vpcs ?? []));

  for (const vpc of vpcs) {
    const vpcId = vpc.VpcId!;

    // Route tables: disassociate the non-main associations, delete non-main
    // tables.
    const routeTables = yield* ec2
      .describeRouteTables({
        Filters: [{ Name: "vpc-id", Values: [vpcId] }],
      })
      .pipe(Effect.map((r) => r.RouteTables ?? []));
    for (const routeTable of routeTables) {
      const associations = routeTable.Associations ?? [];
      for (const association of associations) {
        if (!association.Main && association.RouteTableAssociationId) {
          yield* ec2
            .disassociateRouteTable({
              AssociationId: association.RouteTableAssociationId,
            })
            .pipe(
              Effect.catchTag(
                "InvalidAssociationID.NotFound",
                () => Effect.void,
              ),
              Effect.asVoid,
            );
        }
      }
      if (
        routeTable.RouteTableId &&
        !associations.some((association) => association.Main)
      ) {
        yield* ec2
          .deleteRouteTable({ RouteTableId: routeTable.RouteTableId })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "DependencyViolation",
              schedule: drainSchedule,
              times: DRAIN_ATTEMPTS,
            }),
            Effect.catchTag("InvalidRouteTableID.NotFound", () => Effect.void),
            Effect.asVoid,
          );
      }
    }

    // Internet gateways: detach, then delete.
    const igws = yield* ec2
      .describeInternetGateways({
        Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }],
      })
      .pipe(Effect.map((r) => r.InternetGateways ?? []));
    for (const igw of igws) {
      if (!igw.InternetGatewayId) continue;
      yield* ec2
        .detachInternetGateway({
          InternetGatewayId: igw.InternetGatewayId,
          VpcId: vpcId,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "DependencyViolation",
            schedule: drainSchedule,
            times: DRAIN_ATTEMPTS,
          }),
          Effect.catchTag(
            ["Gateway.NotAttached", "InvalidInternetGatewayID.NotFound"],
            () => Effect.void,
          ),
          Effect.asVoid,
        );
      yield* ec2
        .deleteInternetGateway({ InternetGatewayId: igw.InternetGatewayId })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "DependencyViolation",
            schedule: drainSchedule,
            times: DRAIN_ATTEMPTS,
          }),
          Effect.catchTag(
            "InvalidInternetGatewayID.NotFound",
            () => Effect.void,
          ),
          Effect.asVoid,
        );
    }

    // Security groups (waits out lingering task/ALB ENIs).
    const securityGroups = yield* ec2
      .describeSecurityGroups({
        Filters: [{ Name: "vpc-id", Values: [vpcId] }],
      })
      .pipe(Effect.map((r) => r.SecurityGroups ?? []));
    for (const securityGroup of securityGroups) {
      if (!securityGroup.GroupId || securityGroup.GroupName === "default") {
        continue;
      }
      yield* ec2.deleteSecurityGroup({ GroupId: securityGroup.GroupId }).pipe(
        Effect.retry({
          while: (e) => e._tag === "DependencyViolation",
          schedule: drainSchedule,
          times: DRAIN_ATTEMPTS,
        }),
        Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
        Effect.asVoid,
      );
    }

    // Subnets.
    const subnets = yield* ec2
      .describeSubnets({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] })
      .pipe(Effect.map((r) => r.Subnets ?? []));
    for (const subnet of subnets) {
      if (!subnet.SubnetId) continue;
      yield* ec2.deleteSubnet({ SubnetId: subnet.SubnetId }).pipe(
        Effect.retry({
          while: (e) => e._tag === "DependencyViolation",
          schedule: drainSchedule,
          times: DRAIN_ATTEMPTS,
        }),
        Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
        Effect.asVoid,
      );
    }

    yield* ec2.deleteVpc({ VpcId: vpcId }).pipe(
      Effect.retry({
        while: (e) => e._tag === "DependencyViolation",
        schedule: drainSchedule,
        times: DRAIN_ATTEMPTS,
      }),
      Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
      Effect.asVoid,
    );
  }

  // The smoke fixture normally reuses the standing default VPC, so its
  // test-owned security group is not nested under a test-owned VPC above.
  // Select it by the exact stack tag and leave every shared/default group
  // untouched.
  const ownedSecurityGroups = yield* ec2
    .describeSecurityGroups({
      Filters: [{ Name: "tag:alchemy::stack", Values: [STACK_NAME] }],
    })
    .pipe(Effect.map((r) => r.SecurityGroups ?? []));
  for (const securityGroup of ownedSecurityGroups) {
    if (!securityGroup.GroupId || securityGroup.GroupName === "default") {
      continue;
    }
    yield* ec2.deleteSecurityGroup({ GroupId: securityGroup.GroupId }).pipe(
      Effect.retry({
        while: (e) => e._tag === "DependencyViolation",
        schedule: drainSchedule,
        times: DRAIN_ATTEMPTS,
      }),
      Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
      Effect.asVoid,
    );
  }
});

const reclaimEcrRepositories = Effect.gen(function* () {
  const repositories = yield* ecr.describeRepositories.items({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  for (const repository of repositories) {
    if (!repository.repositoryName?.startsWith(REPO_PREFIX)) continue;
    yield* ecr
      .deleteRepository({
        repositoryName: repository.repositoryName,
        force: true,
      })
      .pipe(
        Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
        Effect.asVoid,
      );
  }
});

const reclaimLogGroups = Effect.gen(function* () {
  const logGroups = yield* logs
    .describeLogGroups({ logGroupNamePrefix: LOG_GROUP_PREFIX })
    .pipe(Effect.map((r) => r.logGroups ?? []));
  for (const logGroup of logGroups) {
    if (!logGroup.logGroupName) continue;
    yield* logs.deleteLogGroup({ logGroupName: logGroup.logGroupName }).pipe(
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      Effect.asVoid,
    );
  }
});

const reclaimIamRoles = Effect.gen(function* () {
  const roles = yield* iam.listRoles.items({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  for (const role of roles) {
    const roleName = role.RoleName;
    if (!roleName?.startsWith(ROLE_PREFIX)) continue;

    const inlinePolicies = yield* iam
      .listRolePolicies({ RoleName: roleName })
      .pipe(
        Effect.map((r) => r.PolicyNames ?? []),
        Effect.catchTag("NoSuchEntityException", () =>
          Effect.succeed([] as string[]),
        ),
      );
    yield* Effect.forEach(inlinePolicies, (policyName) =>
      iam
        .deleteRolePolicy({ RoleName: roleName, PolicyName: policyName })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void)),
    );

    const attached = yield* iam
      .listAttachedRolePolicies({ RoleName: roleName })
      .pipe(
        Effect.map((r) => r.AttachedPolicies ?? []),
        Effect.catchTag("NoSuchEntityException", () => Effect.succeed([])),
      );
    yield* Effect.forEach(attached, (policy) =>
      iam
        .detachRolePolicy({ RoleName: roleName, PolicyArn: policy.PolicyArn! })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void)),
    );

    yield* iam.deleteRole({ RoleName: roleName }).pipe(
      Effect.catchTag("NoSuchEntityException", () => Effect.void),
      Effect.asVoid,
    );
  }
});

/**
 * Every task-definition family this test ever created (each run mints a
 * fresh random-suffixed family). NOTE: `listTaskDefinitionFamilies` is a
 * true prefix match; `listTaskDefinitions`' `familyPrefix` only matches the
 * EXACT family name (verified live), so families must be enumerated first.
 */
const listE2EFamilies = ecs.listTaskDefinitionFamilies
  .items({ familyPrefix: FAMILY_PREFIX, status: "ALL" })
  .pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

const listFamilyArns = (family: string, status: "ACTIVE" | "INACTIVE") =>
  ecs
    .listTaskDefinitions({ familyPrefix: family, status })
    .pipe(Effect.map((r) => r.taskDefinitionArns ?? []));

const reclaimTaskDefinitions = Effect.gen(function* () {
  const families = yield* listE2EFamilies;
  for (const family of families) {
    const active = yield* listFamilyArns(family, "ACTIVE");
    yield* Effect.forEach(active, (arn) =>
      ecs
        .deregisterTaskDefinition({ taskDefinition: arn })
        .pipe(Effect.catchTag("ClientException", () => Effect.void)),
    );

    const inactive = yield* listFamilyArns(family, "INACTIVE");
    for (let i = 0; i < inactive.length; i += 10) {
      yield* ecs
        .deleteTaskDefinitions({ taskDefinitions: inactive.slice(i, i + 10) })
        .pipe(Effect.catchTag("ClientException", () => Effect.void));
    }
  }
});

/**
 * Idempotent full sweep, ordered so dependencies drain before their
 * dependents are deleted: ECS service/cluster → ALB/TG → EC2 networking →
 * ECR → log groups → IAM roles → task-definition revisions.
 */
export const reclaimTaskE2EOrphans = Effect.gen(function* () {
  yield* reclaimEcsCluster;
  yield* reclaimIngress;
  yield* reclaimNetworking;
  yield* reclaimEcrRepositories;
  yield* reclaimLogGroups;
  yield* reclaimIamRoles;
  yield* reclaimTaskDefinitions;
});

/**
 * Read-only clean-slate audit: every cloud resource the smoke test can
 * possibly leave behind, as human-readable identifiers. The smoke test
 * asserts this is EMPTY after teardown, proving a passing run leaves zero
 * leftovers.
 */
export const scanTaskE2EOrphans = Effect.gen(function* () {
  const leftovers: string[] = [];

  const clusters = yield* ecs
    .describeClusters({ clusters: [E2E_CLUSTER_NAME] })
    .pipe(Effect.map((r) => r.clusters ?? []));
  for (const cluster of clusters) {
    if (cluster.status === "ACTIVE") {
      leftovers.push(`ecs cluster ${cluster.clusterName}`);
    }
  }

  const loadBalancers = yield* elbv2.describeLoadBalancers.items({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  for (const lb of loadBalancers) {
    if (
      lb.LoadBalancerArn &&
      lb.LoadBalancerName?.startsWith(ALB_PREFIX) &&
      (yield* isOwnedElbResource(lb.LoadBalancerArn))
    ) {
      leftovers.push(`load balancer ${lb.LoadBalancerName}`);
    }
  }
  const targetGroups = yield* elbv2.describeTargetGroups.items({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  for (const tg of targetGroups) {
    if (
      tg.TargetGroupArn &&
      tg.TargetGroupName?.startsWith(TG_PREFIX) &&
      (yield* isOwnedElbResource(tg.TargetGroupArn))
    ) {
      leftovers.push(`target group ${tg.TargetGroupName}`);
    }
  }

  const vpcs = yield* ec2
    .describeVpcs({
      Filters: [{ Name: "tag:alchemy::stack", Values: [STACK_NAME] }],
    })
    .pipe(Effect.map((r) => r.Vpcs ?? []));
  for (const vpc of vpcs) {
    leftovers.push(`vpc ${vpc.VpcId}`);
  }
  const securityGroups = yield* ec2
    .describeSecurityGroups({
      Filters: [{ Name: "tag:alchemy::stack", Values: [STACK_NAME] }],
    })
    .pipe(Effect.map((r) => r.SecurityGroups ?? []));
  for (const securityGroup of securityGroups) {
    leftovers.push(`security group ${securityGroup.GroupId}`);
  }

  const repositories = yield* ecr.describeRepositories.items({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  for (const repository of repositories) {
    if (repository.repositoryName?.startsWith(REPO_PREFIX)) {
      leftovers.push(`ecr repository ${repository.repositoryName}`);
    }
  }

  const logGroups = yield* logs
    .describeLogGroups({ logGroupNamePrefix: LOG_GROUP_PREFIX })
    .pipe(Effect.map((r) => r.logGroups ?? []));
  for (const logGroup of logGroups) {
    leftovers.push(`log group ${logGroup.logGroupName}`);
  }

  const roles = yield* iam.listRoles.items({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );
  for (const role of roles) {
    if (role.RoleName?.startsWith(ROLE_PREFIX)) {
      leftovers.push(`iam role ${role.RoleName}`);
    }
  }

  const families = yield* listE2EFamilies;
  for (const family of families) {
    for (const status of ["ACTIVE", "INACTIVE"] as const) {
      const arns = yield* listFamilyArns(family, status);
      for (const arn of arns) {
        leftovers.push(`task definition ${arn}`);
      }
    }
  }

  return leftovers;
});
