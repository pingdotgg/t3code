import * as lf from "@distilled.cloud/aws/lakeformation";
import { havePropsChanged, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface LFTagProps {
  /**
   * Key of the LF-tag (unique within the catalog). Changing it replaces the
   * tag.
   */
  tagKey: string;
  /**
   * The list of possible values for the tag. Values are added/removed in
   * place via `UpdateLFTag`; a value that is attached to a resource cannot
   * be removed until it is detached.
   */
  tagValues: string[];
  /**
   * The catalog id (AWS account id) the tag lives in. Changing it replaces
   * the tag.
   * @default the caller's account
   */
  catalogId?: string;
}

export interface LFTag extends Resource<
  "AWS.LakeFormation.LFTag",
  LFTagProps,
  {
    tagKey: string;
    tagValues: string[];
    catalogId: string;
  },
  {},
  Providers
> {}

/**
 * A Lake Formation LF-tag definition — a key with a list of allowed values
 * used for tag-based access control (attach values to databases/tables with
 * {@link LFTagAssociation | AWS.LakeFormation.LFTagAssociation}, grant on
 * expressions with {@link Permissions | AWS.LakeFormation.Permissions}).
 *
 * Creating LF-tags requires the caller to be a data lake administrator — see
 * {@link DataLakeSettings | AWS.LakeFormation.DataLakeSettings}.
 *
 * ### Creating LF-Tags
 * **Example:** Environment Tag
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 *
 * const envTag = yield* AWS.LakeFormation.LFTag("EnvTag", {
 *   tagKey: "environment",
 *   tagValues: ["dev", "staging", "prod"],
 * });
 * ```
 *
 * @resource
 */
export const LFTag = Resource<LFTag>("AWS.LakeFormation.LFTag");

export const LFTagProvider = () =>
  Provider.effect(
    LFTag,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (tagKey: string, catalogId: string | undefined) {
        return yield* lf
          .getLFTag({ TagKey: tagKey, CatalogId: catalogId })
          .pipe(Effect.catchTag("EntityNotFoundException", () => Effect.undefined));
      });

      return LFTag.Provider.of({
        stables: ["tagKey", "catalogId"],

        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            const pages = yield* lf.listLFTags.pages({}).pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.LFTags ?? [])
              .map((tag) => ({
                tagKey: tag.TagKey,
                tagValues: [...tag.TagValues],
                catalogId: tag.CatalogId ?? accountId,
              }));
          }),

        read: Effect.fn(function* ({ olds, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const tagKey = output?.tagKey ?? olds?.tagKey;
          if (tagKey === undefined) return undefined;
          const tag = yield* observe(tagKey, olds?.catalogId);
          if (tag === undefined) return undefined;
          // LF-tags are not taggable — ownership cannot be verified.
          return {
            tagKey,
            tagValues: [...(tag.TagValues ?? [])],
            catalogId: tag.CatalogId ?? olds?.catalogId ?? accountId,
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.tagKey !== olds.tagKey) {
            return { action: "replace" } as const;
          }
          if ((news.catalogId ?? undefined) !== (olds.catalogId ?? undefined)) {
            return { action: "replace" } as const;
          }
          if (havePropsChanged(olds.tagValues, news.tagValues)) {
            // `tagKey` is unchanged, but consumers that reference it (e.g. an
            // LFTagAssociation assigning a newly added value) depend on the
            // new values existing. Withholding it from `stables` makes them
            // wait for this update instead of racing it.
            return { action: "update", stables: ["catalogId"] } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const { accountId } = yield* AWSEnvironment.current;

          // 1. OBSERVE
          let tag = yield* observe(news.tagKey, news.catalogId);

          // 2. ENSURE
          if (tag === undefined) {
            yield* lf.createLFTag({
              TagKey: news.tagKey,
              TagValues: news.tagValues,
              CatalogId: news.catalogId,
            });
            tag = yield* observe(news.tagKey, news.catalogId);
          } else {
            // 3. SYNC — diff observed values against desired.
            const current = tag.TagValues ?? [];
            const toAdd = news.tagValues.filter((v) => !current.includes(v));
            const toDelete = current.filter((v) => !news.tagValues.includes(v));
            if (toAdd.length > 0 || toDelete.length > 0) {
              yield* lf.updateLFTag({
                TagKey: news.tagKey,
                CatalogId: news.catalogId,
                TagValuesToAdd: toAdd.length > 0 ? toAdd : undefined,
                TagValuesToDelete: toDelete.length > 0 ? toDelete : undefined,
              });
              tag = yield* observe(news.tagKey, news.catalogId);
            }
          }

          yield* session.note(news.tagKey);
          return {
            tagKey: news.tagKey,
            tagValues: [...(tag?.TagValues ?? news.tagValues)],
            catalogId: tag?.CatalogId ?? news.catalogId ?? accountId,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* lf
            .deleteLFTag({
              TagKey: output.tagKey,
              CatalogId: output.catalogId,
            })
            .pipe(Effect.catchTag("EntityNotFoundException", () => Effect.void));
        }),
      });
    }),
  );
