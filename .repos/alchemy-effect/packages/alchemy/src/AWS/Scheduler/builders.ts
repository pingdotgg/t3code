import type * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import type { Cluster } from "../ECS/Cluster.ts";
import * as IAM from "../IAM/index.ts";
import type { Function } from "../Lambda/Function.ts";
import type { Queue } from "../SQS/Queue.ts";
import { Schedule } from "./Schedule.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

interface ScheduleBuilderState {
  expression: string;
  name?: string;
  group?: ScheduleGroup;
  description?: string;
  timezone?: string;
  startDate?: Date;
  endDate?: Date;
  state?: string;
  kmsKeyArn?: string;
  flexibleTimeWindow?: scheduler.FlexibleTimeWindow;
  actionAfterCompletion?: string;
}

export interface ScheduleOptions {
  group?: ScheduleGroup;
  description?: string;
  timezone?: string;
  startDate?: Date;
  endDate?: Date;
  state?: string;
  kmsKeyArn?: string;
  flexibleTimeWindow?: scheduler.FlexibleTimeWindow;
  actionAfterCompletion?: string;
}

export interface LambdaTargetProps {
  input?: unknown;
  retryPolicy?: scheduler.RetryPolicy;
  deadLetterConfig?: scheduler.DeadLetterConfig;
}

export interface QueueTargetProps {
  input?: unknown;
  retryPolicy?: scheduler.RetryPolicy;
  deadLetterConfig?: scheduler.DeadLetterConfig;
  sqs?: scheduler.SqsParameters;
}

export interface EcsTaskTargetProps {
  cluster: Cluster;
  task: {
    taskDefinitionArn: string;
    taskRoleArn: string;
    executionRoleArn: string;
  };
  subnets: string[];
  securityGroups?: string[];
  assignPublicIp?: boolean;
  taskCount?: number;
  input?: unknown;
  retryPolicy?: scheduler.RetryPolicy;
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

const makeBuilder = (state: ScheduleBuilderState) => ({
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
  target: Omit<scheduler.Target, "RoleArn">,
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
            Resource: ["*"],
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
