import * as kinesis from "@distilled.cloud/aws/kinesis";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import type { StreamArn } from "./Stream.ts";

export type ConsumerName = string;

export type ConsumerArn = string;

export type ConsumerStatus = "CREATING" | "DELETING" | "ACTIVE";

export interface StreamConsumerProps {
  /**
   * ARN of the stream that owns the consumer.
   */
  streamArn: Input<StreamArn>;
  /**
   * Name of the stream consumer.
   * @default ${app}-${stage}-${id}
   */
  consumerName?: string;
  /**
   * Tags to associate with the consumer.
   */
  tags?: Record<string, string>;
}

export interface StreamConsumer extends Resource<
  "AWS.Kinesis.StreamConsumer",
  StreamConsumerProps,
  {
    /**
     * The consumer's physical name.
     */
    consumerName: ConsumerName;
    /**
     * ARN of the registered consumer.
     */
    consumerArn: ConsumerArn;
    /**
     * Current lifecycle status of the consumer.
     */
    consumerStatus: ConsumerStatus;
    /**
     * ARN of the stream the consumer is registered on.
     */
    streamArn: StreamArn;
    /**
     * When the consumer was registered.
     */
    consumerCreationTimestamp: Date;
    /**
     * Current tags reported for the consumer.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A registered Kinesis enhanced fan-out consumer.
 *
 * `StreamConsumer` is the canonical lifecycle resource for
 * `RegisterStreamConsumer` / `DeregisterStreamConsumer`.
 * @resource
 * @section Creating Consumers
 * @example Register a Consumer
 * ```typescript
 * const consumer = yield* StreamConsumer("AnalyticsConsumer", {
 *   streamArn: stream.streamArn,
 * });
 * ```
 */
export const StreamConsumer = Resource<StreamConsumer>(
  "AWS.Kinesis.StreamConsumer",
);

const createConsumerName = (
  id: string,
  props: {
    consumerName?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    if (props.consumerName) {
      return props.consumerName;
    }
    return yield* createPhysicalName({
      id,
      maxLength: 128,
    });
  });

const toTagRecord = (
  tags: Array<{ Key: string; Value?: string }> | undefined,
) =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttrs = ({
  description,
  tags,
}: {
  description: kinesis.ConsumerDescription;
  tags: Record<string, string>;
}): StreamConsumer["Attributes"] => ({
  consumerName: description.ConsumerName,
  consumerArn: description.ConsumerARN,
  consumerStatus: description.ConsumerStatus as ConsumerStatus,
  streamArn: description.StreamARN as StreamArn,
  consumerCreationTimestamp: description.ConsumerCreationTimestamp,
  tags,
});

const readConsumer = Effect.fn(function* ({
  streamArn,
  consumerName,
  consumerArn,
}: {
  streamArn?: string;
  consumerName?: string;
  consumerArn?: string;
}) {
  const response = yield* kinesis
    .describeStreamConsumer({
      StreamARN: streamArn,
      ConsumerName: consumerName,
      ConsumerARN: consumerArn,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

  if (!response) {
    return undefined;
  }

  const description = response.ConsumerDescription;
  const tagsResponse = yield* kinesis.listTagsForResource({
    ResourceARN: description.ConsumerARN,
  });

  return toAttrs({
    description,
    tags: toTagRecord(tagsResponse.Tags),
  });
});

// Kinesis tells us "in use" via ResourceInUseException, but the consumer
// registry is eventually consistent — describeStreamConsumer can briefly
// return ResourceNotFoundException for a consumer the registry just
// confirmed exists. Poll up to ~10s before giving up.
class ConsumerRegistryNotConsistent extends Data.TaggedError(
  "ConsumerRegistryNotConsistent",
)<{ consumerName: string }> {}

const adoptExistingConsumer = Effect.fn(function* (
  streamArn: string,
  consumerName: string,
) {
  return yield* Effect.gen(function* () {
    const state = yield* readConsumer({
      streamArn,
      consumerName,
    });

    if (!state) {
      return yield* new ConsumerRegistryNotConsistent({ consumerName });
    }

    return state;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ConsumerRegistryNotConsistent",
      schedule: Schedule.max([Schedule.exponential(250), Schedule.recurs(8)]),
    }),
    Effect.catchTag("ConsumerRegistryNotConsistent", () =>
      Effect.fail(
        new Error(
          `consumer ${consumerName} exists but could not be read after ` +
            `~10s of registry-consistency retries`,
        ),
      ),
    ),
  );
});

const waitForConsumerStatus = (
  consumerArn: string,
  expectedStatus: ConsumerStatus,
) =>
  Effect.gen(function* () {
    yield* Effect.sleep("2 seconds");
    const response = yield* kinesis.describeStreamConsumer({
      ConsumerARN: consumerArn,
    });
    if (response.ConsumerDescription.ConsumerStatus !== expectedStatus) {
      return yield* Effect.fail({ _tag: "ConsumerStatusNotReady" as const });
    }
    return response.ConsumerDescription;
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) =>
        e._tag === "ConsumerStatusNotReady" || e._tag === "ParseError",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(60)]),
    }),
  );

const waitForConsumerDeleted = (consumerArn: string) =>
  Effect.gen(function* () {
    yield* kinesis.describeStreamConsumer({
      ConsumerARN: consumerArn,
    });
    return yield* Effect.fail({ _tag: "ConsumerStillExists" as const });
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) =>
        e._tag === "ConsumerStillExists" || e._tag === "ParseError",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(60)]),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

export const StreamConsumerProvider = () =>
  Provider.succeed(StreamConsumer, {
    stables: ["consumerArn", "consumerName"],
    read: Effect.fn(function* ({ id, olds, output }) {
      const consumerName =
        output?.consumerName ?? (yield* createConsumerName(id, olds ?? {}));
      const streamArn = output?.streamArn ?? olds?.streamArn;
      // describeStreamConsumer rejects with InvalidArgumentException unless
      // either consumerARN, or both streamARN + consumerName, are provided.
      // If the engine probed for adoption before our upstream Stream was
      // created we'll have neither — treat that as "doesn't exist".
      if (typeof streamArn !== "string" && !output?.consumerArn) {
        return undefined;
      }
      const state = yield* readConsumer({
        streamArn: typeof streamArn === "string" ? streamArn : undefined,
        consumerName,
        consumerArn: output?.consumerArn,
      });
      if (!state) return undefined;
      return (yield* hasAlchemyTags(id, state.tags as Tags))
        ? state
        : Unowned(state);
    }),
    diff: Effect.fn(function* ({ id, news, olds }) {
      if (!isResolved(news)) return;
      const oldConsumerName = yield* createConsumerName(id, olds);
      const newConsumerName = yield* createConsumerName(id, news);
      if (oldConsumerName !== newConsumerName) {
        return { action: "replace" } as const;
      }
      if (
        typeof news.streamArn === "string" &&
        typeof olds.streamArn === "string" &&
        news.streamArn !== olds.streamArn
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const consumerName =
        output?.consumerName ?? (yield* createConsumerName(id, news));
      const streamArn = news.streamArn as string;
      const internalTags = yield* createInternalTags(id);
      const desiredTags = { ...internalTags, ...news.tags };

      // Observe — fetch live cloud state. `output` is treated as a cache
      // for the consumer ARN; the consumer's actual existence and tags are
      // fetched fresh so the reconciler converges regardless of drift,
      // adoption, or a partially-completed prior run.
      let state = yield* readConsumer({
        streamArn,
        consumerName,
        consumerArn: output?.consumerArn,
      });

      // Ensure — register the consumer if it's missing. Tolerate
      // `ResourceInUseException` as a race with a peer reconciler: a
      // brief registry-consistency wait, then re-read and continue the
      // sync path.
      if (state === undefined) {
        yield* kinesis
          .registerStreamConsumer({
            StreamARN: streamArn,
            ConsumerName: consumerName,
            Tags: desiredTags,
          })
          .pipe(
            // The upstream Stream provider waits for ACTIVE via
            // describeStreamSummary, but the consumer-registry control plane
            // is eventually consistent against that: registerStreamConsumer
            // can briefly 404 ("Stream ... not found") for a stream that
            // describeStreamSummary already reports ACTIVE. Ride out that
            // propagation window before giving up.
            Effect.retry({
              while: (e) => e._tag === "ResourceNotFoundException",
              schedule: Schedule.max([
                Schedule.exponential(500),
                Schedule.recurs(8),
              ]),
            }),
            Effect.asVoid,
            Effect.catchTag("ResourceInUseException", () =>
              adoptExistingConsumer(streamArn, consumerName).pipe(
                Effect.asVoid,
              ),
            ),
          );

        state = yield* adoptExistingConsumer(streamArn, consumerName);
        yield* waitForConsumerStatus(state.consumerArn, "ACTIVE");

        state = yield* readConsumer({
          consumerArn: state.consumerArn,
          streamArn,
          consumerName,
        });
        if (state === undefined) {
          return yield* Effect.fail(
            new Error(`failed to read created consumer ${consumerName}`),
          );
        }
      }

      // Sync tags — diff observed cloud tags against desired. Adoption
      // may bring us a consumer that already has its own tag set; diffing
      // against `state.tags` (fetched fresh) lets the reconciler converge
      // ownership without fighting whatever was there before.
      const { removed, upsert } = diffTags(state.tags, desiredTags);

      if (removed.length > 0) {
        yield* kinesis.untagResource({
          ResourceARN: state.consumerArn,
          TagKeys: removed,
        });
      }

      if (upsert.length > 0) {
        const tagsToAdd: Record<string, string> = {};
        for (const { Key, Value } of upsert) {
          tagsToAdd[Key] = Value;
        }
        yield* kinesis.tagResource({
          ResourceARN: state.consumerArn,
          Tags: tagsToAdd,
        });
      }

      // Re-read final state so the returned attributes reflect what's
      // actually in the cloud after all sync steps.
      const final = yield* readConsumer({
        consumerArn: state.consumerArn,
      });
      if (!final) {
        return yield* Effect.fail(
          new Error(`failed to read reconciled consumer ${consumerName}`),
        );
      }

      yield* session.note(final.consumerArn);
      return final;
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* kinesis
        .deregisterStreamConsumer({
          ConsumerARN: output.consumerArn,
        })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));

      yield* waitForConsumerDeleted(output.consumerArn);
    }),
    // Consumers are stream-scoped: listStreamConsumers requires a StreamARN.
    // Fan out — enumerate every stream in the account/region, then list the
    // consumers registered on each stream, then hydrate tags per consumer.
    list: Effect.fn(function* () {
      const streamArns = yield* kinesis.listStreams.pages({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.StreamSummaries ?? [])
              .map((summary) => summary.StreamARN)
              .filter((arn): arn is string => typeof arn === "string"),
          ),
        ),
      );

      const consumers = yield* Effect.forEach(
        streamArns,
        (streamArn) =>
          kinesis.listStreamConsumers.pages({ StreamARN: streamArn }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.Consumers ?? []).map((consumer) => ({
                  streamArn,
                  consumer,
                })),
              ),
            ),
            // A stream may be deleted mid-enumeration; skip it.
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(
                [] as { streamArn: string; consumer: kinesis.Consumer }[],
              ),
            ),
          ),
        { concurrency: 10 },
      ).pipe(Effect.map((rows) => rows.flat()));

      const hydrated = yield* Effect.forEach(
        consumers,
        ({ streamArn, consumer }) =>
          kinesis
            .listTagsForResource({ ResourceARN: consumer.ConsumerARN })
            .pipe(
              Effect.map((tagsResponse): StreamConsumer["Attributes"] => ({
                consumerName: consumer.ConsumerName,
                consumerArn: consumer.ConsumerARN,
                consumerStatus: consumer.ConsumerStatus as ConsumerStatus,
                streamArn: streamArn as StreamArn,
                consumerCreationTimestamp: consumer.ConsumerCreationTimestamp,
                tags: toTagRecord(tagsResponse.Tags),
              })),
              // A consumer may be deregistered between list and tag fetch.
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            ),
        { concurrency: 10 },
      );

      return hydrated.filter(
        (row): row is StreamConsumer["Attributes"] => row !== undefined,
      );
    }),
  });
