import { Region, type RegionName } from "@distilled.cloud/aws/Region";
import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";

/**
 * AWS IoT FleetWise is offered only in `us-east-1` and `eu-central-1`
 * (there is no `iotfleetwise.{region}.amazonaws.com` endpoint anywhere
 * else). The providers follow the ambient region when it is one of the
 * supported two and pin `us-east-1` otherwise, mirroring how WAFv2
 * CLOUDFRONT-scoped resources pin their home region.
 *
 * @internal
 */
const FLEETWISE_REGIONS: ReadonlySet<string> = new Set([
  "us-east-1",
  "eu-central-1",
]);

/** @internal */
export const FLEETWISE_HOME_REGION: RegionName = "us-east-1";

/**
 * Run a distilled IoT FleetWise effect in a supported region: the ambient
 * region when FleetWise is offered there, otherwise `us-east-1`.
 *
 * `Region`'s service value is an `Effect<RegionName>` (see
 * `@distilled.cloud/aws/Region`), so it is provided as an effect, not a
 * bare string.
 *
 * @internal
 */
export const inFleetWiseRegion = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Region> =>
  Effect.gen(function* () {
    const ambient = yield* yield* Region;
    return FLEETWISE_REGIONS.has(ambient)
      ? yield* effect
      : yield* effect.pipe(
          Effect.provideService(Region, Effect.succeed(FLEETWISE_HOME_REGION)),
        );
  });

/**
 * Read the observed tags of an IoT FleetWise resource as a plain record.
 * Tag-read failures degrade to an empty record so tag drift never blocks
 * reads of the resource itself.
 *
 * @internal
 */
export const readFleetWiseTags = Effect.fn(function* (arn: string) {
  const response = yield* iotfleetwise
    .listTagsForResource({ ResourceARN: arn })
    .pipe(
      inFleetWiseRegion,
      Effect.catch(() =>
        Effect.succeed({
          Tags: [],
        } as iotfleetwise.ListTagsForResourceResponse),
      ),
    );
  return Object.fromEntries(
    (response.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
  ) as Record<string, string>;
});

/**
 * Convert a tag record to the FleetWise wire shape.
 *
 * @internal
 */
export const toFleetWiseTagList = (
  tags: Record<string, string>,
): iotfleetwise.Tag[] =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

/**
 * Converge an IoT FleetWise resource's tags on the desired record, diffing
 * against OBSERVED cloud tags (never `olds`/`output`).
 *
 * @internal
 */
export const syncFleetWiseTags = Effect.fn(function* (
  arn: string,
  desired: Record<string, string>,
) {
  const observed = yield* readFleetWiseTags(arn);
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* iotfleetwise
      .tagResource({ ResourceARN: arn, Tags: upsert })
      .pipe(inFleetWiseRegion);
  }
  if (removed.length > 0) {
    yield* iotfleetwise
      .untagResource({ ResourceARN: arn, TagKeys: removed })
      .pipe(inFleetWiseRegion);
  }
});

/**
 * Retry an effect through FleetWise `ConflictException` windows (e.g. a
 * signal catalog whose model manifests are still deleting, or a decoder
 * manifest with vehicles detaching). Bounded: ~30s total.
 *
 * Explicitly typed: inlining `Effect.retry` with options in provider
 * lifecycle code widens the provider layer to `unknown` in declaration
 * emit.
 *
 * @internal
 */
export const retryWhileConflict = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

/**
 * Bounded eventual-consistency retry for observe-after-write reads
 * (~20s total).
 *
 * @internal
 */
export const retryObservation = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
  });

/**
 * Order-insensitive deep equality over plain JSON-ish values (props and
 * observed FleetWise structures). Object keys are sorted; arrays stay
 * positional.
 *
 * @internal
 */
export const stableEquals = (left: unknown, right: unknown): boolean =>
  stableStringify(left) === stableStringify(right);

const stableStringify = (value: unknown): string =>
  JSON.stringify(normalize(value));

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([l], [r]) => l.localeCompare(r))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
};
