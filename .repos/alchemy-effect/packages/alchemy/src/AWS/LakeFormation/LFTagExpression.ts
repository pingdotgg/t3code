import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * One LF-tag condition inside an expression.
 */
export interface LFTagPairSpec {
  /**
   * Key of the LF-tag.
   */
  tagKey: string;
  /**
   * Values of the LF-tag the condition matches.
   */
  tagValues: string[];
}

export interface LFTagExpressionProps {
  /**
   * Name of the LF-tag expression (unique within the catalog). Changing it
   * replaces the expression.
   */
  name: string;
  /**
   * Human-readable description of the expression.
   */
  description?: string;
  /**
   * The LF-tag conditions (logical AND) that make up the expression. The
   * referenced LF-tags must exist.
   */
  expression: LFTagPairSpec[];
  /**
   * The catalog id (AWS account id) the expression lives in. Changing it
   * replaces the expression.
   * @default the caller's account
   */
  catalogId?: string;
}

export interface LFTagExpression extends Resource<
  "AWS.LakeFormation.LFTagExpression",
  LFTagExpressionProps,
  {
    name: string;
    description: string | undefined;
    expression: LFTagPairSpec[];
    catalogId: string;
  },
  {},
  Providers
> {}

const toExpressionPairs = (
  expression: readonly lf.LFTag[] | undefined,
): LFTagPairSpec[] =>
  (expression ?? []).map((e) => ({
    tagKey: e.TagKey,
    tagValues: [...e.TagValues].sort(),
  }));

const toWireExpression = (expression: LFTagPairSpec[]): lf.LFTag[] =>
  expression.map((e) => ({ TagKey: e.tagKey, TagValues: e.tagValues }));

const normalize = (expression: LFTagPairSpec[]): LFTagPairSpec[] =>
  [...expression]
    .map((e) => ({ tagKey: e.tagKey, tagValues: [...e.tagValues].sort() }))
    .sort((a, b) => a.tagKey.localeCompare(b.tagKey));

/**
 * A named Lake Formation LF-tag expression — a reusable, saved combination
 * of LF-tag conditions that can be referenced from permission grants
 * (`Resource.LFTagExpression`) instead of repeating the raw expression.
 *
 * Creating LF-tag expressions requires `CREATE_LF_TAG_EXPRESSION` on the
 * catalog (data lake administrators have it) plus
 * `GRANT_WITH_LF_TAG_EXPRESSION` on the underlying LF-tag pairs — see
 * {@link DataLakeSettings | AWS.LakeFormation.DataLakeSettings}.
 *
 * @resource
 * @section Creating LF-Tag Expressions
 * @example Saved Expression over an Environment Tag
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const tag = yield* AWS.LakeFormation.LFTag("EnvTag", {
 *   tagKey: "environment",
 *   tagValues: ["dev", "prod"],
 * });
 * const expression = yield* AWS.LakeFormation.LFTagExpression("ProdData", {
 *   name: "prod-data",
 *   description: "All resources tagged environment=prod",
 *   expression: [{ tagKey: tag.tagKey, tagValues: ["prod"] }],
 * });
 * ```
 */
export const LFTagExpression = Resource<LFTagExpression>(
  "AWS.LakeFormation.LFTagExpression",
);

export const LFTagExpressionProvider = () =>
  Provider.effect(
    LFTagExpression,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (
        name: string,
        catalogId: string | undefined,
      ) {
        return yield* lf
          .getLFTagExpression({ Name: name, CatalogId: catalogId })
          .pipe(
            Effect.catchTag("EntityNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return LFTagExpression.Provider.of({
        stables: ["name", "catalogId"],

        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            const pages = yield* lf.listLFTagExpressions
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.LFTagExpressions ?? [])
              .filter((e) => e.Name !== undefined)
              .map((e) => ({
                name: e.Name!,
                description: e.Description,
                expression: toExpressionPairs(e.Expression),
                catalogId: e.CatalogId ?? accountId,
              }));
          }),

        read: Effect.fn(function* ({ olds, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name = output?.name ?? olds?.name;
          if (name === undefined) return undefined;
          const found = yield* observe(name, olds?.catalogId);
          if (found === undefined) return undefined;
          // LF-tag expressions are not taggable — ownership cannot be
          // verified.
          return {
            name,
            description: found.Description,
            expression: toExpressionPairs(found.Expression),
            catalogId: found.CatalogId ?? olds?.catalogId ?? accountId,
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.name !== olds.name) {
            return { action: "replace" } as const;
          }
          if ((news.catalogId ?? undefined) !== (olds.catalogId ?? undefined)) {
            return { action: "replace" } as const;
          }
          // description / expression → update
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const desired = normalize(news.expression);

          // 1. OBSERVE
          let found = yield* observe(news.name, news.catalogId);

          // 2. ENSURE
          if (found === undefined) {
            yield* lf.createLFTagExpression({
              Name: news.name,
              Description: news.description,
              CatalogId: news.catalogId,
              Expression: toWireExpression(news.expression),
            });
            found = yield* observe(news.name, news.catalogId);
          } else {
            // 3. SYNC — diff observed description/expression against desired.
            const observedExpression = normalize(
              toExpressionPairs(found.Expression),
            );
            const descriptionDrift =
              news.description !== undefined &&
              news.description !== found.Description;
            const expressionDrift =
              JSON.stringify(observedExpression) !== JSON.stringify(desired);
            if (descriptionDrift || expressionDrift) {
              yield* lf.updateLFTagExpression({
                Name: news.name,
                CatalogId: news.catalogId,
                Description: news.description ?? found.Description,
                Expression: toWireExpression(news.expression),
              });
              found = yield* observe(news.name, news.catalogId);
            }
          }

          yield* session.note(news.name);
          return {
            name: news.name,
            description: found?.Description,
            expression: toExpressionPairs(found?.Expression),
            catalogId: found?.CatalogId ?? news.catalogId ?? accountId,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* lf
            .deleteLFTagExpression({
              Name: output.name,
              CatalogId: output.catalogId,
            })
            .pipe(
              Effect.catchTag("EntityNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
