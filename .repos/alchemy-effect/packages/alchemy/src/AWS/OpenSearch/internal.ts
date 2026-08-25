import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Convert OpenSearch's `[{ Key, Value }]` tag list into a plain record,
 * dropping any entry missing a key or value.
 */
export const toTagRecord = (
  tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

/**
 * Read the observed tags for an OpenSearch domain by ARN. A domain that has
 * just been created (or is mid-transition) can transiently reject `listTags`;
 * treat any failure as "no observed tags" so tag reconciliation still runs.
 */
export const readDomainTags = Effect.fn(function* (arn: string) {
  const response = yield* opensearch
    .listTags({ ARN: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.TagList);
});

/**
 * True when any DEFINED leaf of `desired` differs from the corresponding
 * value in `observed`. Keys the caller left undefined are ignored, so the
 * comparison only covers configuration the user actually expressed.
 */
export const subsetDiffers = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return false;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) {
      return true;
    }
    return desired.some((value, i) => subsetDiffers(value, observed[i]));
  }
  if (typeof desired === "object" && desired !== null) {
    if (typeof observed !== "object" || observed === null) return true;
    return Object.entries(desired).some(
      ([key, value]) =>
        value !== undefined &&
        subsetDiffers(value, (observed as Record<string, unknown>)[key]),
    );
  }
  return desired !== observed;
};

/**
 * Poll an OpenSearch domain until `done` observes a settled state (bounded:
 * 15s x 120 = ~30 minutes; domain provisioning and blue/green config changes
 * typically take 15-25 minutes). If the schedule exhausts first, the last
 * observation is returned as-is so the caller sees the real (still
 * converging) domain rather than a spurious failure.
 *
 * The explicit `Effect.Effect<A, E, R>` return annotation is load-bearing:
 * inlining repeat/retry combinators in provider lifecycle code lets their
 * conditional return types survive into declaration emit and widen the
 * provider layer to `unknown` R, poisoning `AWS.providers()` downstream.
 */
export const repeatUntilDomainState = <E extends { readonly _tag: string }, R>(
  read: Effect.Effect<opensearch.DomainStatus | undefined, E, R>,
  done: (domain: opensearch.DomainStatus | undefined) => boolean,
): Effect.Effect<opensearch.DomainStatus | undefined, E, R> =>
  Effect.repeat(read, {
    schedule: Schedule.max([
      Schedule.fixed("15 seconds"),
      Schedule.recurs(120),
    ]),
    until: done,
  });

/** A domain is active once created and no config change is being applied. */
export const isDomainActive = (
  domain: opensearch.DomainStatus | undefined,
): boolean =>
  domain === undefined ||
  (domain.Created === true &&
    domain.Processing !== true &&
    domain.Deleted !== true);

/** A domain can be deleted once it is no longer applying a config change. */
export const isDomainDeletable = (
  domain: opensearch.DomainStatus | undefined,
): boolean =>
  domain === undefined || domain.Deleted === true || domain.Processing !== true;
