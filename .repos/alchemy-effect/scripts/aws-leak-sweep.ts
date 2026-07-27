#!/usr/bin/env bun
/**
 * AWS leak sweep — finds (and optionally deletes) alchemy-tagged TEST resources
 * left behind by crashed/interrupted test runs.
 *
 * Discovery is tag-driven: every alchemy resource is branded with
 * `alchemy::stack` / `alchemy::stage` / `alchemy::id` (see src/Tags.ts
 * createInternalTags). Test suites deploy with stage `"test"` (the default in
 * packages/alchemy/src/Test/Core.ts), so we sweep everything tagged
 * `alchemy::stage = test`.
 *
 * Primary discovery path: resourcegroupstaggingapi GetResources (regional).
 * Fallbacks for resources the tagging API can't see from a regional query:
 *   - IAM roles/policies (global service): listRoles/listPolicies + tag reads
 *   - EventBridge Scheduler schedules (not taggable): name-pattern heuristic
 *     (physical names embed `-{stage}-`, see src/PhysicalName.ts)
 *
 * Usage:
 *   bun scripts/aws-leak-sweep.ts                      # DRY RUN (default)
 *   bun scripts/aws-leak-sweep.ts --delete             # actually delete
 *   bun scripts/aws-leak-sweep.ts --older-than 12      # only >= 12h old (default 6)
 *   bun scripts/aws-leak-sweep.ts --stage test         # tag stage filter (default test)
 *   bun scripts/aws-leak-sweep.ts --region us-west-2   # region (default env or us-west-2)
 *
 * KMS keys are ALWAYS report-only — never deleted by this tool.
 * Resources whose age can't be determined are treated as eligible (a leak with
 * an unknown birthday is still a leak) and shown with age `?`.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { FetchHttpClient } from "effect/unstable/http";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { fromChain } from "../distilled/packages/aws/src/credentials.ts";
import { Region } from "../distilled/packages/aws/src/region.ts";

import * as Logs from "../distilled/packages/aws/src/services/cloudwatch-logs.ts";
import * as DynamoDB from "../distilled/packages/aws/src/services/dynamodb.ts";
import * as EC2 from "../distilled/packages/aws/src/services/ec2.ts";
import * as ECS from "../distilled/packages/aws/src/services/ecs.ts";
import * as EFS from "../distilled/packages/aws/src/services/efs.ts";
import * as ELBv2 from "../distilled/packages/aws/src/services/elastic-load-balancing-v2.ts";
import * as EventBridge from "../distilled/packages/aws/src/services/eventbridge.ts";
import * as IAM from "../distilled/packages/aws/src/services/iam.ts";
import * as Kinesis from "../distilled/packages/aws/src/services/kinesis.ts";
import * as KMS from "../distilled/packages/aws/src/services/kms.ts";
import * as Lambda from "../distilled/packages/aws/src/services/lambda.ts";
import * as RDS from "../distilled/packages/aws/src/services/rds.ts";
import {
  getResources,
  type GetResourcesOutput,
} from "../distilled/packages/aws/src/services/resource-groups-tagging-api.ts";
import * as S3 from "../distilled/packages/aws/src/services/s3.ts";
import * as Scheduler from "../distilled/packages/aws/src/services/scheduler.ts";
import * as SecretsManager from "../distilled/packages/aws/src/services/secrets-manager.ts";
import * as SNS from "../distilled/packages/aws/src/services/sns.ts";
import * as SQS from "../distilled/packages/aws/src/services/sqs.ts";
import * as SSM from "../distilled/packages/aws/src/services/ssm.ts";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Args {
  delete: boolean;
  olderThanHours: number;
  stage: string;
  region: string;
}

const parseArgs = Effect.sync((): Args => {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(`--${name}`);
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    delete: flag("delete"),
    olderThanHours: Number(opt("older-than") ?? 6),
    stage: opt("stage") ?? "test",
    region:
      opt("region") ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      "us-west-2",
  };
});

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type Env =
  | import("../distilled/packages/aws/src/credentials.ts").Credentials
  | Region
  | HttpClient.HttpClient;

interface Leak {
  arn: string;
  /** display kind, e.g. "sqs:queue" */
  kind: string;
  /** physical name / identifier used by delete calls */
  name: string;
  tags: Record<string, string>;
  createdAt: Date | undefined;
  hourly: boolean;
  reportOnly: boolean;
  reportOnlyReason?: string;
  /** deletion ordering: lower phases first */
  phase: number;
}

const toDate = (v: Date | string | number | undefined): Date | undefined => {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    // seconds vs millis
    return new Date(v > 10_000_000_000 ? v : v * 1000);
  }
  const n = Number(v);
  if (!Number.isNaN(n) && v.trim() !== "") {
    return new Date(n > 10_000_000_000 ? n : n * 1000);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const ageHours = (d: Date | undefined): number | undefined =>
  d === undefined ? undefined : (Date.now() - d.getTime()) / 3_600_000;

const tagRecord = (
  tags: readonly { Key?: string; Value?: string }[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter((t) => t.Key !== undefined)
      .map((t) => [t.Key as string, t.Value ?? ""]),
  );

/** best-effort: any failure (missing perms, races, region mismatch) -> undefined */
const tryDate = <E, R>(
  eff: Effect.Effect<Date | string | number | undefined, E, R>,
): Effect.Effect<Date | undefined, never, R> =>
  eff.pipe(
    Effect.map(toDate),
    Effect.catch(() => Effect.succeed(undefined)),
  );

// ---------------------------------------------------------------------------
// ARN classification
// ---------------------------------------------------------------------------

interface Parsed {
  service: string;
  region: string;
  account: string;
  rest: string;
}

const parseArn = (arn: string): Parsed | undefined => {
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return undefined;
  return {
    service: parts[2],
    region: parts[3],
    account: parts[4],
    rest: parts.slice(5).join(":"),
  };
};

interface Classified {
  kind: string;
  name: string;
  hourly: boolean;
  reportOnly: boolean;
  reportOnlyReason?: string;
  phase: number;
}

const classify = (arn: string): Classified => {
  const p = parseArn(arn);
  const unsupported = (reason: string): Classified => ({
    kind: `${p?.service ?? "?"}:?`,
    name: p?.rest ?? arn,
    hourly: false,
    reportOnly: true,
    reportOnlyReason: reason,
    phase: 99,
  });
  if (!p) return unsupported("unparseable arn");
  const r = p.rest;
  const mk = (
    kind: string,
    name: string,
    phase: number,
    opts?: { hourly?: boolean; reportOnly?: boolean; reason?: string },
  ): Classified => ({
    kind,
    name,
    phase,
    hourly: opts?.hourly ?? false,
    reportOnly: opts?.reportOnly ?? false,
    reportOnlyReason: opts?.reason,
  });

  switch (p.service) {
    case "sqs":
      return mk("sqs:queue", r, 2);
    case "sns":
      return mk("sns:topic", r, 2);
    case "dynamodb":
      if (r.startsWith("table/") && !r.includes("/stream/")) {
        return mk("dynamodb:table", r.slice("table/".length), 2);
      }
      return unsupported("only tables are swept");
    case "lambda":
      if (r.startsWith("function:")) {
        return mk("lambda:function", r.split(":")[1], 2);
      }
      return unsupported("only functions are swept");
    case "logs":
      if (r.startsWith("log-group:")) {
        return mk(
          "logs:log-group",
          r.slice("log-group:".length).replace(/:\*$/, ""),
          2,
        );
      }
      return unsupported("only log groups are swept");
    case "s3":
      return mk("s3:bucket", r, 2);
    case "kinesis":
      if (r.startsWith("stream/")) {
        return mk("kinesis:stream", r.slice("stream/".length), 2);
      }
      return unsupported("only streams are swept");
    case "events": {
      if (r.startsWith("rule/")) {
        return mk("events:rule", r.slice("rule/".length), 1);
      }
      if (r.startsWith("event-bus/")) {
        return mk("events:event-bus", r.slice("event-bus/".length), 3);
      }
      return unsupported("only rules and buses are swept");
    }
    case "ecs": {
      if (r.startsWith("service/")) return mk("ecs:service", r, 1);
      if (r.startsWith("cluster/")) {
        return mk("ecs:cluster", r.slice("cluster/".length), 3);
      }
      if (r.startsWith("task-definition/")) {
        return mk(
          "ecs:task-definition",
          r.slice("task-definition/".length),
          2,
        );
      }
      if (r.startsWith("task/")) {
        return mk("ecs:task", r, 99, {
          reportOnly: true,
          reason: "tasks die with their service/cluster",
        });
      }
      return unsupported("unhandled ecs type");
    }
    case "elasticloadbalancing": {
      if (r.startsWith("loadbalancer/")) {
        return mk("elbv2:load-balancer", arn, 3, { hourly: true });
      }
      if (r.startsWith("targetgroup/")) {
        return mk("elbv2:target-group", arn, 4);
      }
      if (r.startsWith("listener/")) {
        return mk("elbv2:listener", arn, 99, {
          reportOnly: true,
          reason: "listeners die with their load balancer",
        });
      }
      return unsupported("unhandled elb type");
    }
    case "ec2": {
      if (r.startsWith("natgateway/")) {
        return mk("ec2:nat-gateway", r.slice("natgateway/".length), 3, {
          hourly: true,
        });
      }
      if (r.startsWith("elastic-ip/")) {
        return mk("ec2:elastic-ip", r.slice("elastic-ip/".length), 4, {
          hourly: true,
        });
      }
      if (r.startsWith("vpc/")) {
        return mk("ec2:vpc", r.slice("vpc/".length), 5);
      }
      // subnets, route tables, IGWs, SGs etc. are swept as part of their
      // VPC's teardown; report them so nothing is silently ignored.
      return mk(`ec2:${r.split("/")[0]}`, r, 99, {
        reportOnly: true,
        reason: "deleted as part of the owning VPC's teardown",
      });
    }
    case "rds": {
      if (r.startsWith("db:")) {
        return mk("rds:instance", r.slice("db:".length), 2, { hourly: true });
      }
      if (r.startsWith("cluster:")) {
        return mk("rds:cluster", r.slice("cluster:".length), 3, {
          hourly: true,
        });
      }
      return mk(`rds:${r.split(":")[0]}`, r, 99, {
        reportOnly: true,
        reason: "only instances/clusters are swept",
      });
    }
    case "elasticfilesystem": {
      if (r.startsWith("file-system/")) {
        return mk("efs:file-system", r.slice("file-system/".length), 2);
      }
      return unsupported("only file systems are swept");
    }
    case "kms":
      if (r.startsWith("key/")) {
        return mk("kms:key", r.slice("key/".length), 99, {
          reportOnly: true,
          reason: "KMS keys are NEVER deleted by this tool",
        });
      }
      return unsupported("only keys are reported");
    case "secretsmanager":
      if (r.startsWith("secret:")) {
        return mk("secretsmanager:secret", arn, 2);
      }
      return unsupported("only secrets are swept");
    case "ssm":
      if (r.startsWith("parameter/")) {
        const raw = r.slice("parameter/".length);
        return mk("ssm:parameter", raw.includes("/") ? `/${raw}` : raw, 2);
      }
      return unsupported("only parameters are swept");
    case "scheduler": {
      if (r.startsWith("schedule/")) {
        return mk("scheduler:schedule", r.slice("schedule/".length), 1);
      }
      if (r.startsWith("schedule-group/")) {
        return mk(
          "scheduler:schedule-group",
          r.slice("schedule-group/".length),
          3,
        );
      }
      return unsupported("unhandled scheduler type");
    }
    case "iam": {
      if (r.startsWith("role/")) {
        return mk("iam:role", r.slice("role/".length).split("/").pop()!, 4);
      }
      if (r.startsWith("policy/")) {
        return mk("iam:policy", arn, 4);
      }
      return unsupported("only roles/policies are swept");
    }
    default:
      return unsupported("no sweep handler for this service");
  }
};

// ---------------------------------------------------------------------------
// Age enrichment (best-effort, one describe per resource)
// ---------------------------------------------------------------------------

const sqsQueueUrl = (leak: Leak, region: string): string => {
  const p = parseArn(leak.arn)!;
  return `https://sqs.${region}.amazonaws.com/${p.account}/${leak.name}`;
};

const lookupCreatedAt = (
  leak: Leak,
  region: string,
  bucketDates: Map<string, Date>,
): Effect.Effect<Date | undefined, never, Env> => {
  switch (leak.kind) {
    case "sqs:queue":
      return tryDate(
        SQS.getQueueAttributes({
          QueueUrl: sqsQueueUrl(leak, region),
          AttributeNames: ["CreatedTimestamp"],
        }).pipe(Effect.map((r) => r.Attributes?.CreatedTimestamp)),
      );
    case "dynamodb:table":
      return tryDate(
        DynamoDB.describeTable({ TableName: leak.name }).pipe(
          Effect.map((r) => r.Table?.CreationDateTime),
        ),
      );
    case "lambda:function":
      return tryDate(
        Lambda.getFunctionConfiguration({ FunctionName: leak.name }).pipe(
          Effect.map((r) => r.LastModified),
        ),
      );
    case "logs:log-group":
      return tryDate(
        Logs.describeLogGroups({ logGroupNamePrefix: leak.name }).pipe(
          Effect.map(
            (r) =>
              r.logGroups?.find((g) => g.logGroupName === leak.name)
                ?.creationTime,
          ),
        ),
      );
    case "s3:bucket":
      return Effect.succeed(bucketDates.get(leak.name));
    case "kinesis:stream":
      return tryDate(
        Kinesis.describeStreamSummary({ StreamName: leak.name }).pipe(
          Effect.map(
            (r) => r.StreamDescriptionSummary?.StreamCreationTimestamp,
          ),
        ),
      );
    case "ecs:service": {
      // name = "service/{cluster}/{service}"
      const [, cluster, service] = leak.name.split("/");
      return tryDate(
        ECS.describeServices({ cluster, services: [service] }).pipe(
          Effect.map((r) => r.services?.[0]?.createdAt),
        ),
      );
    }
    case "elbv2:load-balancer":
      return tryDate(
        ELBv2.describeLoadBalancers({ LoadBalancerArns: [leak.arn] }).pipe(
          Effect.map((r) => r.LoadBalancers?.[0]?.CreatedTime),
        ),
      );
    case "ec2:nat-gateway":
      return tryDate(
        EC2.describeNatGateways({ NatGatewayIds: [leak.name] }).pipe(
          Effect.map((r) => r.NatGateways?.[0]?.CreateTime),
        ),
      );
    case "rds:instance":
      return tryDate(
        RDS.describeDBInstances({ DBInstanceIdentifier: leak.name }).pipe(
          Effect.map((r) => r.DBInstances?.[0]?.InstanceCreateTime),
        ),
      );
    case "rds:cluster":
      return tryDate(
        RDS.describeDBClusters({ DBClusterIdentifier: leak.name }).pipe(
          Effect.map((r) => r.DBClusters?.[0]?.ClusterCreateTime),
        ),
      );
    case "efs:file-system":
      return tryDate(
        EFS.describeFileSystems({ FileSystemId: leak.name }).pipe(
          Effect.map((r) => r.FileSystems?.[0]?.CreationTime),
        ),
      );
    case "kms:key":
      return tryDate(
        KMS.describeKey({ KeyId: leak.name }).pipe(
          Effect.map((r) => r.KeyMetadata?.CreationDate),
        ),
      );
    case "secretsmanager:secret":
      return tryDate(
        SecretsManager.describeSecret({ SecretId: leak.arn }).pipe(
          Effect.map((r) => r.CreatedDate),
        ),
      );
    case "ssm:parameter":
      return tryDate(
        SSM.describeParameters({
          ParameterFilters: [
            { Key: "Name", Option: "Equals", Values: [leak.name] },
          ],
        }).pipe(Effect.map((r) => r.Parameters?.[0]?.LastModifiedDate)),
      );
    case "scheduler:schedule": {
      const [group, name] = leak.name.includes("/")
        ? leak.name.split("/")
        : ["default", leak.name];
      return tryDate(
        Scheduler.getSchedule({ Name: name, GroupName: group }).pipe(
          Effect.map((r) => r.CreationDate),
        ),
      );
    }
    default:
      return Effect.succeed(undefined);
  }
};

// ---------------------------------------------------------------------------
// Deletion (typed per service; not-found tags forgiven; bounded dep retries)
// ---------------------------------------------------------------------------

/** bounded retry on dependency-violation / in-use style typed tags */
const retryDependencies = <A, E extends { _tag: string }, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  eff.pipe(
    Effect.retry({
      while: (e) =>
        /InUse|DependencyViolation|Conflict|ContainsServices|ContainsTasks|BucketNotEmpty|InvalidDBClusterState|InvalidDBInstanceState|Throttl|TooManyRequests|LimitExceeded/i.test(
          e._tag,
        ),
      schedule: Schedule.spaced("8 seconds"),
      times: 6,
    }),
  );

const GONE = /NotFound|NoSuchEntity|DoesNotExist|NoSuch|Missing|Gone|Deleted/i;

const emptyBucket = (bucket: string) =>
  Effect.gen(function* () {
    // re-list from the start after each batch delete; bounded passes
    for (let pass = 0; pass < 100; pass++) {
      const listing = yield* S3.listObjectVersions({ Bucket: bucket });
      const objects = [
        ...(listing.Versions ?? []),
        ...(listing.DeleteMarkers ?? []),
      ]
        .filter((o) => o.Key !== undefined)
        .map((o) => ({ Key: o.Key as string, VersionId: o.VersionId }));
      if (objects.length === 0) return;
      yield* S3.deleteObjects({
        Bucket: bucket,
        Delete: { Objects: objects, Quiet: true },
      });
      if (!listing.IsTruncated) return;
    }
  });

const deleteIamRole = (roleName: string) =>
  Effect.gen(function* () {
    const profiles = yield* IAM.listInstanceProfilesForRole({
      RoleName: roleName,
    });
    yield* Effect.forEach(
      profiles.InstanceProfiles ?? [],
      (p) =>
        IAM.removeRoleFromInstanceProfile({
          InstanceProfileName: p.InstanceProfileName,
          RoleName: roleName,
        }),
      { discard: true },
    );
    const attached = yield* IAM.listAttachedRolePolicies({
      RoleName: roleName,
    });
    yield* Effect.forEach(
      attached.AttachedPolicies ?? [],
      (p) =>
        IAM.detachRolePolicy({
          RoleName: roleName,
          PolicyArn: p.PolicyArn!,
        }),
      { discard: true },
    );
    const inline = yield* IAM.listRolePolicies({ RoleName: roleName });
    yield* Effect.forEach(
      inline.PolicyNames ?? [],
      (name) =>
        IAM.deleteRolePolicy({ RoleName: roleName, PolicyName: name }),
      { discard: true },
    );
    yield* retryDependencies(IAM.deleteRole({ RoleName: roleName }));
  });

const deleteIamPolicy = (policyArn: string) =>
  Effect.gen(function* () {
    const versions = yield* IAM.listPolicyVersions({ PolicyArn: policyArn });
    yield* Effect.forEach(
      (versions.Versions ?? []).filter((v) => !v.IsDefaultVersion),
      (v) =>
        IAM.deletePolicyVersion({
          PolicyArn: policyArn,
          VersionId: v.VersionId!,
        }),
      { discard: true },
    );
    yield* retryDependencies(IAM.deletePolicy({ PolicyArn: policyArn }));
  });

const deleteEcsService = (leak: Leak) =>
  Effect.gen(function* () {
    // name = "service/{cluster}/{service}"
    const [, cluster, service] = leak.name.split("/");
    yield* ECS.updateService({ cluster, service, desiredCount: 0 }).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    yield* retryDependencies(
      ECS.deleteService({ cluster, service, force: true }),
    );
  });

const deleteEventsRule = (leak: Leak) =>
  Effect.gen(function* () {
    // name is "name" (default bus) or "{bus}/{name}"
    const parts = leak.name.split("/");
    const [bus, name] =
      parts.length === 2 ? [parts[0], parts[1]] : ["default", parts[0]];
    const targets = yield* EventBridge.listTargetsByRule({
      Rule: name,
      EventBusName: bus,
    }).pipe(Effect.catch(() => Effect.succeed({ Targets: [] })));
    const ids = (targets.Targets ?? [])
      .map((t) => t.Id)
      .filter((id): id is string => id !== undefined);
    if (ids.length > 0) {
      yield* EventBridge.removeTargets({
        Rule: name,
        EventBusName: bus,
        Ids: ids,
        Force: true,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    }
    yield* EventBridge.deleteRule({ Name: name, EventBusName: bus, Force: true });
  });

/**
 * A leaked VPC can't be deleted while its subnets / route tables / IGW /
 * security groups exist, so tear those down first. NEVER touches the default
 * VPC.
 */
const deleteVpcDeep = (vpcId: string) =>
  Effect.gen(function* () {
    const vpcs = yield* EC2.describeVpcs({ VpcIds: [vpcId] });
    const vpc = vpcs.Vpcs?.[0];
    if (!vpc) return; // already gone
    if (vpc.IsDefault) {
      return yield* Effect.fail({
        _tag: "RefusingToDeleteDefaultVpc" as const,
      });
    }
    const vpcFilter = [{ Name: "vpc-id", Values: [vpcId] }];

    const subnets = yield* EC2.describeSubnets({ Filters: vpcFilter });
    yield* Effect.forEach(
      subnets.Subnets ?? [],
      (s) =>
        retryDependencies(EC2.deleteSubnet({ SubnetId: s.SubnetId! })).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      { discard: true },
    );

    const igws = yield* EC2.describeInternetGateways({
      Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }],
    });
    yield* Effect.forEach(
      igws.InternetGateways ?? [],
      (igw) =>
        EC2.detachInternetGateway({
          InternetGatewayId: igw.InternetGatewayId!,
          VpcId: vpcId,
        }).pipe(
          Effect.andThen(
            EC2.deleteInternetGateway({
              InternetGatewayId: igw.InternetGatewayId!,
            }),
          ),
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      { discard: true },
    );

    const rts = yield* EC2.describeRouteTables({ Filters: vpcFilter });
    yield* Effect.forEach(
      (rts.RouteTables ?? []).filter(
        (rt) => !(rt.Associations ?? []).some((a) => a.Main),
      ),
      (rt) =>
        EC2.deleteRouteTable({ RouteTableId: rt.RouteTableId! }).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      { discard: true },
    );

    const sgs = yield* EC2.describeSecurityGroups({ Filters: vpcFilter });
    yield* Effect.forEach(
      (sgs.SecurityGroups ?? []).filter((sg) => sg.GroupName !== "default"),
      (sg) =>
        retryDependencies(
          EC2.deleteSecurityGroup({ GroupId: sg.GroupId! }),
        ).pipe(Effect.catch(() => Effect.succeed(undefined))),
      { discard: true },
    );

    yield* retryDependencies(EC2.deleteVpc({ VpcId: vpcId }));
  });

const deleteEfs = (fileSystemId: string) =>
  Effect.gen(function* () {
    const mts = yield* EFS.describeMountTargets({
      FileSystemId: fileSystemId,
    }).pipe(Effect.catch(() => Effect.succeed({ MountTargets: [] })));
    yield* Effect.forEach(
      mts.MountTargets ?? [],
      (mt) => EFS.deleteMountTarget({ MountTargetId: mt.MountTargetId }),
      { discard: true },
    );
    yield* retryDependencies(
      EFS.deleteFileSystem({ FileSystemId: fileSystemId }),
    );
  });

const destroyLeak = (
  leak: Leak,
  region: string,
): Effect.Effect<unknown, { _tag: string }, Env> => {
  switch (leak.kind) {
    case "sqs:queue":
      return SQS.deleteQueue({ QueueUrl: sqsQueueUrl(leak, region) });
    case "sns:topic":
      return SNS.deleteTopic({ TopicArn: leak.arn });
    case "dynamodb:table":
      return retryDependencies(
        DynamoDB.deleteTable({ TableName: leak.name }),
      );
    case "lambda:function":
      return Lambda.deleteFunction({ FunctionName: leak.name });
    case "logs:log-group":
      return Logs.deleteLogGroup({ logGroupName: leak.name });
    case "s3:bucket":
      return emptyBucket(leak.name).pipe(
        Effect.andThen(
          retryDependencies(S3.deleteBucket({ Bucket: leak.name })),
        ),
      );
    case "kinesis:stream":
      return retryDependencies(
        Kinesis.deleteStream({
          StreamName: leak.name,
          EnforceConsumerDeletion: true,
        }),
      );
    case "events:rule":
      return deleteEventsRule(leak);
    case "events:event-bus":
      return EventBridge.deleteEventBus({ Name: leak.name });
    case "ecs:service":
      return deleteEcsService(leak);
    case "ecs:cluster":
      return retryDependencies(ECS.deleteCluster({ cluster: leak.name }));
    case "ecs:task-definition":
      return ECS.deregisterTaskDefinition({ taskDefinition: leak.name });
    case "elbv2:load-balancer":
      return ELBv2.deleteLoadBalancer({ LoadBalancerArn: leak.arn });
    case "elbv2:target-group":
      return retryDependencies(
        ELBv2.deleteTargetGroup({ TargetGroupArn: leak.arn }),
      );
    case "ec2:nat-gateway":
      return EC2.deleteNatGateway({ NatGatewayId: leak.name });
    case "ec2:elastic-ip":
      return retryDependencies(
        EC2.releaseAddress({ AllocationId: leak.name }),
      );
    case "ec2:vpc":
      return deleteVpcDeep(leak.name);
    case "rds:instance":
      return retryDependencies(
        RDS.deleteDBInstance({
          DBInstanceIdentifier: leak.name,
          SkipFinalSnapshot: true,
          DeleteAutomatedBackups: true,
        }),
      );
    case "rds:cluster":
      return retryDependencies(
        RDS.deleteDBCluster({
          DBClusterIdentifier: leak.name,
          SkipFinalSnapshot: true,
        }),
      );
    case "efs:file-system":
      return deleteEfs(leak.name);
    case "secretsmanager:secret":
      return SecretsManager.deleteSecret({
        SecretId: leak.arn,
        ForceDeleteWithoutRecovery: true,
      });
    case "ssm:parameter":
      return SSM.deleteParameter({ Name: leak.name });
    case "scheduler:schedule": {
      const [group, name] = leak.name.includes("/")
        ? leak.name.split("/")
        : ["default", leak.name];
      return Scheduler.deleteSchedule({ Name: name, GroupName: group });
    }
    case "scheduler:schedule-group":
      return retryDependencies(
        Scheduler.deleteScheduleGroup({ Name: leak.name }),
      );
    case "iam:role":
      return deleteIamRole(leak.name);
    case "iam:policy":
      return deleteIamPolicy(leak.arn);
    default:
      return Effect.void;
  }
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * NOTE: distilled's generated `.pages`/`.items` streams hang on APIs that
 * signal the last page with an EMPTY-STRING token (the tagging API returns
 * `PaginationToken: ""` when done, but src/client/api.ts only treats
 * undefined/null as done). Paginate by hand, bounded, until that core bug is
 * fixed.
 */
const MAX_PAGES = 50;

const discoverTagged = (stage: string) =>
  Effect.gen(function* () {
    const all: import("../distilled/packages/aws/src/services/resource-groups-tagging-api.ts").ResourceTagMapping[] =
      [];
    let token: string | undefined = undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: GetResourcesOutput = yield* getResources({
        TagFilters: [{ Key: "alchemy::stage", Values: [stage] }],
        ResourcesPerPage: 100,
        ...(token ? { PaginationToken: token } : {}),
      });
      all.push(...(res.ResourceTagMappingList ?? []));
      token = res.PaginationToken;
      if (!token) break;
    }
    return all;
  });

/**
 * IAM is a global service — a regional GetResources call does not return IAM
 * resources, so list roles/local policies directly and confirm ownership via
 * their alchemy tags. To bound tag-read calls, only name-plausible candidates
 * (physical names embed `-{stage}-`, see src/PhysicalName.ts) are tag-checked.
 */
const discoverIam = (stage: string, account: string) =>
  Effect.gen(function* () {
    const marker = `-${stage}-`;
    const leaks: {
      arn: string;
      tags: Record<string, string>;
      createdAt: Date | undefined;
    }[] = [];

    const roles: import("../distilled/packages/aws/src/services/iam.ts").Role[] =
      [];
    {
      let marker: string | undefined = undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res: IAM.ListRolesResponse = yield* IAM.listRoles({
          MaxItems: 1000,
          ...(marker ? { Marker: marker } : {}),
        });
        roles.push(...(res.Roles ?? []));
        if (!res.IsTruncated || !res.Marker) break;
        marker = res.Marker;
      }
    }
    const roleCandidates = roles.filter((r) =>
      (r.RoleName ?? "").includes(marker),
    );
    const roleTags = yield* Effect.forEach(
      roleCandidates,
      (r) =>
        IAM.listRoleTags({ RoleName: r.RoleName }).pipe(
          Effect.map((t) => ({ role: r, tags: tagRecord(t.Tags) })),
          Effect.catch(() =>
            Effect.succeed({ role: r, tags: {} as Record<string, string> }),
          ),
        ),
      { concurrency: 5 },
    );
    for (const { role, tags } of roleTags) {
      if (tags["alchemy::stage"] === stage) {
        leaks.push({
          arn: role.Arn ?? `arn:aws:iam::${account}:role/${role.RoleName}`,
          tags,
          createdAt: toDate(role.CreateDate),
        });
      }
    }

    const policies: import("../distilled/packages/aws/src/services/iam.ts").Policy[] =
      [];
    {
      let marker: string | undefined = undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res: IAM.ListPoliciesResponse = yield* IAM.listPolicies({
          Scope: "Local",
          MaxItems: 1000,
          ...(marker ? { Marker: marker } : {}),
        });
        policies.push(...(res.Policies ?? []));
        if (!res.IsTruncated || !res.Marker) break;
        marker = res.Marker;
      }
    }
    const policyCandidates = policies.filter((p) =>
      (p.PolicyName ?? "").includes(marker),
    );
    const policyTags = yield* Effect.forEach(
      policyCandidates,
      (p) =>
        IAM.listPolicyTags({ PolicyArn: p.Arn! }).pipe(
          Effect.map((t) => ({ policy: p, tags: tagRecord(t.Tags) })),
          Effect.catch(() =>
            Effect.succeed({ policy: p, tags: {} as Record<string, string> }),
          ),
        ),
      { concurrency: 5 },
    );
    for (const { policy, tags } of policyTags) {
      if (tags["alchemy::stage"] === stage) {
        leaks.push({ arn: policy.Arn!, tags, createdAt: toDate(policy.CreateDate) });
      }
    }
    return leaks;
  });

/**
 * EventBridge Scheduler schedules are not taggable, so the tagging API can't
 * find them. Fall back to listing all schedules and matching the alchemy
 * physical-name shape (`{stack}-{id}-{stage}-{suffix}`).
 */
const discoverSchedules = (stage: string, region: string, account: string) =>
  Effect.gen(function* () {
    const marker = `-${stage}-`;
    const schedules: import("../distilled/packages/aws/src/services/scheduler.ts").ScheduleSummary[] =
      [];
    {
      let token: string | undefined = undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res: Scheduler.ListSchedulesOutput = yield* Scheduler.listSchedules({
          MaxResults: 100,
          ...(token ? { NextToken: token } : {}),
        });
        schedules.push(...(res.Schedules ?? []));
        token = res.NextToken;
        if (!token) break;
      }
    }
    return schedules
      .filter((s) => (s.Name ?? "").includes(marker))
      .map((s) => ({
        arn:
          s.Arn ??
          `arn:aws:scheduler:${region}:${account}:schedule/${s.GroupName ?? "default"}/${s.Name}`,
        group: s.GroupName ?? "default",
        name: s.Name ?? "",
        createdAt: toDate(s.CreationDate),
      }));
  }).pipe(Effect.catch(() => Effect.succeed([])));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const fmtAge = (h: number | undefined): string =>
  h === undefined ? "?" : h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;

const printTable = (leaks: Leak[]) => {
  const rows = leaks.map((l) => ({
    age: fmtAge(ageHours(l.createdAt)),
    cost: l.hourly ? "HOURLY" : "",
    kind: l.kind + (l.reportOnly ? " (report-only)" : ""),
    stack: l.tags["alchemy::stack"] ?? "",
    id: l.tags["alchemy::id"] ?? "",
    arn: l.arn,
  }));
  const cols = ["age", "cost", "kind", "stack", "id", "arn"] as const;
  const headers = { age: "AGE", cost: "COST", kind: "KIND", stack: "STACK", id: "ID", arn: "ARN" };
  const width = (c: (typeof cols)[number]) =>
    Math.max(headers[c].length, ...rows.map((r) => r[c].length));
  const line = (r: Record<(typeof cols)[number], string>) =>
    cols.map((c) => r[c].padEnd(width(c))).join("  ");
  console.log(line(headers));
  console.log(cols.map((c) => "-".repeat(width(c))).join("  "));
  for (const r of rows) console.log(line(r));
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = Effect.gen(function* () {
  const args = yield* parseArgs;
  console.log(
    `aws-leak-sweep: region=${args.region} stage=${args.stage} older-than=${args.olderThanHours}h mode=${args.delete ? "DELETE" : "DRY-RUN"}`,
  );

  // -- discover ---------------------------------------------------------
  const tagged = yield* discoverTagged(args.stage);
  const account =
    tagged
      .map((t) => parseArn(t.ResourceARN ?? "")?.account)
      .find((a) => a && a.length > 0) ?? "";

  const leaks: Leak[] = [];
  const seen = new Set<string>();
  const push = (leak: Leak) => {
    if (!seen.has(leak.arn)) {
      seen.add(leak.arn);
      leaks.push(leak);
    }
  };

  for (const mapping of tagged) {
    const arn = mapping.ResourceARN;
    if (!arn) continue;
    const c = classify(arn);
    push({
      arn,
      kind: c.kind,
      name: c.name,
      tags: tagRecord(mapping.Tags),
      createdAt: undefined,
      hourly: c.hourly,
      reportOnly: c.reportOnly,
      reportOnlyReason: c.reportOnlyReason,
      phase: c.phase,
    });
  }

  const iamLeaks = yield* discoverIam(args.stage, account);
  for (const l of iamLeaks) {
    const c = classify(l.arn);
    push({
      arn: l.arn,
      kind: c.kind,
      name: c.name,
      tags: l.tags,
      createdAt: l.createdAt,
      hourly: c.hourly,
      reportOnly: c.reportOnly,
      reportOnlyReason: c.reportOnlyReason,
      phase: c.phase,
    });
  }

  const schedules = yield* discoverSchedules(args.stage, args.region, account);
  for (const s of schedules) {
    push({
      arn: s.arn,
      kind: "scheduler:schedule",
      name: `${s.group}/${s.name}`,
      tags: {},
      createdAt: s.createdAt,
      hourly: false,
      reportOnly: false,
      phase: 1,
    });
  }

  if (leaks.length === 0) {
    console.log("No alchemy-tagged test resources found. Clean.");
    return;
  }

  // -- enrich ages ------------------------------------------------------
  const bucketDates = new Map<string, Date>();
  if (leaks.some((l) => l.kind === "s3:bucket")) {
    const buckets = yield* S3.listBuckets({}).pipe(
      Effect.catch(() => Effect.succeed({ Buckets: [] })),
    );
    for (const b of buckets.Buckets ?? []) {
      const d = toDate(b.CreationDate);
      if (b.Name && d) bucketDates.set(b.Name, d);
    }
  }
  yield* Effect.forEach(
    leaks,
    (leak) =>
      leak.createdAt !== undefined
        ? Effect.void
        : lookupCreatedAt(leak, args.region, bucketDates).pipe(
            Effect.map((d) => {
              leak.createdAt = d;
            }),
          ),
    { concurrency: 8, discard: true },
  );

  // -- filter by age ----------------------------------------------------
  const eligible: Leak[] = [];
  let skippedYoung = 0;
  for (const leak of leaks) {
    const h = ageHours(leak.createdAt);
    // unknown age = still a leak; can't prove it's young
    if (h === undefined || h >= args.olderThanHours) eligible.push(leak);
    else skippedYoung++;
  }

  eligible.sort(
    (a, b) =>
      (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
  );

  console.log(
    `\nFound ${leaks.length} alchemy '${args.stage}'-stage resources; ${eligible.length} older than ${args.olderThanHours}h (or unknown age), ${skippedYoung} younger (skipped).\n`,
  );
  printTable(eligible);

  const hourlyCount = eligible.filter((l) => l.hourly).length;
  if (hourlyCount > 0) {
    console.log(
      `\n!! ${hourlyCount} resource(s) bill HOURLY (NAT/EIP/RDS/ELB) — sweep these first.`,
    );
  }
  const reportOnly = eligible.filter((l) => l.reportOnly);
  if (reportOnly.length > 0) {
    console.log(`\nReport-only (not deleted by this tool):`);
    for (const l of reportOnly) {
      console.log(`  - ${l.arn} (${l.reportOnlyReason ?? ""})`);
    }
  }

  if (!args.delete) {
    console.log(
      `\nDRY RUN — nothing deleted. Re-run with --delete to remove the ${
        eligible.filter((l) => !l.reportOnly).length
      } deletable resource(s).`,
    );
    return;
  }

  // -- delete: phase order, oldest-first within phase --------------------
  const deletable = eligible
    .filter((l) => !l.reportOnly)
    .sort(
      (a, b) =>
        a.phase - b.phase ||
        (a.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (b.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
    );

  let ok = 0;
  let gone = 0;
  let failed = 0;
  for (const leak of deletable) {
    const result = yield* destroyLeak(leak, args.region).pipe(
      Effect.timeout("120 seconds"),
      Effect.result,
    );
    if (Result.isFailure(result)) {
      const tag =
        typeof result.failure === "object" &&
        result.failure !== null &&
        "_tag" in result.failure
          ? String(result.failure._tag)
          : String(result.failure);
      if (GONE.test(tag)) {
        gone++;
        console.log(`  ~ already gone ${leak.kind} ${leak.arn}`);
      } else {
        failed++;
        console.log(`  x FAILED ${leak.kind} ${leak.arn}: ${tag}`);
      }
    } else {
      ok++;
      console.log(`  ✓ deleted ${leak.kind} ${leak.arn}`);
    }
  }
  console.log(
    `\nDelete complete: ${ok} deleted, ${gone} already gone, ${failed} failed.`,
  );
  if (failed > 0) {
    console.log(
      "Failures are usually dependency ordering (NAT->EIP->VPC take minutes); re-run the sweep.",
    );
    process.exitCode = 1;
  }
});

const args = await Effect.runPromise(parseArgs);
const layers = Layer.mergeAll(
  fromChain(),
  Layer.succeed(Region, Effect.succeed(args.region as any)),
  FetchHttpClient.layer,
);

await Effect.runPromise(main.pipe(Effect.provide(layers)));
