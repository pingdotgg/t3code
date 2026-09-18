import * as Effect from "effect/Effect";
import { Stack } from "../Stack.ts";
import { createInternalTags, diffTags, hasTags, type Tags } from "../Tags.ts";

/**
 * Stripe metadata keys may only contain alphanumeric characters, dashes,
 * and underscores (max 40 chars). Alchemy ownership tags use `alchemy::stack`
 * / `alchemy::stage` / `alchemy::id` — map those onto `alchemy_stack` /
 * `alchemy_stage` / `alchemy_id` so they survive the Stripe API.
 */
export const ALCHEMY_METADATA_PREFIX = "alchemy_";

export const alchemyMetadataKeys = {
  stack: "alchemy_stack",
  stage: "alchemy_stage",
  id: "alchemy_id",
} as const;

const TAG_PREFIX = "alchemy::";

export const toMetadataKey = (tagKey: string): string =>
  tagKey.startsWith(TAG_PREFIX)
    ? `${ALCHEMY_METADATA_PREFIX}${tagKey.slice(TAG_PREFIX.length)}`
    : tagKey;

export const toTagKey = (metadataKey: string): string =>
  metadataKey.startsWith(ALCHEMY_METADATA_PREFIX)
    ? `${TAG_PREFIX}${metadataKey.slice(ALCHEMY_METADATA_PREFIX.length)}`
    : metadataKey;

/** Stripe metadata values are capped at 500 characters. */
export const sanitizeMetadataValue = (value: string): string =>
  value.slice(0, 500);

export const toMetadata = (
  tags: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).map(([key, value]) => [
      toMetadataKey(key).slice(0, 40),
      sanitizeMetadataValue(value),
    ]),
  );

export const fromMetadata = (
  metadata: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [
      toTagKey(key),
      value,
    ]),
  );

export const createInternalMetadata = Effect.fn(function* (id: string) {
  return toMetadata(yield* createInternalTags(id));
});

export const stripInternalMetadata = (
  metadata: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) => !key.startsWith(ALCHEMY_METADATA_PREFIX),
    ),
  );

export const hasAlchemyMetadata = Effect.fn(function* (
  id: string,
  metadata: Tags | undefined,
) {
  const expected = yield* createInternalMetadata(id);
  return hasTags(expected, metadata);
});

/**
 * Diff observed Stripe metadata against desired metadata. Always pass
 * **observed** metadata as `oldTags` — never `olds.metadata` or
 * `output.metadata` — so adoption converges.
 */
export const diffMetadata = diffTags;

/**
 * Stripe Search query matching Alchemy-owned objects on the current stack.
 * Example: `metadata["alchemy_stack"]:"Nuke"`
 *
 * `list()` for nuke must still enumerate every object whose metadata has
 * `alchemy_stack` (account-wide), not only the current stack name.
 */
export const alchemyStackSearchQuery = Effect.fn(function* () {
  const stack = yield* Stack;
  return `metadata["${alchemyMetadataKeys.stack}"]:"${stack.name}"`;
});
