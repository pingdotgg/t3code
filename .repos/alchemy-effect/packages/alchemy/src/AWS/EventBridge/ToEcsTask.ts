import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as IAM from "../IAM/index.ts";
import type { Cluster } from "../ECS/Cluster.ts";
import type { EventBus } from "./EventBus.ts";
import { Rule, type RuleProps, type RuleTarget } from "./Rule.ts";

interface EventDescriptor {
  id?: string;
  bus?: EventBus;
  pattern: Record<string, any>;
  props?: Pick<RuleProps, "description" | "state">;
}

export interface EcsRouteTargetProps extends Pick<
  RuleTarget,
  | "Input"
  | "InputPath"
  | "InputTransformer"
  | "RetryPolicy"
  | "DeadLetterConfig"
> {
  task: {
    taskDefinitionArn: string;
    taskRoleArn: string;
    executionRoleArn: string;
  };
  subnets: string[];
  securityGroups?: string[];
  assignPublicIp?: boolean;
  taskCount?: number;
}

export const toEcsTask = (
  descriptor: EventDescriptor,
  cluster: Cluster,
  props: EcsRouteTargetProps,
) =>
  Effect.gen(function* () {
    const routeId =
      descriptor.id ?? createRouteId(descriptor, `${cluster.LogicalId}Ecs`);

    const role = yield* IAM.Role(`${routeId}${cluster.LogicalId}Role`, {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Service: "events.amazonaws.com",
            },
            Action: ["sts:AssumeRole"],
            Resource: ["*"],
          },
        ],
      },
      inlinePolicies: {
        RunTask: {
          Version: "2012-10-17",
          Statement: [
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
        },
      },
    });

    return yield* Rule(routeId, {
      description: descriptor.props?.description,
      state: descriptor.props?.state,
      eventBusName: descriptor.bus?.eventBusName,
      eventPattern: descriptor.pattern,
      targets: [
        {
          Id: `${cluster.LogicalId}Target`,
          Arn: cluster.clusterArn as any,
          RoleArn: role.roleArn as any,
          Input: props.Input,
          InputPath: props.InputPath,
          InputTransformer: props.InputTransformer,
          RetryPolicy: props.RetryPolicy,
          DeadLetterConfig: props.DeadLetterConfig,
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
      ],
    });
  });

const createRouteId = (descriptor: EventDescriptor, suffix: string) =>
  `EventBridge${createHash("sha1")
    .update(
      JSON.stringify({
        bus: descriptor.bus?.LogicalId ?? "default",
        pattern: descriptor.pattern,
        suffix,
      }),
    )
    .digest("hex")
    .slice(0, 10)}`;
