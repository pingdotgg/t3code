import * as Effect from "effect/Effect";
import { createPhysicalName } from "../PhysicalName.ts";

/**
 * Railway has no labels. Ownership is stamped into the physical name via
 * `createPhysicalName` (lowercase, max 32, leading letter). Railway's
 * `projectCreate` rejects longer generated names (`Invalid project name`).
 * `list()` filters with {@link matchesAlchemyPhysicalName} so nuke does
 * not enumerate the whole workspace.
 */
export const RAILWAY_NAME_MAX_LENGTH = 32;

/**
 * Railway generates `{serviceName}-{environmentName}.up.railway.app` on
 * `serviceDomainCreate`. That first DNS label must be ≤ 63 characters
 * (`32 + 1 + 32 = 65` fails with "please try again"). Extra environments
 * stay shorter so a 32-char service name still fits.
 */
export const RAILWAY_ENVIRONMENT_NAME_MAX_LENGTH = 24;

const clipName = (raw: string, maxLength: number) => {
  const clipped = raw.length > maxLength ? raw.slice(0, maxLength) : raw;
  const forced = /^[a-z]/.test(clipped)
    ? clipped
    : `r${clipped}`.slice(0, maxLength);
  return forced.replace(/-+$/g, "") || "r";
};

/**
 * Railway Project / Service / Volume / Variable physical names:
 * `createPhysicalName({ lowercase: true, maxLength: 32 })`, then force a
 * leading letter (`r` prefix if needed). Unique per workspace.
 */
export const createRailwayName = Effect.fn(function* (id: string) {
  const raw = yield* createPhysicalName({
    id,
    lowercase: true,
    maxLength: RAILWAY_NAME_MAX_LENGTH,
  });
  return clipName(raw, RAILWAY_NAME_MAX_LENGTH);
});

/** Extra-environment names. See {@link RAILWAY_ENVIRONMENT_NAME_MAX_LENGTH}. */
export const createRailwayEnvironmentName = Effect.fn(function* (id: string) {
  const raw = yield* createPhysicalName({
    id,
    lowercase: true,
    maxLength: RAILWAY_ENVIRONMENT_NAME_MAX_LENGTH,
  });
  return clipName(raw, RAILWAY_ENVIRONMENT_NAME_MAX_LENGTH);
});

/**
 * Sanitize a user-supplied Railway name: lowercase, DNS-compatible
 * (`[a-z0-9-]`), force a leading letter, max 32 chars.
 */
const sanitizeTo = (name: string, maxLength: number): string => {
  const lowered = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clipName(lowered.length === 0 ? "r" : lowered, maxLength);
};

export const sanitizeRailwayName = (name: string): string =>
  sanitizeTo(name, RAILWAY_NAME_MAX_LENGTH);

export const sanitizeRailwayEnvironmentName = (name: string): string =>
  sanitizeTo(name, RAILWAY_ENVIRONMENT_NAME_MAX_LENGTH);

export const sanitize = sanitizeRailwayName;

/**
 * True when `name` matches the `createPhysicalName` + leading-letter shape
 * used for alchemy-owned Railway resources.
 *
 * Untruncated names end with a hyphen plus an 8–16 char RFC4648 base32
 * instance suffix. Truncated 32-char names keep that suffix (the human
 * prefix is what gets cut).
 */
export const matchesAlchemyPhysicalName = (
  name: string | undefined,
): boolean => {
  if (
    name === undefined ||
    name.length === 0 ||
    name.length > RAILWAY_NAME_MAX_LENGTH
  ) {
    return false;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return false;
  const parts = name.split("-");
  const last = parts.at(-1) ?? "";
  if (
    parts.length >= 2 &&
    last.length >= 8 &&
    last.length <= 16 &&
    /^[a-z2-7]+$/.test(last)
  ) {
    return true;
  }
  const compact = name.replaceAll("-", "");
  return /[a-z2-7]{16}$/.test(compact);
};
