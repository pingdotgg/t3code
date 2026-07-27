import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type FlowLogId<ID extends string = string> = `fl-${ID}`;

export type FlowLogArn<ID extends FlowLogId = FlowLogId> =
  `arn:aws:ec2:${RegionID}:${AccountID}:vpc-flow-log/${ID}`;

/**
 * Raised when `createFlowLogs`/`deleteFlowLogs` report an item in the
 * `Unsuccessful` array (these APIs never throw for per-resource failures).
 */
export class FlowLogOperationFailed extends Data.TaggedError(
  "FlowLogOperationFailed",
)<{
  readonly code: string;
  readonly message: string;
}> {}

export interface FlowLogProps {
  /**
   * The type of resource to monitor.
   */
  resourceType: "VPC" | "Subnet" | "NetworkInterface";

  /**
   * The ID of the VPC, subnet, or network interface to capture flow logs for.
   * Immutable — changing it replaces the flow log.
   */
  resourceId: string;

  /**
   * The type of traffic to capture.
   * @default "ALL"
   */
  trafficType?: "ACCEPT" | "REJECT" | "ALL";

  /**
   * Where to deliver the flow logs.
   * @default "cloud-watch-logs"
   */
  logDestinationType?: "cloud-watch-logs" | "s3" | "kinesis-data-firehose";

  /**
   * The name of the CloudWatch Logs log group. Required (and only valid) when
   * `logDestinationType` is `cloud-watch-logs`.
   */
  logGroupName?: string;

  /**
   * The ARN of the IAM role that permits EC2 to publish flow logs to the
   * CloudWatch Logs group. Required when `logDestinationType` is
   * `cloud-watch-logs`.
   */
  deliverLogsPermissionArn?: string;

  /**
   * The ARN of the destination for the flow logs when `logDestinationType` is
   * `s3` (a bucket ARN, optionally with a key prefix) or
   * `kinesis-data-firehose` (a delivery stream ARN).
   */
  logDestination?: string;

  /**
   * The maximum interval, in seconds, during which a flow of packets is
   * captured and aggregated into a flow log record. Either `60` or `600`.
   * @default 600
   */
  maxAggregationInterval?: 60 | 600;

  /**
   * A custom format string for the flow log records. If omitted, the default
   * format is used.
   */
  logFormat?: string;

  /**
   * Tags to assign to the flow log.
   */
  tags?: Record<string, string>;
}

export interface FlowLog extends Resource<
  "AWS.EC2.FlowLog",
  FlowLogProps,
  {
    /**
     * The ID of the flow log (prefixed `fl-`).
     */
    flowLogId: FlowLogId;

    /**
     * The Amazon Resource Name (ARN) of the flow log.
     */
    flowLogArn: FlowLogArn;

    /**
     * The ID of the monitored resource.
     */
    resourceId: string;

    /**
     * The type of traffic captured.
     */
    trafficType: "ACCEPT" | "REJECT" | "ALL";

    /**
     * Where the flow logs are delivered.
     */
    logDestinationType: "cloud-watch-logs" | "s3" | "kinesis-data-firehose";
  },
  never,
  Providers
> {}

/**
 * A flow log captures information about the IP traffic going to and from a VPC,
 * subnet, or network interface, and publishes it to CloudWatch Logs, S3, or a
 * Kinesis Data Firehose delivery stream. Use it for network monitoring, traffic
 * analysis, and troubleshooting security-group / NACL rules.
 *
 * A flow log is immutable: every property except `tags` is fixed at creation,
 * so changing the monitored resource, destination, or traffic type replaces the
 * flow log. For CloudWatch Logs delivery you must supply a `logGroupName` and a
 * `deliverLogsPermissionArn` — an IAM role that EC2's `vpc-flow-logs` service
 * principal can assume to write to the group.
 *
 * @resource
 * @section Creating a Flow Log
 * @example VPC Flow Log to CloudWatch Logs
 * ```typescript
 * const logGroup = yield* AWS.Logs.LogGroup("FlowLogs", {});
 *
 * const role = yield* AWS.IAM.Role("FlowLogRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "vpc-flow-logs.amazonaws.com" },
 *       Action: "sts:AssumeRole",
 *     }],
 *   },
 *   inlinePolicies: {
 *     deliver: {
 *       Version: "2012-10-17",
 *       Statement: [{
 *         Effect: "Allow",
 *         Action: [
 *           "logs:CreateLogStream",
 *           "logs:PutLogEvents",
 *           "logs:DescribeLogStreams",
 *         ],
 *         Resource: "*",
 *       }],
 *     },
 *   },
 * });
 *
 * const flowLog = yield* AWS.EC2.FlowLog("VpcFlowLog", {
 *   resourceType: "VPC",
 *   resourceId: myVpc.vpcId,
 *   logGroupName: logGroup.logGroupName,
 *   deliverLogsPermissionArn: role.roleArn,
 * });
 * ```
 * Captures all traffic for the VPC and delivers it to the CloudWatch Logs
 * group via the delivery role.
 *
 * @example S3 Flow Log for Rejected Traffic
 * ```typescript
 * const flowLog = yield* AWS.EC2.FlowLog("RejectedTraffic", {
 *   resourceType: "Subnet",
 *   resourceId: mySubnet.subnetId,
 *   trafficType: "REJECT",
 *   logDestinationType: "s3",
 *   logDestination: bucket.bucketArn,
 * });
 * ```
 * Delivers only rejected-traffic records for a subnet directly to an S3 bucket
 * (no IAM role required for S3 delivery).
 */
export const FlowLog = Resource<FlowLog>("AWS.EC2.FlowLog");

export const FlowLogProvider = () =>
  Provider.effect(
    FlowLog,
    Effect.gen(function* () {
      const createTags = Effect.fn(function* (
        id: string,
        tags?: Record<string, string>,
      ) {
        return {
          Name: id,
          ...(yield* createInternalTags(id)),
          ...tags,
        };
      });

      const describeFlowLog = (flowLogId: string) =>
        ec2.describeFlowLogs({ FlowLogIds: [flowLogId] }).pipe(
          Effect.map((r) => r.FlowLogs?.[0]),
          Effect.catchTag("InvalidFlowLogId.NotFound", () =>
            Effect.succeed(undefined),
          ),
        );

      const toAttrs = (fl: ec2.FlowLog) =>
        AWSEnvironment.current.pipe(
          Effect.map((env) => ({
            flowLogId: fl.FlowLogId as FlowLogId,
            flowLogArn:
              `arn:aws:ec2:${env.region}:${env.accountId}:vpc-flow-log/${fl.FlowLogId}` as FlowLogArn,
            resourceId: fl.ResourceId!,
            trafficType: (fl.TrafficType ?? "ALL") as
              | "ACCEPT"
              | "REJECT"
              | "ALL",
            logDestinationType: (fl.LogDestinationType ??
              "cloud-watch-logs") as
              | "cloud-watch-logs"
              | "s3"
              | "kinesis-data-firehose",
          })),
        );

      return {
        stables: ["flowLogId", "flowLogArn"],

        list: () =>
          Effect.gen(function* () {
            const env = yield* AWSEnvironment.current;
            const items = yield* ec2.describeFlowLogs.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.FlowLogs ?? [])
                    .filter(
                      (fl): fl is ec2.FlowLog & { FlowLogId: string } =>
                        fl.FlowLogId != null,
                    )
                    .map((fl) => ({
                      flowLogId: fl.FlowLogId as FlowLogId,
                      flowLogArn:
                        `arn:aws:ec2:${env.region}:${env.accountId}:vpc-flow-log/${fl.FlowLogId}` as FlowLogArn,
                      resourceId: fl.ResourceId!,
                      trafficType: (fl.TrafficType ?? "ALL") as
                        | "ACCEPT"
                        | "REJECT"
                        | "ALL",
                      logDestinationType: (fl.LogDestinationType ??
                        "cloud-watch-logs") as
                        | "cloud-watch-logs"
                        | "s3"
                        | "kinesis-data-firehose",
                    })),
                ),
              ),
            );
            return items satisfies FlowLog["Attributes"][];
          }),

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const fl = yield* describeFlowLog(output.flowLogId);
          if (!fl) return undefined;
          return yield* toAttrs(fl);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // Flow logs are immutable except for tags — any structural change
          // replaces the resource.
          if (
            news.resourceType !== olds.resourceType ||
            news.resourceId !== olds.resourceId ||
            (news.trafficType ?? "ALL") !== (olds.trafficType ?? "ALL") ||
            (news.logDestinationType ?? "cloud-watch-logs") !==
              (olds.logDestinationType ?? "cloud-watch-logs") ||
            news.logGroupName !== olds.logGroupName ||
            news.logDestination !== olds.logDestination ||
            news.deliverLogsPermissionArn !== olds.deliverLogsPermissionArn ||
            (news.maxAggregationInterval ?? 600) !==
              (olds.maxAggregationInterval ?? 600) ||
            news.logFormat !== olds.logFormat
          ) {
            return { action: "replace" };
          }
          // Only tags are mutable in place.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const desiredTags = yield* createTags(id, news.tags);

          // Observe — find the flow log via the cached id, else create.
          let fl: ec2.FlowLog | undefined;
          if (output?.flowLogId) {
            fl = yield* describeFlowLog(output.flowLogId);
          }

          // Ensure — create if missing. createFlowLogs reports per-resource
          // failures in the Unsuccessful array rather than throwing.
          if (fl === undefined) {
            yield* session.note("Creating flow log...");
            // A freshly-created delivery role may not yet be assumable by the
            // flow-logs service (IAM eventual consistency) — createFlowLogs
            // reports that in Unsuccessful. Retry that (but not a genuine
            // "already exists") on a bounded schedule.
            const result = yield* ec2
              .createFlowLogs({
                ResourceType: news.resourceType,
                ResourceIds: [news.resourceId],
                TrafficType: news.trafficType ?? "ALL",
                LogDestinationType:
                  news.logDestinationType ?? "cloud-watch-logs",
                LogGroupName: news.logGroupName,
                DeliverLogsPermissionArn: news.deliverLogsPermissionArn,
                LogDestination: news.logDestination,
                MaxAggregationInterval: news.maxAggregationInterval,
                LogFormat: news.logFormat,
                TagSpecifications: [
                  {
                    ResourceType: "vpc-flow-log",
                    Tags: createTagsList(desiredTags),
                  },
                ],
              })
              .pipe(
                Effect.flatMap((r) => {
                  const failure = r.Unsuccessful?.[0];
                  return failure
                    ? Effect.fail(
                        new FlowLogOperationFailed({
                          code: failure.Error?.Code ?? "Unknown",
                          message:
                            failure.Error?.Message ?? "createFlowLogs failed",
                        }),
                      )
                    : Effect.succeed(r);
                }),
                Effect.retry({
                  while: (e) =>
                    e._tag === "FlowLogOperationFailed" &&
                    e.code !== "FlowLogAlreadyExists",
                  schedule: Schedule.max([
                    Schedule.fixed(3000),
                    Schedule.recurs(15),
                  ]),
                }),
              );
            const flowLogId = result.FlowLogIds![0]!;
            yield* session.note(`Flow log created: ${flowLogId}`);
            fl = yield* describeFlowLog(flowLogId);
            if (!fl) {
              // Freshly-created flow log not yet visible — synthesize attrs.
              return yield* toAttrs({
                FlowLogId: flowLogId,
                ResourceId: news.resourceId,
                TrafficType: news.trafficType ?? "ALL",
                LogDestinationType:
                  news.logDestinationType ?? "cloud-watch-logs",
              } as ec2.FlowLog);
            }
          }

          const flowLogId = fl.FlowLogId!;

          // Sync tags — observed cloud tags vs desired.
          const currentTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [flowLogId] },
                  { Name: "resource-type", Values: ["vpc-flow-log"] },
                ],
              })
              .pipe(
                Effect.map(
                  (r) =>
                    Object.fromEntries(
                      r.Tags?.map((t) => [t.Key!, t.Value!]) ?? [],
                    ) as Record<string, string>,
                ),
              )) ?? {};
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [flowLogId],
              Tags: removed.map((key) => ({ Key: key })),
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({ Resources: [flowLogId], Tags: upsert });
          }

          const final = yield* describeFlowLog(flowLogId);
          return yield* toAttrs(final ?? fl);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const flowLogId = output.flowLogId;
          yield* session.note(`Deleting flow log: ${flowLogId}`);
          // deleteFlowLogs is idempotent — a missing flow log is reported in
          // Unsuccessful, which we ignore.
          yield* ec2.deleteFlowLogs({ FlowLogIds: [flowLogId] });
        }),
      };
    }),
  );
