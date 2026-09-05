import * as databrew from "@distilled.cloud/aws/databrew";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonicalJson,
  cleanMap,
  databrewArn,
  fetchObservedTags,
  retryWhileConflict,
  syncTags,
} from "./internal.ts";

/** A single transformation step in a DataBrew recipe. */
export interface RecipeStep {
  /** The transformation to apply. */
  action: {
    /**
     * The DataBrew operation name, e.g. `UPPER_CASE`, `REMOVE_VALUES`,
     * `RENAME`. See the DataBrew recipe-action reference for the full list.
     */
    operation: string;
    /** Operation parameters, e.g. `{ sourceColumn: "name" }`. */
    parameters?: Record<string, string>;
  };
  /** Conditions that must hold for the step to apply to a row. */
  conditionExpressions?: {
    /** The condition name, e.g. `LESS_THAN`, `IS_MISSING`. */
    condition: string;
    /** The value to compare against (JSON-encoded for lists). */
    value?: string;
    /** The column the condition applies to. */
    targetColumn: string;
  }[];
}

export interface RecipeProps {
  /**
   * Name of the recipe. If omitted, a unique name is generated. Changing
   * the name replaces the recipe.
   * @default a generated physical name
   */
  recipeName?: string;
  /**
   * A description of the recipe.
   */
  description?: string;
  /**
   * The ordered transformation steps applied to the data.
   */
  steps: RecipeStep[];
  /**
   * Publish a new numbered version whenever the working steps change (and
   * once on create). Recipe jobs consume the latest *published* version by
   * default, so set this when the recipe feeds a `DataBrew.Job`.
   * @default false
   */
  publish?: boolean;
  /**
   * Tags to apply to the recipe. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Recipe extends Resource<
  "AWS.DataBrew.Recipe",
  RecipeProps,
  {
    /** Name of the recipe. */
    recipeName: string;
    /** ARN of the recipe. */
    recipeArn: string;
    /** Latest published version (e.g. `"1.0"`), or `"LATEST_WORKING"` if never published. */
    recipeVersion: string;
  },
  {},
  Providers
> {}

/**
 * An AWS Glue DataBrew recipe — an ordered list of data-transformation steps
 * (rename, filter, case conversion, etc.). Edits modify the `LATEST_WORKING`
 * version; setting `publish: true` snapshots numbered versions that recipe
 * jobs consume.
 * @resource
 * @section Creating Recipes
 * @example Simple Transform Recipe
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const recipe = yield* AWS.DataBrew.Recipe("Clean", {
 *   description: "normalize customer names",
 *   steps: [
 *     {
 *       action: {
 *         operation: "UPPER_CASE",
 *         parameters: { sourceColumn: "name" },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @example Published Recipe for Jobs
 * ```typescript
 * // publish: true snapshots a numbered version (1.0, 2.0, ...) whenever the
 * // steps change — recipe jobs run the latest published version by default.
 * const recipe = yield* AWS.DataBrew.Recipe("Clean", {
 *   publish: true,
 *   steps: [
 *     {
 *       action: {
 *         operation: "REMOVE_VALUES",
 *         parameters: { sourceColumn: "email" },
 *       },
 *       conditionExpressions: [
 *         { condition: "IS_MISSING", targetColumn: "email" },
 *       ],
 *     },
 *   ],
 * });
 * ```
 */
export const Recipe = Resource<Recipe>("AWS.DataBrew.Recipe");

export const buildSteps = (steps: RecipeStep[]) =>
  steps.map((step) => ({
    Action: {
      Operation: step.action.operation,
      Parameters: step.action.parameters,
    },
    ConditionExpressions: step.conditionExpressions?.map((expr) => ({
      Condition: expr.condition,
      Value: expr.value,
      TargetColumn: expr.targetColumn,
    })),
  }));

/** Numeric-aware max over published version strings like `"2.0"`. */
const latestPublished = (versions: (string | undefined)[]) => {
  const numeric = versions
    .filter((v): v is string => v !== undefined && !v.startsWith("LATEST"))
    .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b));
  return numeric.at(-1);
};

export const RecipeProvider = () =>
  Provider.effect(
    Recipe,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { recipeName?: string | undefined },
      ) {
        return (
          props.recipeName ??
          (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      const observeWorking = Effect.fn(function* (name: string) {
        return yield* databrew
          .describeRecipe({ Name: name, RecipeVersion: "LATEST_WORKING" })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const publishedVersions = Effect.fn(function* (name: string) {
        const pages = yield* databrew.listRecipeVersions
          .pages({ Name: name })
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.Recipes ?? [])
          .map((r) => r.RecipeVersion);
      });

      return Recipe.Provider.of({
        stables: ["recipeName", "recipeArn"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            // LATEST_WORKING enumerates every recipe (the default listing
            // only returns recipes with a published version).
            const workingPages = yield* databrew.listRecipes
              .pages({ RecipeVersion: "LATEST_WORKING" })
              .pipe(Stream.runCollect);
            const publishedPages = yield* databrew.listRecipes
              .pages({})
              .pipe(Stream.runCollect);
            const published = new Map(
              Array.from(publishedPages)
                .flatMap((page) => page.Recipes ?? [])
                .map((r) => [r.Name, r.RecipeVersion]),
            );
            return Array.from(workingPages)
              .flatMap((page) => page.Recipes ?? [])
              .map((r) => ({
                recipeName: r.Name,
                recipeArn:
                  r.ResourceArn ??
                  databrewArn(region, accountId, "recipe", r.Name),
                recipeVersion: published.get(r.Name) ?? "LATEST_WORKING",
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.recipeName ?? (yield* createName(id, olds ?? {}));
          const recipe = yield* observeWorking(name);
          if (recipe === undefined) return undefined;
          const arn =
            recipe.ResourceArn ??
            databrewArn(region, accountId, "recipe", name);
          const versions = yield* publishedVersions(name);
          const attrs = {
            recipeName: name,
            recipeArn: arn,
            recipeVersion: latestPublished(versions) ?? "LATEST_WORKING",
          };
          const tags = cleanMap(recipe.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          // steps/description are UpdateRecipe-able; publish is a sync step
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.recipeName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredSteps = buildSteps(news.steps);

          // 1. OBSERVE the working copy
          let recipe = yield* observeWorking(name);
          let changed = false;

          // 2. ENSURE
          if (recipe === undefined) {
            yield* databrew
              .createRecipe({
                Name: name,
                Description: news.description,
                Steps: desiredSteps,
                Tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            changed = true;
            recipe = yield* observeWorking(name);
          } else if (
            canonicalJson(recipe.Steps ?? []) !== canonicalJson(desiredSteps) ||
            (recipe.Description ?? undefined) !== news.description
          ) {
            // 3. SYNC the working copy only when observed differs
            yield* databrew.updateRecipe({
              Name: name,
              Description: news.description,
              Steps: desiredSteps,
            });
            changed = true;
          }

          // 3b. SYNC published versions — publish when the working copy
          // changed, or when publishing is desired but nothing is published.
          let versions = yield* publishedVersions(name);
          if (news.publish === true && (changed || versions.length === 0)) {
            yield* databrew.publishRecipe({
              Name: name,
              Description: news.description,
            });
            versions = yield* publishedVersions(name);
          }

          const arn =
            recipe?.ResourceArn ??
            databrewArn(region, accountId, "recipe", name);

          // 3c. SYNC TAGS against observed cloud tags
          const observedTags = yield* fetchObservedTags(arn);
          yield* syncTags(arn, observedTags, desiredTags);

          yield* session.note(name);
          return {
            recipeName: name,
            recipeArn: arn,
            recipeVersion: latestPublished(versions) ?? "LATEST_WORKING",
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          const name = output.recipeName;
          // A recipe is deleted by deleting all of its versions: published
          // versions first (batched), then LATEST_WORKING.
          const versions = yield* databrew.listRecipeVersions
            .pages({ Name: name })
            .pipe(Stream.runCollect)
            .pipe(
              Effect.map((pages) =>
                Array.from(pages)
                  .flatMap((page) => page.Recipes ?? [])
                  .map((r) => r.RecipeVersion)
                  .filter((v): v is string => v !== undefined),
              ),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed([] as string[]),
              ),
            );
          if (versions.length > 0) {
            yield* retryWhileConflict(
              databrew.batchDeleteRecipeVersion({
                Name: name,
                RecipeVersions: versions,
              }),
            ).pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          yield* retryWhileConflict(
            databrew.deleteRecipeVersion({
              Name: name,
              RecipeVersion: "LATEST_WORKING",
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        }),
      });
    }),
  );
