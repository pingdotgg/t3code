import * as Effect from "effect/Effect";
import { createPhysicalName } from "../PhysicalName.ts";
import { createInternalTags, diffTags, hasTags, type Tags } from "../Tags.ts";

/**
 * Fly App has no labels. Ownership is stamped onto Machine
 * `config.metadata` (and encoded into Volume/Secret names) as
 * `alchemy.stack` / `alchemy.stage` / `alchemy.id`.
 *
 * Names here are Fly-prefixed so `export *` from this module does not
 * collide with Hetzner Labels or `alchemy/src/Ref.ts`.
 */
export const ALCHEMY_METADATA_PREFIX = "alchemy.";

export const alchemyMetadataKeys = {
  stack: "alchemy.stack",
  stage: "alchemy.stage",
  id: "alchemy.id",
  type: "alchemy.type",
  replica: "alchemy.replica",
} as const;

export type FlyAlchemyType = "Fly.Machine" | "Fly.Service";

const TAG_PREFIX = "alchemy::";

export const toMetadataKey = (tagKey: string): string =>
  tagKey.startsWith(TAG_PREFIX)
    ? `${ALCHEMY_METADATA_PREFIX}${tagKey.slice(TAG_PREFIX.length)}`
    : tagKey;

export const toTagKeyFromMetadata = (metadataKey: string): string =>
  metadataKey.startsWith(ALCHEMY_METADATA_PREFIX)
    ? `${TAG_PREFIX}${metadataKey.slice(ALCHEMY_METADATA_PREFIX.length)}`
    : metadataKey;

export const toMachineMetadata = (
  tags: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).map(([key, value]) => [
      toMetadataKey(key),
      value,
    ]),
  );

export const fromMachineMetadata = (
  metadata: Record<string, string> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).map(([key, value]) => [
      toTagKeyFromMetadata(key),
      value,
    ]),
  );

export const createInternalMetadata = Effect.fn(function* (id: string) {
  return toMachineMetadata(yield* createInternalTags(id));
});

/**
 * Stamp alchemy ownership plus `alchemy.type` onto Machine config.metadata.
 */
export const createMachineMetadata = Effect.fn(function* (
  id: string,
  type: FlyAlchemyType,
) {
  return {
    ...(yield* createInternalMetadata(id)),
    [alchemyMetadataKeys.type]: type,
  };
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

/** True when observed Machine metadata was stamped by Alchemy. */
export const isAlchemyOwnedMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): boolean => {
  const stack = metadata?.[alchemyMetadataKeys.stack];
  return stack !== undefined && stack.length > 0;
};

/**
 * Diff observed Machine metadata against desired. Always pass **observed**
 * cloud metadata as `oldMetadata` — never `olds.metadata` or
 * `output.metadata` — so adoption converges.
 */
export const diffMachineMetadata = diffTags;

/**
 * Fly App names: `createPhysicalName({ lowercase: true, maxLength: 30 })`,
 * then force a leading letter (`f` prefix if needed). Globally unique.
 */
export const createFlyAppName = Effect.fn(function* (id: string) {
  const raw = yield* createPhysicalName({
    id,
    lowercase: true,
    maxLength: 30,
  });
  return /^[a-z]/.test(raw) ? raw : `f${raw}`.slice(0, 30);
});

/**
 * Volume / Secret / SecretKey physical names use the same shape as App
 * names so `list()` can recognize alchemy-owned rows without labels.
 *
 * Fly Volume names reject hyphens (`[a-z0-9_]`, max 30). Use
 * {@link createFlyVolumeName} for Volumes.
 */
export const createFlyResourceName = createFlyAppName;

/**
 * Fly Volume names: same physical-name shape as App, but underscore
 * delimited. Fly rejects hyphens (`[a-z0-9_]`, max 30).
 */
export const createFlyVolumeName = Effect.fn(function* (id: string) {
  const raw = yield* createPhysicalName({
    id,
    lowercase: true,
    maxLength: 30,
    delimiter: "_",
  });
  // createPhysicalName keeps hyphens in the stack/stage prefix; Fly
  // Volume names only allow [a-z0-9_].
  return sanitizeFlyVolumeName(raw);
});

/**
 * Sanitize a user-supplied Fly App / Volume / Secret name: lowercase,
 * DNS-compatible (`[a-z0-9-]`), force a leading letter, max 30 chars.
 */
export const sanitizeFlyAppName = (name: string): string => {
  const lowered = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const clipped =
    lowered.length > 30 ? lowered.slice(0, 30).replace(/-+$/g, "") : lowered;
  const raw = clipped.length === 0 ? "f" : clipped;
  return /^[a-z]/.test(raw) ? raw : `f${raw}`.slice(0, 30);
};

/**
 * Sanitize a user-supplied Fly Volume name: lowercase alphanumeric and
 * underscores only, force a leading letter, max 30 chars.
 */
export const sanitizeFlyVolumeName = (name: string): string => {
  const lowered = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const clipped =
    lowered.length > 30 ? lowered.slice(0, 30).replace(/_+$/g, "") : lowered;
  const raw = clipped.length === 0 ? "f" : clipped;
  return /^[a-z]/.test(raw) ? raw : `f${raw}`.slice(0, 30);
};

/**
 * True when `name` matches the `createPhysicalName` + leading-letter shape
 * used for alchemy-owned Fly Apps / Volumes / Secrets / SecretKeys.
 *
 * Untruncated names end with a hyphen (App) or underscore (Volume) plus
 * an 8–16 char RFC4648 base32 instance suffix. Truncated 30-char names
 * keep that suffix (the human prefix is what gets cut).
 */
export const matchesAlchemyPhysicalName = (
  name: string | undefined,
): boolean => {
  if (name === undefined || name.length === 0 || name.length > 30) {
    return false;
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) return false;
  const parts = name.split(/[-_]/);
  const last = parts.at(-1) ?? "";
  if (
    parts.length >= 2 &&
    last.length >= 8 &&
    last.length <= 16 &&
    /^[a-z2-7]+$/.test(last)
  ) {
    return true;
  }
  const compact = name.replaceAll("-", "").replaceAll("_", "");
  return name.length === 30 && /[a-z2-7]{16}$/.test(compact);
};
