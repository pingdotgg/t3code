import { Region } from "@distilled.cloud/aws/Region";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";

export type {
  AppSyncParameters,
  AssignPublicIp,
  AwsVpcConfiguration,
  CapacityProviderStrategyItem,
  HttpParameters,
  InputTransformer,
  KinesisParameters,
  LaunchType,
  NetworkConfiguration,
  PlacementConstraint,
  PlacementConstraintType,
  PlacementStrategy,
  PlacementStrategyType,
  PropagateTags,
  RedshiftDataParameters,
  RetryPolicy,
  RuleState,
  RunCommandParameters,
  RunCommandTarget,
  SageMakerPipelineParameter,
  SageMakerPipelineParameters,
  SqsParameters,
} from "@distilled.cloud/aws/eventbridge";

export type RuleName = string;

export type RuleArn = `arn:aws:events:${RegionID}:${AccountID}:rule/${string}`;

export interface RuleTarget {
  /** Unique identifier for this target within the rule. */
  Id: string;
  /** ARN of the target resource. */
  Arn: string;
  /** ARN of the IAM role to use for this target when the rule is triggered. */
  RoleArn?: string;
  /** Valid JSON text passed to the target. Mutually exclusive with InputPath and InputTransformer. */
  Input?: string;
  /** JSONPath expression to extract from the event and send to the target. Mutually exclusive with Input and InputTransformer. */
  InputPath?: string;
  /** Settings to transform input before sending to the target. Mutually exclusive with Input and InputPath. */
  InputTransformer?: eventbridge.InputTransformer;
  /** Settings for a Kinesis Data Stream target. */
  KinesisParameters?: eventbridge.KinesisParameters;
  /** Parameters for Systems Manager Run Command targets. */
  RunCommandParameters?: eventbridge.RunCommandParameters;
  /** Parameters for ECS task targets. */
  EcsParameters?: RuleTargetEcsParameters;
  /** Parameters for AWS Batch job targets. */
  BatchParameters?: RuleTargetBatchParameters;
  /** Parameters for SQS queue targets (e.g., FIFO message group ID). */
  SqsParameters?: eventbridge.SqsParameters;
  /** Parameters for HTTP endpoint targets (API Gateway, API Destinations). */
  HttpParameters?: eventbridge.HttpParameters;
  /** Parameters for Amazon Redshift Data API targets. */
  RedshiftDataParameters?: eventbridge.RedshiftDataParameters;
  /** Parameters for SageMaker Pipeline targets. */
  SageMakerPipelineParameters?: eventbridge.SageMakerPipelineParameters;
  /** Dead-letter queue configuration for failed event delivery. */
  DeadLetterConfig?: RuleTargetDeadLetterConfig;
  /** Retry policy settings for the target. */
  RetryPolicy?: eventbridge.RetryPolicy;
  /** Parameters for AWS AppSync GraphQL API targets. */
  AppSyncParameters?: eventbridge.AppSyncParameters;
}

/** ECS parameters for a rule target with Input-wrapped ARN fields. */
export interface RuleTargetEcsParameters extends Omit<
  eventbridge.EcsParameters,
  "TaskDefinitionArn"
> {
  /** ARN of the ECS task definition to run. */
  TaskDefinitionArn: string;
}

/** Batch parameters for a rule target with Input-wrapped ARN fields. */
export interface RuleTargetBatchParameters extends Omit<
  eventbridge.BatchParameters,
  "JobDefinition"
> {
  /** ARN or name of the Batch job definition. */
  JobDefinition: string;
}

/** Dead-letter config for a rule target with Input-wrapped ARN. */
export interface RuleTargetDeadLetterConfig {
  /** ARN of the SQS queue used as the dead-letter queue. */
  Arn?: string;
}

export interface RuleProps {
  /**
   * Name of the rule. Must match [\.\-_A-Za-z0-9]+, 1-64 characters.
   * If omitted, a unique name will be generated.
   */
  name?: string;

  /**
   * Description of the rule. Max 512 characters.
   */
  description?: string;

  /**
   * The name or ARN of the event bus to associate with this rule.
   * If omitted, the default event bus is used.
   */
  eventBusName?: string;

  /**
   * The event pattern that triggers this rule. Specified as a JSON-compatible object.
   * A rule must contain at least an eventPattern or scheduleExpression.
   */
  eventPattern?: Record<string, any>;

  /**
   * The scheduling expression (e.g. "rate(5 minutes)", "cron(0 20 * * ? *)").
   * A rule must contain at least an eventPattern or scheduleExpression.
   */
  scheduleExpression?: string;

  /**
   * Whether the rule is enabled or disabled.
   * @default "ENABLED"
   */
  state?: eventbridge.RuleState;

  /**
   * ARN of the IAM role associated with the rule. Required for targets that need
   * IAM roles (e.g. Kinesis, Step Functions, ECS, API Gateway).
   */
  roleArn?: string;

  /**
   * The targets to invoke when this rule is triggered. Maximum 5 targets per rule.
   */
  targets?: RuleTarget[];

  /**
   * Tags to assign to the rule.
   */
  tags?: Record<string, string>;
}

/**
 * An Amazon EventBridge rule that matches events and routes them to targets.
 *
 * @section Creating Rules
 * @example Event Pattern Rule
 * ```typescript
 * const rule = yield* Rule("S3Events", {
 *   eventPattern: {
 *     source: ["aws.s3"],
 *     "detail-type": ["Object Created"],
 *   },
 *   targets: [{
 *     Id: "MyTarget",
 *     Arn: yield* queue.queueArn,
 *   }],
 * });
 * ```
 *
 * @example Scheduled Rule
 * ```typescript
 * const rule = yield* Rule("EveryFiveMinutes", {
 *   scheduleExpression: "rate(5 minutes)",
 *   targets: [{
 *     Id: "LambdaTarget",
 *     Arn: yield* fn.functionArn(),
 *   }],
 * });
 * ```
 *
 * @section Targeting
 * @example Rule with Input Transformer
 * ```typescript
 * const rule = yield* Rule("TransformedEvents", {
 *   eventPattern: {
 *     source: ["aws.ec2"],
 *     "detail-type": ["EC2 Instance State-change Notification"],
 *   },
 *   targets: [{
 *     Id: "SqsTarget",
 *     Arn: yield* queue.queueArn,
 *     InputTransformer: {
 *       InputPathsMap: {
 *         instance: "$.detail.instance-id",
 *         state: "$.detail.state",
 *       },
 *       InputTemplate: '{"instanceId": <instance>, "newState": <state>}',
 *     },
 *   }],
 * });
 * ```
 *
 * @example Rule with Dead Letter Queue
 * ```typescript
 * const rule = yield* Rule("ReliableEvents", {
 *   eventPattern: { source: ["my.app"] },
 *   targets: [{
 *     Id: "Target",
 *     Arn: yield* fn.functionArn(),
 *     DeadLetterConfig: {
 *       Arn: yield* dlq.queueArn,
 *     },
 *     RetryPolicy: {
 *       MaximumRetryAttempts: 3,
 *       MaximumEventAgeInSeconds: 3600,
 *     },
 *   }],
 * });
 * ```
 *
 * @example Rule with ECS Target
 * ```typescript
 * const rule = yield* Rule("EcsSchedule", {
 *   scheduleExpression: "rate(1 hour)",
 *   roleArn: yield* role.roleArn(),
 *   targets: [{
 *     Id: "EcsTask",
 *     Arn: yield* cluster.clusterArn(),
 *     RoleArn: yield* ecsRole.roleArn(),
 *     EcsParameters: {
 *       TaskDefinitionArn: yield* taskDef.taskDefinitionArn(),
 *       TaskCount: 1,
 *       LaunchType: "FARGATE",
 *       NetworkConfiguration: {
 *         awsvpcConfiguration: {
 *           Subnets: ["subnet-abc123"],
 *           AssignPublicIp: "ENABLED",
 *         },
 *       },
 *     },
 *   }],
 * });
 * ```
 */
export interface Rule extends Resource<
  "AWS.EventBridge.Rule",
  RuleProps,
  {
    /** The name of the rule. */
    ruleName: RuleName;
    /** The ARN of the rule. */
    ruleArn: RuleArn;
    /** The event bus associated with the rule. */
    eventBusName: string;
  },
  never,
  Providers
> {}
export const Rule = Resource<Rule>("AWS.EventBridge.Rule");

export const RuleProvider = () =>
  Provider.effect(
    Rule,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      const createRuleName = (id: string, props: { name?: string } = {}) => {
        if (props.name) {
          return Effect.succeed(props.name);
        }
        return createPhysicalName({
          id,
          maxLength: 64,
        });
      };

      return {
        stables: ["ruleName", "ruleArn", "eventBusName"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* createRuleName(id, olds);
          const newName = yield* createRuleName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          const oldBus = (olds.eventBusName as string | undefined) ?? "default";
          const newBus = (news.eventBusName as string | undefined) ?? "default";
          if (oldBus !== newBus) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const ruleName =
            output?.ruleName ?? (yield* createRuleName(id, olds));
          const eventBusName =
            output?.eventBusName ?? olds.eventBusName ?? "default";
          const described = yield* eventbridge
            .describeRule({
              Name: ruleName,
              EventBusName:
                eventBusName !== "default" ? eventBusName : undefined,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!described?.Name) {
            return undefined;
          }

          const resolvedEventBusName = described.EventBusName ?? eventBusName;
          const ruleArn = toRuleArn(
            region,
            accountId,
            resolvedEventBusName,
            described.Name,
          );
          const { Tags } = yield* eventbridge.listTagsForResource({
            ResourceARN: described.Arn ?? ruleArn,
          });
          const attrs = {
            ruleName: described.Name,
            ruleArn,
            eventBusName: resolvedEventBusName,
          };
          return (yield* hasAlchemyTags(id, Tags ?? []))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          yield* validateRuleProps(news);
          const ruleName =
            output?.ruleName ?? (yield* createRuleName(id, news));
          const eventBusName =
            output?.eventBusName ??
            (news.eventBusName as string | undefined) ??
            "default";
          const eventBusParam =
            eventBusName !== "default" ? eventBusName : undefined;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = {
            ...internalTags,
            ...(news.tags as Record<string, string> | undefined),
          };

          // Ensure + Sync rule definition — `putRule` is the single
          // create-or-update API for the rule itself. It's idempotent on
          // matching params and overwrites schedule/eventPattern/state/etc.
          // on differences, so we call it unconditionally. `Tags` only
          // applies when creating; tags are reconciled separately below
          // against observed cloud tags.
          const { RuleArn } = yield* eventbridge.putRule({
            Name: ruleName,
            Description: news.description,
            EventBusName: eventBusParam,
            EventPattern: news.eventPattern
              ? JSON.stringify(news.eventPattern)
              : undefined,
            ScheduleExpression: news.scheduleExpression,
            State: news.state ?? "ENABLED",
            RoleArn: news.roleArn as string | undefined,
            Tags: createTagsList(desiredTags),
          });
          const ruleArn =
            (RuleArn as RuleArn | undefined) ??
            toRuleArn(region, accountId, eventBusName, ruleName);

          // Sync targets — observed cloud targets vs desired. `listTargetsByRule`
          // gives us the live target ids; we remove anything no longer desired,
          // and `putTargets` overwrites/upserts the rest.
          const resolvedTargets =
            (news.targets as Input.Resolve<RuleTarget>[] | undefined) ?? [];
          const desiredTargetIds = new Set(resolvedTargets.map((t) => t.Id));
          const observedTargets = yield* eventbridge
            .listTargetsByRule({
              Rule: ruleName,
              EventBusName: eventBusParam,
            })
            .pipe(
              Effect.map((r) => r.Targets ?? []),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed([] as eventbridge.Target[]),
              ),
            );
          const removedTargetIds = observedTargets
            .map((t) => t.Id)
            .filter(
              (tid): tid is string => !!tid && !desiredTargetIds.has(tid),
            );

          if (removedTargetIds.length > 0) {
            const response = yield* eventbridge
              .removeTargets({
                Rule: ruleName,
                EventBusName: eventBusParam,
                Ids: removedTargetIds,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );

            if (response) {
              yield* assertRemoveTargetsSucceeded(response);
            }
          }

          if (resolvedTargets.length > 0) {
            const response = yield* eventbridge.putTargets({
              Rule: ruleName,
              EventBusName: eventBusParam,
              Targets: resolvedTargets.map(toTarget),
            });
            yield* assertPutTargetsSucceeded(response);
          }

          // Sync tags — diff observed cloud tags against desired. Adoption
          // and partial prior runs both converge here.
          const observedTagsList = yield* eventbridge
            .listTagsForResource({
              ResourceARN: ruleArn,
            })
            .pipe(Effect.map((r) => r.Tags ?? []));
          const observedTags: Record<string, string> = {};
          for (const tag of observedTagsList) {
            if (tag.Key && tag.Value !== undefined) {
              observedTags[tag.Key] = tag.Value;
            }
          }
          const { removed, upsert } = diffTags(observedTags, desiredTags);

          if (removed.length > 0) {
            yield* eventbridge.untagResource({
              ResourceARN: ruleArn,
              TagKeys: removed,
            });
          }

          if (upsert.length > 0) {
            yield* eventbridge.tagResource({
              ResourceARN: ruleArn,
              Tags: upsert,
            });
          }

          yield* session.note(ruleArn);
          return {
            ruleName,
            ruleArn,
            eventBusName,
          };
        }),
        delete: Effect.fn(function* (input) {
          const ruleName = input.output.ruleName;
          const eventBusName = input.output.eventBusName;
          const eventBusParam =
            eventBusName !== "default" ? eventBusName : undefined;

          const { Targets } = yield* eventbridge
            .listTargetsByRule({
              Rule: ruleName,
              EventBusName: eventBusParam,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({ Targets: undefined }),
              ),
            );

          if (Targets && Targets.length > 0) {
            const response = yield* eventbridge
              .removeTargets({
                Rule: ruleName,
                EventBusName: eventBusParam,
                Ids: Targets.map((t) => t.Id),
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
            if (response) {
              yield* assertRemoveTargetsSucceeded(response);
            }
          }

          yield* eventbridge
            .deleteRule({
              Name: ruleName,
              EventBusName: eventBusParam,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

const toTarget = (target: Input.Resolve<RuleTarget>): eventbridge.Target => ({
  Id: target.Id,
  Arn: target.Arn,
  RoleArn: target.RoleArn,
  Input: target.Input,
  InputPath: target.InputPath,
  InputTransformer: target.InputTransformer,
  KinesisParameters: target.KinesisParameters,
  RunCommandParameters: target.RunCommandParameters,
  EcsParameters: target.EcsParameters
    ? {
        ...target.EcsParameters,
        TaskDefinitionArn: target.EcsParameters.TaskDefinitionArn,
      }
    : undefined,
  BatchParameters: target.BatchParameters
    ? {
        ...target.BatchParameters,
        JobDefinition: target.BatchParameters.JobDefinition,
      }
    : undefined,
  SqsParameters: target.SqsParameters,
  HttpParameters: target.HttpParameters,
  RedshiftDataParameters: target.RedshiftDataParameters,
  SageMakerPipelineParameters: target.SageMakerPipelineParameters,
  DeadLetterConfig: target.DeadLetterConfig
    ? { Arn: target.DeadLetterConfig.Arn }
    : undefined,
  RetryPolicy: target.RetryPolicy,
  AppSyncParameters: target.AppSyncParameters,
});

const toRuleArn = (
  region: RegionID,
  accountId: AccountID,
  eventBusName: string,
  ruleName: string,
): RuleArn =>
  (eventBusName === "default"
    ? `arn:aws:events:${region}:${accountId}:rule/${ruleName}`
    : `arn:aws:events:${region}:${accountId}:rule/${eventBusName}/${ruleName}`) as RuleArn;

const validateRuleProps = Effect.fn(function* (props: RuleProps) {
  if (!props.eventPattern && !props.scheduleExpression) {
    return yield* Effect.fail(
      new Error(
        "EventBridge Rule requires either `eventPattern` or `scheduleExpression`",
      ),
    );
  }
});

const assertPutTargetsSucceeded = Effect.fn(function* (
  response: eventbridge.PutTargetsResponse,
) {
  if ((response.FailedEntryCount ?? 0) > 0) {
    return yield* Effect.fail(
      new Error(
        `Failed to attach EventBridge targets: ${JSON.stringify(response.FailedEntries ?? [])}`,
      ),
    );
  }
});

const assertRemoveTargetsSucceeded = Effect.fn(function* (
  response: eventbridge.RemoveTargetsResponse,
) {
  if ((response.FailedEntryCount ?? 0) > 0) {
    return yield* Effect.fail(
      new Error(
        `Failed to remove EventBridge targets: ${JSON.stringify(response.FailedEntries ?? [])}`,
      ),
    );
  }
});
