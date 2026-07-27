import type { Input } from "../../Input.ts";
import * as Scheduler from "../Scheduler/index.ts";
import type { Cluster } from "./Cluster.ts";

export interface ScheduleProps {
  /**
   * ECS cluster that the scheduled task should run on.
   */
  cluster: Cluster;

  /**
   * ECS task definition and roles to invoke on each schedule tick.
   *
   * This is typically an `AWS.ECS.Task` resource (whose attributes are
   * `Output`s — the fields are `Input`-typed because `every` is a helper
   * function, not resource Props).
   */
  task: {
    /**
     * Task definition ARN to run.
     */
    taskDefinitionArn: Input<string>;
    /**
     * Task role ARN passed through EventBridge `iam:PassRole`.
     */
    taskRoleArn: Input<string>;
    /**
     * Execution role ARN passed through EventBridge `iam:PassRole`.
     */
    executionRoleArn: Input<string>;
  };

  /**
   * Subnets used for the Fargate task network configuration.
   */
  subnets: Input<string[]>;

  /**
   * Security groups attached to the scheduled task ENIs.
   */
  securityGroups?: Input<string[]>;

  /**
   * Whether the scheduled task should receive a public IP.
   * @default false
   */
  assignPublicIp?: boolean;

  /**
   * Number of task copies to start on each invocation.
   * @default 1
   */
  taskCount?: number;

  /**
   * Static JSON payload forwarded to the EventBridge ECS target.
   */
  input?: string;
}

const toScheduleExpression = (value: string) =>
  value.startsWith("rate(") || value.startsWith("cron(")
    ? value
    : `rate(${value})`;

/**
 * Creates a scheduled EventBridge rule that runs an ECS Fargate task.
 *
 * `every` is the high-level ECS scheduling helper for phase 1. It provisions
 * the EventBridge rule plus the invoke role required to call `ecs:RunTask` and
 * `iam:PassRole` for the target task's execution roles.
 *
 * Plain English durations like `"1 hour"` are normalized to `rate(...)`
 * expressions automatically. Full `rate(...)` and `cron(...)` expressions are
 * also accepted as-is.
 * @binding
 * @example Run a task every hour
 * ```typescript
 * yield* AWS.ECS.every("HourlyJob", "1 hour", {
 *   cluster,
 *   task: jobTask,
 *   subnets: [privateSubnet1.subnetId, privateSubnet2.subnetId],
 *   securityGroups: [jobSecurityGroup.groupId],
 * });
 * ```
 *
 * @example Use an explicit cron expression
 * ```typescript
 * yield* AWS.ECS.every("NightlyJob", "cron(0 3 * * ? *)", {
 *   cluster,
 *   task: nightlyTask,
 *   subnets: [privateSubnet1.subnetId, privateSubnet2.subnetId],
 *   securityGroups: [jobSecurityGroup.groupId],
 * });
 * ```
 *
 * @example Run multiple copies with static input
 * ```typescript
 * yield* AWS.ECS.every("BatchJob", "30 minutes", {
 *   cluster,
 *   task: batchTask,
 *   subnets: [privateSubnet1.subnetId, privateSubnet2.subnetId],
 *   securityGroups: [jobSecurityGroup.groupId],
 *   taskCount: 3,
 *   input: JSON.stringify({ source: "scheduler" }),
 * });
 * ```
 */
export const every = (id: string, schedule: string, props: ScheduleProps) =>
  Scheduler.every(toScheduleExpression(schedule)).named(id).toEcsTask({
    cluster: props.cluster,
    task: props.task,
    subnets: props.subnets,
    securityGroups: props.securityGroups,
    assignPublicIp: props.assignPublicIp,
    taskCount: props.taskCount,
    input: props.input,
  });
