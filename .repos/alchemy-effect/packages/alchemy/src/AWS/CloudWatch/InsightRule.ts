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
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
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
    /** Physical name of the insight rule. */
    ruleName: InsightRuleName;
    /** ARN of the insight rule. */
    ruleArn: InsightRuleArn;
    /** Current state of the rule (`ENABLED` or `DISABLED`). */
    state: string | undefined;
    /** The full InsightRule description as last read from CloudWatch. */
    insightRule: cloudwatch.InsightRule;
    /** Tags on the insight rule, including the internal Alchemy ownership tags. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Contributor Insights rule — analyzes log group entries to
 * surface the top-N contributors (IPs, user IDs, …) to a metric derived
 * from structured logs.
 * @resource
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
 *     LogGroupNames: ["/my-app/access-logs"],
 *     LogFormat: "JSON",
 *     Contribution: {
 *       Keys: ["$.ip"],
 *     },
 *     AggregateOn: "Count",
 *   },
 * });
 * ```
 *
 * @section Reading Reports at Runtime
 * @example Fetch the Rule's Top Contributors from a Function
 * ```typescript
 * // init — bind the rule to the function (see GetInsightRuleReport)
 * const getInsightRuleReport = yield* AWS.CloudWatch.GetInsightRuleReport(rule);
 *
 * // runtime
 * const now = yield* Effect.sync(() => Date.now());
 * const report = yield* getInsightRuleReport({
 *   StartTime: new Date(now - 3_600_000),
 *   EndTime: new Date(now),
 *   Period: 300,
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
      const createRuleName = (id: string, props: { name?: string } = {}) =>
        createName(id, props.name, 255);

      const ruleArn = (name: string) =>
        AWSEnvironment.current.pipe(
          Effect.map(
            (env) =>
              `arn:aws:cloudwatch:${env.region}:${env.accountId}:insight-rule/${name}` as InsightRuleArn,
          ),
        );

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

        const arn = yield* ruleArn(insightRule.Name);
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
            resourceArn: yield* ruleArn(name),
            olds: olds?.tags ?? existing?.tags,
            news: news.tags,
          });

          yield* session.note(yield* ruleArn(name));

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
        list: () =>
          Effect.gen(function* () {
            // Enumerate every Contributor Insights rule in the account/region
            // by exhaustively paginating `describeInsightRules` (items live
            // under the `InsightRules` field). ARNs are reconstructed from the
            // ambient region/account since the API returns names only.
            const { accountId, region } = yield* AWSEnvironment.current;
            const rules = yield* cloudwatch.describeInsightRules.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.InsightRules ?? []).filter(
                    (
                      candidate,
                    ): candidate is typeof candidate & {
                      Name: string;
                    } =>
                      candidate.Name != null &&
                      // Rules owned by another service reject
                      // DeleteInsightRules with AccessDenied. DynamoDB
                      // Contributor Insights rules are the pathological case:
                      // they report `ManagedRule: false` yet still can only
                      // be removed through DynamoDB (verified live), so match
                      // both the flag and the documented name prefix. Keep
                      // them out of enumeration for account-wide teardown
                      // (nuke).
                      candidate.ManagedRule !== true &&
                      !candidate.Name.startsWith(
                        "DynamoDBContributorInsights-",
                      ),
                  ),
                ),
              ),
            );

            const attrs: InsightRule["Attributes"][] = yield* Effect.forEach(
              rules,
              (insightRule) => {
                const arn =
                  `arn:aws:cloudwatch:${region}:${accountId}:insight-rule/${insightRule.Name}` as InsightRuleArn;
                return readResourceTags(arn).pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed({}),
                  ),
                  Effect.map((tags) => ({
                    ruleName: insightRule.Name,
                    ruleArn: arn,
                    state: insightRule.State,
                    insightRule,
                    tags,
                  })),
                );
              },
              { concurrency: 10 },
            );
            return attrs;
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
