import * as config from "@distilled.cloud/aws/config-service";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * How often AWS Config runs evaluations for a periodic rule.
 */
export type ConfigMaximumExecutionFrequency =
  | "One_Hour"
  | "Three_Hours"
  | "Six_Hours"
  | "Twelve_Hours"
  | "TwentyFour_Hours";

export interface ConfigRuleSourceDetail {
  /**
   * The source of the event that triggers evaluation.
   * @default "aws.config"
   */
  eventSource?: string;
  /**
   * The type of notification that triggers evaluation, e.g.
   * `ConfigurationItemChangeNotification` or `ScheduledNotification`.
   */
  messageType?: string;
  /**
   * The frequency at which the rule is evaluated when the message type is
   * `ScheduledNotification`.
   */
  maximumExecutionFrequency?: ConfigMaximumExecutionFrequency;
}

export interface ConfigRuleSource {
  /**
   * Who owns and maintains the rule logic. `AWS` for managed rules,
   * `CUSTOM_LAMBDA` for Lambda-backed custom rules, `CUSTOM_POLICY` for
   * Guard custom-policy rules.
   */
  owner: "AWS" | "CUSTOM_LAMBDA" | "CUSTOM_POLICY";
  /**
   * For managed rules, the rule identifier, e.g.
   * `S3_BUCKET_VERSIONING_ENABLED`. For custom Lambda rules, the ARN of the
   * rule's Lambda function.
   */
  sourceIdentifier?: string;
  /**
   * The source and type of events that trigger evaluation. Required for
   * custom Lambda rules; not used for managed rules.
   */
  sourceDetails?: ConfigRuleSourceDetail[];
  /**
   * Guard policy details for `CUSTOM_POLICY` rules.
   */
  customPolicyDetails?: {
    /**
     * The runtime system for the Guard policy, e.g. `guard-2.x.x`.
     */
    policyRuntime: string;
    /**
     * The Guard policy text.
     */
    policyText: string;
    /**
     * Whether to log Guard debug output.
     * @default false
     */
    enableDebugLogDelivery?: boolean;
  };
}

export interface ConfigRuleScope {
  /**
   * Resource types the rule evaluates, e.g. `AWS::S3::Bucket`.
   */
  complianceResourceTypes?: string[];
  /**
   * Tag key applied to resources the rule evaluates.
   */
  tagKey?: string;
  /**
   * Tag value applied to resources the rule evaluates. Requires `tagKey`.
   */
  tagValue?: string;
  /**
   * The ID of a single resource the rule evaluates. Requires exactly one
   * entry in `complianceResourceTypes`.
   */
  complianceResourceId?: string;
}

export interface ConfigRuleProps {
  /**
   * Name of the Config rule. Changing the name replaces the rule.
   * @default ${app}-${stage}-${id}
   */
  configRuleName?: string;
  /**
   * Description of the rule.
   */
  description?: string;
  /**
   * The rule's source: owner (AWS-managed, custom Lambda, or Guard custom
   * policy) plus the identifier of the rule logic.
   */
  source: ConfigRuleSource;
  /**
   * Input parameters passed to the rule's evaluation logic, serialized to
   * JSON.
   */
  inputParameters?: Record<string, string>;
  /**
   * The maximum frequency at which AWS Config runs evaluations for a
   * periodic rule.
   */
  maximumExecutionFrequency?: ConfigMaximumExecutionFrequency;
  /**
   * Restricts the rule to a subset of resources by type, tag, or ID. When
   * omitted, evaluations are triggered for all supported resources.
   */
  scope?: ConfigRuleScope;
  /**
   * The evaluation modes the rule runs in.
   * @default ["DETECTIVE"]
   */
  evaluationModes?: ("DETECTIVE" | "PROACTIVE")[];
  /**
   * Tags to apply to the rule. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface ConfigRule extends Resource<
  "AWS.Config.ConfigRule",
  ConfigRuleProps,
  {
    /** Physical name of the config rule. */
    configRuleName: string;
    /** ARN of the config rule. */
    configRuleArn: string;
    /** Unique AWS-assigned rule ID. */
    configRuleId: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Config rule that evaluates whether your AWS resources comply with
 * a desired configuration — either an AWS-managed rule, a custom Lambda
 * rule, or a Guard custom-policy rule.
 *
 * The account/region must have an AWS Config configuration recorder before
 * rules can be created (see `AWS.Config.ConfigurationRecorder`).
 * @resource
 * @section Creating Rules
 * @example AWS-managed rule
 * ```typescript
 * import * as Config from "alchemy/AWS/Config";
 *
 * const rule = yield* Config.ConfigRule("BucketVersioning", {
 *   source: {
 *     owner: "AWS",
 *     sourceIdentifier: "S3_BUCKET_VERSIONING_ENABLED",
 *   },
 * });
 * ```
 *
 * @example Managed rule with input parameters and scope
 * ```typescript
 * const rule = yield* Config.ConfigRule("RequiredTags", {
 *   description: "All buckets must carry a team tag",
 *   source: { owner: "AWS", sourceIdentifier: "REQUIRED_TAGS" },
 *   inputParameters: { tag1Key: "team" },
 *   scope: { complianceResourceTypes: ["AWS::S3::Bucket"] },
 * });
 * ```
 *
 * @section Periodic Evaluation
 * @example Evaluate on a schedule
 * ```typescript
 * const rule = yield* Config.ConfigRule("RootMfa", {
 *   source: {
 *     owner: "AWS",
 *     sourceIdentifier: "ROOT_ACCOUNT_MFA_ENABLED",
 *   },
 *   maximumExecutionFrequency: "TwentyFour_Hours",
 * });
 * ```
 */
export const ConfigRule = Resource<ConfigRule>("AWS.Config.ConfigRule");

/**
 * Raised when a Config rule that was just written does not become visible
 * to `DescribeConfigRules` within the reconciler's bounded wait.
 */
export class ConfigRuleNotVisible extends Data.TaggedError(
  "ConfigRuleNotVisible",
)<{ message: string }> {}

/**
 * `PutConfigRule`/`DeleteConfigRule` reject with `ResourceInUseException`
 * while a rule is in the `DELETING` state (rule deletion is asynchronous).
 * Retry it on a bounded schedule (~40s).
 *
 * Explicitly typed: inlining `Effect.retry` with options in provider
 * lifecycle code can widen the provider layer to `unknown` in declaration
 * emit.
 *
 * @internal
 */
const retryWhileRuleInUse = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ResourceInUseException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(20)]),
  });

/**
 * A freshly-put rule can take a moment to become visible to
 * `DescribeConfigRules`. Bounded retry (~10s).
 * @internal
 */
const retryWhileNotVisible = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConfigRuleNotVisible",
    schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(10)]),
  });

/**
 * Canonical JSON for structural comparison: recursively sorts object keys
 * and drops `undefined` members so wire objects with different key orders
 * compare equal.
 * @internal
 */
const canonical = (value: unknown): string => {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, member]) => member !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, member]) => [k, sortKeys(member)]),
      );
    }
    return v ?? null;
  };
  return JSON.stringify(sortKeys(value));
};

/** @internal */
const parseParams = (params: string | undefined): Record<string, string> =>
  params === undefined || params === "" ? {} : JSON.parse(params);

export const ConfigRuleProvider = () =>
  Provider.effect(
    ConfigRule,
    Effect.gen(function* () {
      const createRuleName = Effect.fn(function* (
        id: string,
        props: Pick<ConfigRuleProps, "configRuleName">,
      ) {
        return (
          props.configRuleName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const toWireRule = (
        name: string,
        props: ConfigRuleProps,
      ): config.ConfigRule => ({
        ConfigRuleName: name,
        Description: props.description,
        Source: {
          Owner: props.source.owner,
          SourceIdentifier: props.source.sourceIdentifier,
          SourceDetails: props.source.sourceDetails?.map((d) => ({
            EventSource: d.eventSource ?? "aws.config",
            MessageType: d.messageType,
            MaximumExecutionFrequency: d.maximumExecutionFrequency,
          })),
          CustomPolicyDetails: props.source.customPolicyDetails
            ? {
                PolicyRuntime: props.source.customPolicyDetails.policyRuntime,
                PolicyText: props.source.customPolicyDetails.policyText,
                EnableDebugLogDelivery:
                  props.source.customPolicyDetails.enableDebugLogDelivery,
              }
            : undefined,
        },
        InputParameters: props.inputParameters
          ? JSON.stringify(props.inputParameters)
          : undefined,
        MaximumExecutionFrequency: props.maximumExecutionFrequency,
        Scope: props.scope
          ? {
              ComplianceResourceTypes: props.scope.complianceResourceTypes,
              TagKey: props.scope.tagKey,
              TagValue: props.scope.tagValue,
              ComplianceResourceId: props.scope.complianceResourceId,
            }
          : undefined,
        EvaluationModes: props.evaluationModes?.map((mode) => ({
          Mode: mode,
        })),
      });

      // A rule is in sync when every aspect the user controls matches the
      // OBSERVED cloud state. Fields AWS defaults when unspecified
      // (EvaluationModes, SourceDetails) are only compared when the user
      // declared them, so an omitted prop never causes perpetual drift.
      const ruleInSync = (
        observed: config.ConfigRule,
        desired: config.ConfigRule,
      ): boolean =>
        (observed.Description ?? undefined) === desired.Description &&
        (observed.MaximumExecutionFrequency ?? undefined) ===
          desired.MaximumExecutionFrequency &&
        canonical(parseParams(observed.InputParameters)) ===
          canonical(parseParams(desired.InputParameters)) &&
        canonical(observed.Scope) === canonical(desired.Scope) &&
        observed.Source.Owner === desired.Source.Owner &&
        (observed.Source.SourceIdentifier ?? undefined) ===
          desired.Source.SourceIdentifier &&
        (desired.Source.SourceDetails === undefined ||
          canonical(observed.Source.SourceDetails) ===
            canonical(desired.Source.SourceDetails)) &&
        (desired.Source.CustomPolicyDetails === undefined ||
          canonical(observed.Source.CustomPolicyDetails) ===
            canonical(desired.Source.CustomPolicyDetails)) &&
        (desired.EvaluationModes === undefined ||
          canonical(observed.EvaluationModes) ===
            canonical(desired.EvaluationModes));

      const observeRule = Effect.fn(function* (ruleName: string) {
        const response = yield* config
          .describeConfigRules({ ConfigRuleNames: [ruleName] })
          .pipe(
            Effect.catchTag("NoSuchConfigRuleException", () =>
              Effect.succeed({ ConfigRules: [] }),
            ),
          );
        return (response.ConfigRules ?? []).at(0);
      });

      const observedTags = (arn: string) =>
        config.listTagsForResource({ ResourceArn: arn }).pipe(
          Effect.map((r) =>
            Object.fromEntries(
              (r.Tags ?? []).flatMap((t) =>
                t.Key !== undefined ? [[t.Key, t.Value ?? ""]] : [],
              ),
            ),
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      const toAttrs = (rule: config.ConfigRule) => ({
        configRuleName: rule.ConfigRuleName!,
        configRuleArn: rule.ConfigRuleArn!,
        configRuleId: rule.ConfigRuleId!,
      });

      return ConfigRule.Provider.of({
        stables: ["configRuleName", "configRuleArn", "configRuleId"],
        list: () =>
          config.describeConfigRules.items({}).pipe(
            Stream.runCollect,
            Effect.map((rules) =>
              Array.from(rules).flatMap((rule) =>
                rule.ConfigRuleName && rule.ConfigRuleArn && rule.ConfigRuleId
                  ? [toAttrs(rule)]
                  : [],
              ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const ruleName =
            output?.configRuleName ?? (yield* createRuleName(id, olds ?? {}));
          const rule = yield* observeRule(ruleName);
          if (rule?.ConfigRuleArn === undefined) return undefined;
          const attrs = toAttrs(rule);
          const tags = yield* observedTags(rule.ConfigRuleArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createRuleName(id, olds ?? {});
          const newName = yield* createRuleName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const ruleName =
            output?.configRuleName ?? (yield* createRuleName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desired = toWireRule(ruleName, news);

          // 1. OBSERVE — cloud state is authoritative.
          const observed = yield* observeRule(ruleName);

          // 2+3. ENSURE + SYNC — PutConfigRule is a full upsert, so a single
          //    call covers both the missing-rule and the drifted-rule case.
          //    Skip the API entirely on no-op. A rule stuck in `DELETING`
          //    rejects with the typed ResourceInUseException; bounded retry.
          if (observed === undefined || !ruleInSync(observed, desired)) {
            yield* retryWhileRuleInUse(
              config.putConfigRule({
                ConfigRule: desired,
                Tags: createTagsList(desiredTags),
              }),
            );
          }

          // 4. RETURN fresh attributes — re-observe for the ARN and ID
          //    (PutConfigRule returns an empty body).
          const live = yield* retryWhileNotVisible(
            observeRule(ruleName).pipe(
              Effect.flatMap((rule) =>
                rule?.ConfigRuleArn !== undefined &&
                rule.ConfigRuleId !== undefined
                  ? Effect.succeed(rule)
                  : Effect.fail(
                      new ConfigRuleNotVisible({
                        message: `Config rule '${ruleName}' was written but is not yet visible to DescribeConfigRules`,
                      }),
                    ),
              ),
            ),
          );

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges (Put-time Tags only apply on first create).
          const currentTags = yield* observedTags(live.ConfigRuleArn!);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* config.tagResource({
              ResourceArn: live.ConfigRuleArn!,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* config.untagResource({
              ResourceArn: live.ConfigRuleArn!,
              TagKeys: removed,
            });
          }

          yield* session.note(ruleName);
          return toAttrs(live);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Rule deletion is asynchronous (state DELETING); a concurrent
          // put/delete surfaces as ResourceInUseException — bounded retry.
          yield* retryWhileRuleInUse(
            config.deleteConfigRule({
              ConfigRuleName: output.configRuleName,
            }),
          ).pipe(
            Effect.catchTag("NoSuchConfigRuleException", () => Effect.void),
          );
        }),
      });
    }),
  );
