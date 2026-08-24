import * as sitewise from "@distilled.cloud/aws/iotsitewise";
import * as Effect from "effect/Effect";
import { diffTags } from "../../Tags.ts";

/**
 * Fetch the observed tags on an IoT SiteWise resource ARN as a plain
 * string map (SiteWise's TagMap allows `undefined` values on the wire).
 */
export const fetchSiteWiseTags = Effect.fn(function* (arn: string) {
  const response = yield* sitewise
    .listTagsForResource({ resourceArn: arn })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(response?.tags ?? {})) {
    if (value !== undefined) tags[key] = value;
  }
  return tags;
});

/**
 * Converge the tags on a SiteWise resource ARN from the observed cloud
 * tags to the desired map (untag removed keys, upsert added/changed).
 */
export const syncSiteWiseTags = Effect.fn(function* (
  arn: string,
  observed: Record<string, string>,
  desired: Record<string, string>,
) {
  const { removed, upsert } = diffTags(observed, desired);
  if (removed.length > 0) {
    yield* sitewise.untagResource({ resourceArn: arn, tagKeys: removed });
  }
  if (upsert.length > 0) {
    yield* sitewise.tagResource({
      resourceArn: arn,
      tags: Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
    });
  }
});

/**
 * Deep-project `observed` onto the key structure of `desired`: for every
 * key path present in `desired`, take the observed value. Keys the caller
 * never specified (server-side defaults like `processingConfig` or
 * generated `path` segments) are dropped so they don't read as drift.
 */
const projectLike = (desired: unknown, observed: unknown): unknown => {
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed)) return observed;
    return desired.map((item, index) => projectLike(item, observed[index]));
  }
  if (desired !== null && typeof desired === "object") {
    if (
      observed === null ||
      typeof observed !== "object" ||
      Array.isArray(observed)
    ) {
      return observed;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      desired as Record<string, unknown>,
    )) {
      if (value === undefined) continue;
      out[key] = projectLike(value, (observed as Record<string, unknown>)[key]);
    }
    return out;
  }
  return observed;
};

const stripUndefined = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/**
 * Structural equality between a desired shape and the observed cloud
 * state, ignoring observed-only keys (server defaults, generated ids the
 * caller didn't pin, etc.).
 */
export const matchesDesired = (desired: unknown, observed: unknown): boolean =>
  JSON.stringify(stripUndefined(desired)) ===
  JSON.stringify(stripUndefined(projectLike(desired, observed)));
