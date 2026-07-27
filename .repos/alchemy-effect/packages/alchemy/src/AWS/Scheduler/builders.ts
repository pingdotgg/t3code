import type * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import type { Input, InputProps } from "../../Input.ts";
import type { Cluster } from "../ECS/Cluster.ts";
import * as IAM from "../IAM/index.ts";
import type { Function } from "../Lambda/Function.ts";
import type { Queue } from "../SQS/Queue.ts";
import { Schedule } from "./Schedule.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

/**
 * Accumulated state of a fluent schedule builder (`every`/`cron`/`at` plus
 * any `.named(...)` and target options applied so far).
 */
export interface ScheduleBuilderState {
  /** Schedule expression: `rate(...)`, `cron(...)`, or `at(...)`. */
  expression: string;
  /** Explicit schedule name set via `.named(...)`. */
  name?: string;
  /** Schedule group the schedule is created in. */
  group?: ScheduleGroup;
  /** Description on the backing schedule. */
  description?: string;
  /** Timezone for cron or at expressions. */
  timezone?: string;
  /** Date before which the schedule does not fire. */
  startDate?: Date;
  /** Date after which the schedule stops firing. */
  endDate?: Date;
  /** Desired schedule state (`ENABLED` / `DISABLED`). */
  state?: string;
  /** KMS key ARN used to encrypt the schedule's target input. */
  kmsKeyArn?: string;
  /**
   * Flexible time window configuration.
   * @default { Mode: "OFF" }
   */
  flexibleTimeWindow?: scheduler.FlexibleTimeWindow;
  /** Action after a one-time schedule completes (e.g. `DELETE`). */
  actionAfterCompletion?: string;
}

/**
 * Options accepted by the `every`/`cron`/`at` schedule builders.
 */
export interface ScheduleOptions {
  /** Schedule group the schedule is created in. */
  group?: ScheduleGroup;
  /** Description on the backing schedule. */
  description?: string;
  /** Timezone for cron or at expressions. */
  timezone?: string;
  /** Date before which the schedule does not fire. */
  startDate?: Date;
  /** Date after which the schedule stops firing. */
  endDate?: Date;
  /** Desired schedule state (`ENABLED` / `DISABLED`). */
  state?: string;
  /** KMS key ARN used to encrypt the schedule's target input. */
  kmsKeyArn?: string;
  /**
   * Flexible time window configuration.
   * @default { Mode: "OFF" }
   */
  flexibleTimeWindow?: scheduler.FlexibleTimeWindow;
  /** Action after a one-time schedule completes (e.g. `DELETE`). */
  actionAfterCompletion?: string;
}

/**
 * Target options for `.toLambda(fn, props)`.
 */
export interface LambdaTargetProps {
  /** JSON-serializable payload passed to the function as the event. */
  input?: unknown;
  /** Retry policy for failed invocations. */
  retryPolicy?: scheduler.RetryPolicy;
  /** Dead-letter queue for undeliverable invocations. */
  deadLetterConfig?: scheduler.DeadLetterConfig;
}

/**
 * Target options for `.toQueue(queue, payload, props)` — note the message
 * payload is passed as `.toQueue`'s second argument, not via `input`.
 */
export interface QueueTargetProps {
  /** JSON-serializable payload used as the message body. */
  input?: unknown;
  /** Retry policy for failed deliveries. */
  retryPolicy?: scheduler.RetryPolicy;
  /** Dead-letter queue for undeliverable deliveries. */
  deadLetterConfig?: scheduler.DeadLetterConfig;
  /** SQS-specific parameters (e.g. `MessageGroupId` for FIFO queues). */
  sqs?: scheduler.SqsParameters;
}

/**
 * Target options for `.toEcsTask(props)`.
 */
export interface EcsTaskTargetProps {
  /** ECS cluster the task runs on. */
  cluster: Cluster;
  /**
   * Task definition and the roles Scheduler passes to it.
   *
   * This is a builder argument (not resource Props), so the fields are
   * `Input`-typed explicitly: an `AWS.ECS.Task` resource — whose attributes
   * are `Output`s — is directly assignable here.
   */
  task: {
    /** ARN of the task definition to run. */
    taskDefinitionArn: Input<string>;
    /** ARN of the task role (`iam:PassRole` is granted automatically). */
    taskRoleArn: Input<string>;
    /** ARN of the execution role (`iam:PassRole` is granted automatically). */
    executionRoleArn: Input<string>;
  };
  /** Subnets for the task's awsvpc network configuration. */
  subnets: Input<string[]>;
  /** Security groups for the task's awsvpc network configuration. */
  securityGroups?: Input<string[]>;
  /**
   * Whether the task gets a public IP.
   * @default false
   */
  assignPublicIp?: boolean;
  /**
   * Number of tasks to launch per invocation.
   * @default 1
   */
  taskCount?: number;
  /** JSON-serializable payload passed to the task as the event. */
  input?: unknown;
  /** Retry policy for failed task launches. */
  retryPolicy?: scheduler.RetryPolicy;
  /** Dead-letter queue for undeliverable invocations. */
  deadLetterConfig?: scheduler.DeadLetterConfig;
}

export const every = (value: string, options: ScheduleOptions = {}) =>
  makeBuilder({
    expression:
      value.startsWith("rate(") || value.startsWith("cron(")
        ? value
        : `rate(${value})`,
    ...options,
  });

export const cron = (expression: string, options: ScheduleOptions = {}) =>
  makeBuilder({
    expression,
    ...options,
  });

export const at = (date: Date, options: ScheduleOptions = {}) =>
  makeBuilder({
    expression: `at(${date.toISOString().replace(/\.\d{3}Z$/, "Z")})`,
    ...options,
  });

/**
 * The fluent schedule builder returned by `every`/`cron`/`at`. Route it to a
 * target with `.toLambda`/`.toQueue`/`.toEcsTask`, or consume it on the host
 * Function with `consumeSchedule(builder, handler)`.
 */
export type ScheduleBuilder = ReturnType<typeof makeBuilder>;

const makeBuilder = (state: ScheduleBuilderState) => ({
  /**
   * The accumulated builder state (expression, name, group, ...). Read by
   * `consumeSchedule` to materialize the schedule against the host Function.
   */
  state,

  named: (name: string) =>
    makeBuilder({
      ...state,
      name,
    }),

  toLambda: (fn: Function, props: LambdaTargetProps = {}) =>
    materializeSchedule(
      state,
      fn.LogicalId,
      [
        {
          Effect: "Allow",
          Action: ["lambda:InvokeFunction"],
          Resource: [fn.functionArn],
        },
      ],
      {
        Arn: fn.functionArn as any,
        Input: toInput(props.input),
        RetryPolicy: props.retryPolicy,
        DeadLetterConfig: props.deadLetterConfig,
      },
    ),

  toQueue: (
    queue: Queue,
    payload?: unknown,
    props: Omit<QueueTargetProps, "input"> = {},
  ) =>
    materializeSchedule(
      state,
      queue.LogicalId,
      [
        {
          Effect: "Allow",
          Action: ["sqs:SendMessage"],
          Resource: [queue.queueArn],
        },
      ],
      {
        Arn: queue.queueArn as any,
        Input: toInput(payload),
        RetryPolicy: props.retryPolicy,
        DeadLetterConfig: props.deadLetterConfig,
        SqsParameters: props.sqs,
      },
    ),

  toEcsTask: (props: EcsTaskTargetProps) =>
    materializeSchedule(
      state,
      props.cluster.LogicalId,
      [
        {
          Effect: "Allow",
          Action: ["ecs:RunTask"],
          Resource: [props.task.taskDefinitionArn],
        },
        {
          Effect: "Allow",
          Action: ["iam:PassRole"],
          Resource: [props.task.taskRoleArn, props.task.executionRoleArn],
        },
      ],
      {
        Arn: props.cluster.clusterArn as any,
        Input: toInput(props.input),
        RetryPolicy: props.retryPolicy,
        DeadLetterConfig: props.deadLetterConfig,
        EcsParameters: {
          TaskDefinitionArn: props.task.taskDefinitionArn,
          TaskCount: props.taskCount ?? 1,
          LaunchType: "FARGATE",
          NetworkConfiguration: {
            awsvpcConfiguration: {
              Subnets: props.subnets,
              SecurityGroups: props.securityGroups,
              AssignPublicIp: props.assignPublicIp ? "ENABLED" : "DISABLED",
            },
          },
        },
      },
    ),
});

const materializeSchedule = (
  state: ScheduleBuilderState,
  targetId: string,
  statements: any[],
  // `InputProps` so target fields may carry unresolved `Output`s (e.g. a
  // Task's `taskDefinitionArn`); they flow into the `Schedule` resource's
  // Input-typed `target` prop and resolve at deploy time.
  target: InputProps<Omit<scheduler.Target, "RoleArn">>,
) =>
  Effect.gen(function* () {
    const scheduleId = state.name ?? `${targetId}Schedule`;
    const role = yield* IAM.Role(`${scheduleId}Role`, {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Service: "scheduler.amazonaws.com",
            },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        ScheduleTarget: {
          Version: "2012-10-17",
          Statement: statements,
        },
      },
    });

    return yield* Schedule(scheduleId, {
      name: state.name,
      groupName: state.group?.scheduleGroupName,
      scheduleExpression: state.expression,
      startDate: state.startDate,
      endDate: state.endDate,
      description: state.description,
      scheduleExpressionTimezone: state.timezone,
      state: state.state,
      kmsKeyArn: state.kmsKeyArn,
      flexibleTimeWindow: state.flexibleTimeWindow ?? {
        Mode: "OFF",
      },
      actionAfterCompletion: state.actionAfterCompletion,
      target: {
        ...target,
        RoleArn: role.roleArn,
      } as any,
    });
  });

const toInput = (value: unknown) =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
