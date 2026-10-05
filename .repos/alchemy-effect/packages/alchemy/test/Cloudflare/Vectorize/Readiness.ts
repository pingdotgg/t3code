import { poll, PredicateFailed } from "@/Util/poll.ts";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

// Cloudflare reports p99 vector-write visibility below two minutes. Allow
// 150 seconds including requests, with ten retries, and reserve separate
// lifecycle time for deployment and cleanup.
export const waitForVectorize = <A, E, R>(input: {
  description: string;
  effect: Effect.Effect<A, E, R>;
  predicate: (value: A) => boolean;
}) =>
  Effect.gen(function* () {
    let latest: A | undefined;
    return yield* poll({
      ...input,
      effect: input.effect.pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            latest = value;
          }),
        ),
      ),
      schedule: Schedule.max([
        Schedule.spaced("12 seconds"),
        Schedule.recurs(10),
      ]),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "150 seconds",
        orElse: () =>
          Effect.fail(
            new PredicateFailed({ message: input.description, actual: latest }),
          ),
      }),
      Effect.catchTag("PredicateFailed", () =>
        Effect.fail(
          new PredicateFailed({
            message: `${input.description}; last observed: ${JSON.stringify(latest)}`,
            actual: latest,
          }),
        ),
      ),
    );
  });

/** Metadata must be observable before the fixture inserts its vectors. */
export const waitForMetadata = (
  accountId: string,
  indexName: string,
  expected: ReadonlyArray<{ propertyName: string; indexType: string }>,
) =>
  waitForVectorize({
    description: `Metadata ready on ${indexName}: ${JSON.stringify(expected)}`,
    effect: vectorize
      .listIndexMetadataIndexes({ accountId, indexName })
      .pipe(Effect.timeout("10 seconds")),
    predicate: (metadata) =>
      expected.every(
        (field) =>
          metadata.metadataIndexes?.some(
            (entry) =>
              entry.propertyName === field.propertyName &&
              entry.indexType?.toLowerCase() === field.indexType,
          ) === true,
      ),
  }).pipe(Effect.map((metadata) => metadata.metadataIndexes!));
