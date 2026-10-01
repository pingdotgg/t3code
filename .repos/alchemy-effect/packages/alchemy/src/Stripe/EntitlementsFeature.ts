import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  GetEntitlementsFeatures,
  GetEntitlementsFeature,
  CreateEntitlementsFeature,
  UpdateEntitlementsFeature,
  type EntitlementsFeature as StripeEntitlementsFeature,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const NAME_MAX_LENGTH = 80;
const LOOKUP_KEY_MAX_LENGTH = 80;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

export interface EntitlementsFeatureProps {
  /**
   * Unique system identifier for this feature (max 80 characters). If
   * omitted, a unique key is generated from the stack, stage, and logical
   * id. Create-only — changing it replaces the feature.
   */
  lookupKey?: string;
  /**
   * Feature name for your own purpose, not shown to customers (max 80
   * characters). If omitted, a unique name is generated from the stack,
   * stage, and logical id. Mutable.
   */
  name?: string;
  /**
   * Whether the feature can be attached to new products. Inactive
   * (archived) features are omitted from the default list endpoint.
   * @default true
   */
  active?: boolean;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Mutable.
   */
  metadata?: Record<string, string>;
}

export type EntitlementsFeature = Resource<
  "Stripe.EntitlementsFeature",
  EntitlementsFeatureProps,
  {
    /** Stripe feature id (`feat_…`). */
    id: string;
    /** Unique system identifier for this feature. */
    lookupKey: string;
    /** Feature name for your own purpose, not shown to customers. */
    name: string;
    /** Whether the feature can be attached to new products. */
    active: boolean;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Whether the feature exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Entitlements Feature — a monetizable ability you attach to
 * Products. When a customer purchases a product with this feature, Stripe
 * creates an entitlement for them. `lookup_key` is unique among active
 * features and immutable (changing it replaces the feature). Name and
 * metadata update in place.
 *
 * Stripe does not hard-delete features; destroying this resource
 * deactivates it (`active: false`). Archived features cannot be edited
 * or unarchived. An archived lookup key can be reused — a later create
 * with the same key provisions a new feature.
 *
 * @see https://docs.stripe.com/api/entitlements/feature
 *
 * ### Creating a Feature
 * **Example:** Generated lookup key
 * ```typescript
 * const seats = yield* Stripe.EntitlementsFeature("seats");
 * ```
 *
 * **Example:** Named feature with lookup key
 * ```typescript
 * const seats = yield* Stripe.EntitlementsFeature("seats", {
 *   lookupKey: "seats",
 *   name: "Seat licenses",
 * });
 * ```
 *
 * ### Updating a Feature
 * **Example:** Rename and retag
 * ```typescript
 * const seats = yield* Stripe.EntitlementsFeature("seats", {
 *   lookupKey: "seats",
 *   name: "Seat licenses (updated)",
 *   metadata: { plan: "pro" },
 * });
 * ```
 *
 * ### Deactivating a Feature
 * **Example:** Destroy deactivates rather than deleting
 * ```typescript
 * // stack.destroy() / resource removal sets active: false
 * const seats = yield* Stripe.EntitlementsFeature("seats", {
 *   lookupKey: "seats",
 *   name: "Seat licenses",
 * });
 * ```
 *
 * @resource
 */
export const EntitlementsFeature = Resource<EntitlementsFeature>(
  "Stripe.EntitlementsFeature",
);

type EntitlementsFeatureAttributes = EntitlementsFeature["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }))
    );
  });

const toLookupKey = (
  id: string,
  lookupKey: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      lookupKey ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: LOOKUP_KEY_MAX_LENGTH,
        lowercase: true,
      }))
    );
  });

const toAttrs = (
  feature: StripeEntitlementsFeature,
): EntitlementsFeatureAttributes => ({
  id: feature.id,
  lookupKey: feature.lookup_key,
  name: feature.name,
  active: feature.active,
  metadata: userMetadata(feature.metadata),
  livemode: feature.livemode,
});

const isMissingFeature = isMissingStripeResource;

const getById = (id: string) =>
  GetEntitlementsFeature({ id }).pipe(
    Effect.catchIf(isMissingFeature, () => Effect.succeed(undefined)),
  );

const listByArchived = Effect.fn(function* (archived: boolean) {
  const features: StripeEntitlementsFeature[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetEntitlementsFeatures({
      archived,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    features.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return features;
});

const findByLookupKey = Effect.fn(function* (lookupKey: string) {
  // Archived features cannot be updated or unarchived. Their lookup keys
  // are reusable, so observation must ignore them and let ensure create.
  const active = yield* GetEntitlementsFeatures({
    lookup_key: lookupKey,
    archived: false,
    limit: LIST_PAGE_SIZE,
  });
  return active.data[0];
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const features = yield* listByArchived(false);
  const matches: StripeEntitlementsFeature[] = [];
  for (const feature of features) {
    if (yield* hasAlchemyMetadata(id, tagRecord(feature.metadata))) {
      matches.push(feature);
    }
  }
  matches.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  logicalId: string;
  lookupKey?: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.lookupKey !== undefined) {
    const byKey = yield* findByLookupKey(input.lookupKey);
    if (
      byKey !== undefined &&
      (yield* hasAlchemyMetadata(input.logicalId, tagRecord(byKey.metadata)))
    ) {
      return byKey;
    }
  }
  return yield* findByAlchemyId(input.logicalId);
});

const desiredMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, string> | undefined,
) {
  return {
    ...toMetadata(metadata),
    ...(yield* createInternalMetadata(id)),
  };
});

const shouldReplace = (
  news: EntitlementsFeatureProps,
  output: EntitlementsFeatureAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.lookupKey !== undefined && news.lookupKey !== output.lookupKey) {
    return true;
  }
  return false;
};

export const EntitlementsFeatureProvider = () =>
  Provider.succeed(EntitlementsFeature, {
    stables: ["id", "lookupKey", "livemode"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      const existing = yield* observe({
        id: output?.id,
        logicalId: id,
        lookupKey: output?.lookupKey,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      // Default list API is active features; archived (deactivated) rows
      // stay in Stripe but must not re-enter nuke. Filter to alchemy_stack
      // so account-wide teardown only touches our rows.
      const features = yield* listByArchived(false);
      return features
        .filter((feature) => {
          const metadata = tagRecord(feature.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const lookupKey = yield* toLookupKey(
        id,
        news.lookupKey,
        output?.lookupKey,
      );
      const name = yield* toName(id, news.name, output?.name);
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredActive = news.active ?? true;

      let current: StripeEntitlementsFeature | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
        lookupKey,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }
      // Stripe rejects updates to archived features and cannot unarchive
      // them. Treat inactive rows as missing so ensure creates a new one
      // (lookup keys become reusable once archived).
      if (current !== undefined && current.active === false) {
        if (desiredActive === false) {
          return toAttrs(current);
        }
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateEntitlementsFeature({
          lookup_key: lookupKey,
          name,
          metadata,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-entitlements-feature-${instanceId}`,
          }),
        );
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const nameChanged = current.name !== name;
      const activeChanged = current.active !== desiredActive;

      if (!nameChanged && !activeChanged && !metadataChanged) {
        return toAttrs(current);
      }

      const updated = yield* UpdateEntitlementsFeature({
        id: current.id,
        ...(nameChanged ? { name } : {}),
        ...(activeChanged ? { active: desiredActive } : {}),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(
                  upsert.map((tag) => [tag.Key, tag.Value]),
                ),
                ...Object.fromEntries(removed.map((key) => [key, ""])),
              },
            }
          : {}),
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getById(output.id);
      if (existing === undefined || !existing.active) return;
      yield* UpdateEntitlementsFeature({
        id: existing.id,
        active: false,
      }).pipe(Effect.catchIf(isMissingFeature, () => Effect.void));
    }),
  });
