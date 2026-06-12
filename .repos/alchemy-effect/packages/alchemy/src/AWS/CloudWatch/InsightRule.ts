import { Region } from "@distilled.cloud/aws/Region";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import {
  createName,
  readResourceTags,
  retryConcurrent,
  updateResourceTags,
} from "./common.ts";

export type InsightRuleName = string;
export type InsightRuleArn =
  `arn:aws:cloudwatch:${RegionID}:${AccountID}:insight-rule/${string}`;

export interface CloudWatchLogRuleFilter {
  Match: string;
  In: string[];
}

export interface CloudWatchLogRuleDefinition {
  Schema: {
    Name: "CloudWatchLogRule";
    Version: 1;
  };
  LogGroupNames?: string[];
  LogGroupARNs?: string[];
  LogFormat: "JSON" | "CLF" | (string & {});
  Contribution: {
    Keys: string[];
    ValueOf?: string;
    Filters?: CloudWatchLogRuleFilter[];
  };
  AggregateOn: "Count" | "Sum" | (string & {});
}

export interface InsightRuleProps extends Omit<
  cloudwatch.PutInsightRuleInput,
  "RuleDefinition" | "RuleName" | "Tags"
> {
  /**
   * Name of the insight rule. If omitted, a unique name is generated.
   */
  name?: InsightRuleName;
  /**
   * Optional tags to apply to the insight rule.
   */
  tags?: Record<string, string>;
  /**
   * Typed Contributor Insights rule definition. The provider serializes this
   * object to the JSON string expected by the CloudWatch API.
   */
  RuleDefinition?: CloudWatchLogRuleDefinition;
}

export interface InsightRule extends Resource<
  "AWS.CloudWatch.InsightRule",
  InsightRuleProps,
  {
    ruleName: InsightRuleName;
    ruleArn: InsightRuleArn;
    state: string | undefined;
    insightRule: cloudwatch.InsightRule;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Contributor Insights rule.
 *
 * @section Creating Insight Rules
 * @example Rule Definition
 * ```typescript
 * const rule = yield* InsightRule("TopContributors", {
 *   RuleState: "ENABLED",
 *   RuleDefinition: {
 *     Schema: {
 *       Name: "CloudWatchLogRule",
 *       Version: 1,
 *     },
 *     LogFormat: "JSON",
 *     Contribution: {
 *       Keys: ["$.ip"],
 *     },
 *     AggregateOn: "Count",
 *   },
 * });
 * ```
 */
export const InsightRule = Resource<InsightRule>("AWS.CloudWatch.InsightRule");

const failureMessage = (failures: cloudwatch.PartialFailure[] | undefined) =>
  (failures ?? [])
    .map(
      (failure) =>
        `${failure.FailureResource ?? "unknown"}: ${failure.FailureCode ?? failure.ExceptionType ?? "failed"}`,
    )
    .join(", ");

const toPutInsightRuleInput = ({
  RuleDefinition,
  ...input
}: InsightRuleProps): cloudwatch.PutInsightRuleInput => ({
  ...input,
  RuleDefinition: RuleDefinition ? JSON.stringify(RuleDefinition) : undefined,
});

export const InsightRuleProvider = () =>
  Provider.effect(
    InsightRule,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      const createRuleName = (id: string, props: { name?: string } = {}) =>
        createName(id, props.name, 255);

      const ruleArn = (name: string) =>
        `arn:aws:cloudwatch:${region}:${accountId}:insight-rule/${name}` as InsightRuleArn;

      const readInsightRule = Effect.fn(function* (name: string) {
        const insightRule = yield* cloudwatch.describeInsightRules
          .pages({})
          .pipe(
            Stream.mapEffect(
              Effect.fn(function* (page) {
                return page.InsightRules?.find(
                  (candidate) => candidate.Name === name,
                );
              }),
            ),
            Stream.filter((candidate) => candidate !== undefined),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );

        if (!insightRule?.Name) {
          return undefined;
        }

        const arn = ruleArn(insightRule.Name);
        const tags = yield* readResourceTags(arn).pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({}),
          ),
        );

        return {
          ruleName: insightRule.Name,
          ruleArn: arn,
          state: insightRule.State,
          insightRule,
          tags,
        };
      });

      return {
        stables: ["ruleName", "ruleArn"],
        diff: Effect.fn(function* ({
          id,
          olds = {},
          news = {} as Input<InsightRuleProps>,
        }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createRuleName(id, olds);
          const newName = yield* createRuleName(id, news);

          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.ruleName ?? (yield* createRuleName(id, olds ?? {}));
          const state = yield* readInsightRule(name);
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags))
            ? state
            : Unowned(state);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          // Observe — pin the physical name from `output` if present;
          // otherwise derive from desired props. Read whatever exists in
          // CloudWatch so we have a baseline for tag-diffing on adoption.
          const name = output?.ruleName ?? (yield* createRuleName(id, news));
          const existing = yield* readInsightRule(name);

          // Ensure — `putInsightRule` is an upsert; sending the full
          // desired config every reconcile converges the cloud.
          yield* retryConcurrent(
            cloudwatch.putInsightRule({
              ...toPutInsightRuleInput(news),
              RuleName: name,
            }),
          );

          // Sync tags — diff against `olds.tags` when we have prior state,
          // otherwise fall back to what we observed. Adoption flows take
          // the latter path.
          const tags = yield* updateResourceTags({
            id,
            resourceArn: ruleArn(name),
            olds: olds?.tags ?? existing?.tags,
            news: news.tags,
          });

          yield* session.note(ruleArn(name));

          const state = yield* readInsightRule(name);
          if (!state) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled insight rule '${name}'`),
            );
          }

          return {
            ...state,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const existing = yield* readInsightRule(output.ruleName);
          if (!existing) {
            return;
          }

          const response = yield* retryConcurrent(
            cloudwatch.deleteInsightRules({
              RuleNames: [output.ruleName],
            }),
          );

          if ((response.Failures?.length ?? 0) > 0) {
            return yield* Effect.fail(
              new Error(
                `failed to delete insight rule '${output.ruleName}': ${failureMessage(response.Failures)}`,
              ),
            );
          }
        }),
      };
    }),
  );
