import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { fetchCeTags, pinCe, syncCeTags, toResourceTags } from "./common.ts";

export interface CostCategoryProps {
  /**
   * Name of the cost category. Must be unique within the account and between
   * 1 and 50 characters. If omitted, a unique name is generated from the app,
   * stage, and logical ID.
   *
   * Changing the name replaces the cost category.
   */
  name?: string;
  /**
   * The rule schema version.
   * @default "CostCategoryExpression.v1"
   */
  ruleVersion?: "CostCategoryExpression.v1" | (string & {});
  /**
   * The categorization rules, evaluated in order. Each rule maps costs
   * matching its expression to a category value (raw Cost Explorer
   * `CostCategoryRule` shape).
   */
  rules: ce.CostCategoryRule[];
  /**
   * The value assigned to any cost that no rule matches.
   */
  defaultValue?: string;
  /**
   * Rules splitting charges between category values (raw Cost Explorer
   * `CostCategorySplitChargeRule` shape).
   */
  splitChargeRules?: ce.CostCategorySplitChargeRule[];
  /**
   * The category's effective start date (`yyyy-MM-dd'T'HH:mm:ssZ`, first of a
   * month, at most 12 months back).
   * @default the first day of the current month
   */
  effectiveStart?: string;
  /**
   * User-defined tags to apply to the cost category.
   */
  tags?: Record<string, string>;
}

export interface CostCategory extends Resource<
  "AWS.CostExplorer.CostCategory",
  CostCategoryProps,
  {
    /** ARN of the cost category. */
    costCategoryArn: string;
    /** Name of the cost category. */
    name: string;
    /** ISO timestamp the current rule version took effect. */
    effectiveStart: string | undefined;
    /** Current tags on the cost category. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Cost Explorer cost category — rule-based groupings that map your AWS
 * costs into named values (e.g. team, environment, project) usable across
 * Cost Explorer, Budgets, and CUR reports.
 *
 * Cost Explorer is a global service — all calls are pinned to `us-east-1`
 * regardless of the stack region. Rules, the default value, and split-charge
 * rules are mutable in place; changing the name replaces the category.
 *
 * @resource
 * @section Creating Cost Categories
 * @example Categorize by linked account name
 * ```typescript
 * import * as CostExplorer from "alchemy/AWS/CostExplorer";
 *
 * const category = yield* CostExplorer.CostCategory("Environment", {
 *   rules: [
 *     {
 *       Value: "production",
 *       Type: "REGULAR",
 *       Rule: {
 *         Dimensions: {
 *           Key: "LINKED_ACCOUNT_NAME",
 *           MatchOptions: ["ENDS_WITH"],
 *           Values: ["-prod"],
 *         },
 *       },
 *     },
 *   ],
 *   defaultValue: "other",
 * });
 * ```
 *
 * @example Categorize by cost allocation tag
 * ```typescript
 * const category = yield* CostExplorer.CostCategory("Team", {
 *   rules: [
 *     {
 *       Value: "platform",
 *       Type: "REGULAR",
 *       Rule: {
 *         Tags: { Key: "team", Values: ["platform"], MatchOptions: ["EQUALS"] },
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export const CostCategory = Resource<CostCategory>(
  "AWS.CostExplorer.CostCategory",
);

const DEFAULT_RULE_VERSION = "CostCategoryExpression.v1";

export const CostCategoryProvider = () =>
  Provider.effect(
    CostCategory,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 50 }));
      });

      const getByArn = (costCategoryArn: string) =>
        pinCe(
          ce.describeCostCategoryDefinition({
            CostCategoryArn: costCategoryArn,
          }),
        ).pipe(
          Effect.map((r) => r.CostCategory),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      // Fallback observation when no ARN is cached: scan currently-effective
      // definitions for the deterministic physical name.
      const findByName = (name: string) =>
        pinCe(
          ce.listCostCategoryDefinitions.items({}).pipe(
            Stream.filter(
              (r) => r.Name === name && r.EffectiveEnd === undefined,
            ),
            Stream.take(1),
            Stream.runCollect,
          ),
        ).pipe(
          Effect.flatMap((chunk) => {
            const reference = Array.from(chunk)[0];
            return reference?.CostCategoryArn !== undefined
              ? getByArn(reference.CostCategoryArn)
              : Effect.succeed(undefined);
          }),
        );

      const toAttrs = Effect.fn(function* (live: ce.CostCategory) {
        return {
          costCategoryArn: live.CostCategoryArn,
          name: live.Name,
          effectiveStart: live.EffectiveStart,
          tags: yield* fetchCeTags(live.CostCategoryArn),
        };
      });

      return CostCategory.Provider.of({
        stables: ["costCategoryArn", "name"],
        list: () =>
          Effect.gen(function* () {
            const references = yield* pinCe(
              ce.listCostCategoryDefinitions.items({}).pipe(Stream.runCollect),
            ).pipe(Effect.map((chunk) => Array.from(chunk)));
            return yield* Effect.forEach(
              references.filter(
                (
                  r,
                ): r is ce.CostCategoryReference & {
                  CostCategoryArn: string;
                  Name: string;
                } => r.CostCategoryArn !== undefined && r.Name !== undefined,
              ),
              (r) =>
                Effect.gen(function* () {
                  return {
                    costCategoryArn: r.CostCategoryArn,
                    name: r.Name,
                    effectiveStart: r.EffectiveStart,
                    tags: yield* fetchCeTags(r.CostCategoryArn),
                  };
                }),
              { concurrency: 10 },
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const live = output?.costCategoryArn
            ? yield* getByArn(output.costCategoryArn)
            : yield* findByName(yield* createName(id, olds ?? {}));
          if (live === undefined) return undefined;
          const attrs = yield* toAttrs(live);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          // UpdateCostCategoryDefinition cannot rename — name change replaces.
          if (
            (yield* createName(id, olds ?? {})) !==
            (yield* createName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const ruleVersion = news.ruleVersion ?? DEFAULT_RULE_VERSION;

          // OBSERVE — cloud state is authoritative.
          const live = output?.costCategoryArn
            ? yield* getByArn(output.costCategoryArn)
            : yield* findByName(name);

          let costCategoryArn = live?.CostCategoryArn;
          let effectiveStart: string | undefined = live?.EffectiveStart;
          if (costCategoryArn === undefined) {
            // ENSURE — create if missing.
            const created = yield* pinCe(
              ce.createCostCategoryDefinition({
                Name: name,
                RuleVersion: ruleVersion,
                Rules: news.rules,
                DefaultValue: news.defaultValue,
                SplitChargeRules: news.splitChargeRules,
                EffectiveStart: news.effectiveStart,
                ResourceTags: toResourceTags(desiredTags),
              }),
            );
            costCategoryArn = created.CostCategoryArn!;
            effectiveStart = created.EffectiveStart;
          } else {
            // SYNC — diff observed rules/defaults against desired; apply only
            // on drift.
            const observed = live!;
            const needsUpdate =
              JSON.stringify(observed.Rules) !== JSON.stringify(news.rules) ||
              observed.DefaultValue !== news.defaultValue ||
              JSON.stringify(observed.SplitChargeRules) !==
                JSON.stringify(news.splitChargeRules) ||
              observed.RuleVersion !== ruleVersion;
            if (needsUpdate) {
              const updated = yield* pinCe(
                ce.updateCostCategoryDefinition({
                  CostCategoryArn: costCategoryArn,
                  RuleVersion: ruleVersion,
                  Rules: news.rules,
                  DefaultValue: news.defaultValue,
                  SplitChargeRules: news.splitChargeRules,
                }),
              );
              effectiveStart = updated.EffectiveStart ?? effectiveStart;
            }
          }

          // SYNC TAGS — diff against observed cloud tags.
          yield* syncCeTags(costCategoryArn, desiredTags);

          yield* session.note(costCategoryArn);
          return {
            costCategoryArn,
            name,
            effectiveStart,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* pinCe(
            ce.deleteCostCategoryDefinition({
              CostCategoryArn: output.costCategoryArn,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
