import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { clientToken, stripAwsSystemTags } from "./internal.ts";

export interface AttributeGroupProps {
  /**
   * Name of the attribute group. Must be unique in the account and region
   * and may only contain letters, numbers, dots, dashes, and underscores.
   * If omitted, a unique name is generated. Changing it replaces the
   * attribute group.
   */
  attributeGroupName?: string;
  /**
   * Description of the attribute group. Updatable in place.
   */
  description?: string;
  /**
   * Open-content metadata for the group as a JSON object (max 8 KB).
   * Updatable in place.
   */
  attributes: Record<string, unknown>;
  /**
   * Tags to apply to the attribute group. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface AttributeGroup extends Resource<
  "AWS.AppRegistry.AttributeGroup",
  AttributeGroupProps,
  {
    /** The auto-generated attribute group ID. */
    attributeGroupId: string;
    /** The ARN of the attribute group. */
    attributeGroupArn: string;
    /** The name of the attribute group. */
    attributeGroupName: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Service Catalog AppRegistry attribute group — a named container of
 * user-defined JSON metadata that can be associated with applications to
 * enrich them (owner, cost center, compliance posture, etc.).
 *
 * @resource
 * @section Creating an Attribute Group
 * @example Basic Attribute Group
 * ```typescript
 * import * as AppRegistry from "alchemy/AWS/AppRegistry";
 *
 * const group = yield* AppRegistry.AttributeGroup("Ownership", {
 *   attributes: {
 *     owner: "commerce-team",
 *     costCenter: "1234",
 *   },
 * });
 * ```
 *
 * @example Attribute Group with Description and Tags
 * ```typescript
 * const group = yield* AppRegistry.AttributeGroup("Ownership", {
 *   attributeGroupName: "storefront-ownership",
 *   description: "Ownership metadata for the storefront",
 *   attributes: { owner: "commerce-team" },
 *   tags: { team: "commerce" },
 * });
 * ```
 */
export const AttributeGroup = Resource<AttributeGroup>(
  "AWS.AppRegistry.AttributeGroup",
);

export const AttributeGroupProvider = () =>
  Provider.effect(
    AttributeGroup,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<AttributeGroupProps, "attributeGroupName">,
      ) {
        return (
          props.attributeGroupName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      // getAttributeGroup accepts a name, ID, or ARN specifier.
      const observe = Effect.fn(function* (specifier: string) {
        return yield* appregistry
          .getAttributeGroup({ attributeGroup: specifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      // Canonical comparison of the observed attribute JSON against the
      // desired object; serialization differences at worst cause one extra
      // (idempotent) update call.
      const attributesEqual = (
        observed: string | undefined,
        desired: Record<string, unknown>,
      ): boolean => {
        if (observed === undefined) return false;
        try {
          return (
            JSON.stringify(JSON.parse(observed)) === JSON.stringify(desired)
          );
        } catch {
          return false;
        }
      };

      return AttributeGroup.Provider.of({
        stables: [
          "attributeGroupId",
          "attributeGroupArn",
          "attributeGroupName",
        ],
        list: () =>
          appregistry.listAttributeGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.attributeGroups ?? [])
                .filter((g) => g.id != null && g.arn != null && g.name != null)
                .map((g) => ({
                  attributeGroupId: g.id!,
                  attributeGroupArn: g.arn!,
                  attributeGroupName: g.name!,
                })),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const specifier =
            output?.attributeGroupId ?? (yield* createName(id, olds ?? {}));
          const found = yield* observe(specifier);
          if (!found?.id) return undefined;
          const attrs = {
            attributeGroupId: found.id,
            attributeGroupArn: found.arn!,
            attributeGroupName: found.name!,
          };
          return (yield* hasAlchemyTags(id, tagRecord(found.tags)))
            ? attrs
            : Unowned(attrs);
        }),
        // The attribute group name is its user-facing identity — changing it
        // replaces the group.
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          session,
          instanceId,
        }) {
          const attributeGroupName = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags: Record<string, string> = {
            ...news.tags,
            ...internalTags,
          };
          const desiredAttributes = JSON.stringify(news.attributes);

          // 1. OBSERVE — cloud is authoritative; output caches the ID only.
          let found = output?.attributeGroupId
            ? yield* observe(output.attributeGroupId)
            : undefined;
          if (!found?.id) {
            found = yield* observe(attributeGroupName);
          }

          // 2. ENSURE — create when missing; tolerate a concurrent-create
          // race (ConflictException) by re-reading.
          if (!found?.id) {
            yield* appregistry
              .createAttributeGroup({
                name: attributeGroupName,
                description: news.description,
                attributes: desiredAttributes,
                tags: desiredTags,
                clientToken: clientToken(instanceId),
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            found = yield* observe(attributeGroupName);
          }

          const attributeGroupId = found!.id!;
          const attributeGroupArn = found!.arn!;

          // 3a. SYNC description + attributes — apply only the delta.
          const descriptionChanged =
            news.description !== undefined &&
            found!.description !== news.description;
          const attrsChanged = !attributesEqual(
            found!.attributes,
            news.attributes,
          );
          if (descriptionChanged || attrsChanged) {
            yield* appregistry.updateAttributeGroup({
              attributeGroup: attributeGroupId,
              description: descriptionChanged ? news.description : undefined,
              attributes: attrsChanged ? desiredAttributes : undefined,
            });
          }

          // 3b. SYNC tags — diff against OBSERVED cloud tags so adoption
          // converges.
          const observedTags = stripAwsSystemTags(tagRecord(found!.tags));
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* appregistry.tagResource({
              resourceArn: attributeGroupArn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* appregistry.untagResource({
              resourceArn: attributeGroupArn,
              tagKeys: removed,
            });
          }

          yield* session.note(attributeGroupId);
          return {
            attributeGroupId,
            attributeGroupArn,
            attributeGroupName,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* appregistry
            .deleteAttributeGroup({
              attributeGroup: output.attributeGroupId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
