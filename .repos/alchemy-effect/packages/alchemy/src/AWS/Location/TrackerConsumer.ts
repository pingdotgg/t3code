import * as location from "@distilled.cloud/aws/location";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface TrackerConsumerProps {
  /**
   * Name of the tracker whose device position updates are consumed.
   * Changing it replaces the association.
   */
  trackerName: string;
  /**
   * ARN of the geofence collection that consumes the tracker's position
   * updates (evaluating them against its geofences). Changing it replaces
   * the association.
   */
  consumerArn: string;
}

export interface TrackerConsumer extends Resource<
  "AWS.Location.TrackerConsumer",
  TrackerConsumerProps,
  {
    /** Name of the tracker. */
    trackerName: string;
    /** ARN of the consuming geofence collection. */
    consumerArn: string;
  },
  never,
  Providers
> {}

/**
 * Links an Amazon Location {@link Tracker} to a {@link GeofenceCollection}
 * so every device position uploaded to the tracker is automatically
 * evaluated against the collection's geofences, emitting ENTER/EXIT events
 * (delivered to EventBridge — see `consumeTrackerEvents`).
 *
 * The association is existence-only: both properties are immutable and any
 * change replaces it.
 *
 * @resource
 * @section Linking Trackers to Geofence Collections
 * @example Evaluate Tracker Positions Against a Collection
 * ```typescript
 * import * as Location from "alchemy/AWS/Location";
 *
 * const tracker = yield* Location.Tracker("Fleet", {
 *   eventBridgeEnabled: true,
 * });
 * const fences = yield* Location.GeofenceCollection("Zones", {});
 *
 * const link = yield* Location.TrackerConsumer("FleetZones", {
 *   trackerName: tracker.trackerName,
 *   consumerArn: fences.collectionArn,
 * });
 * ```
 */
export const TrackerConsumer = Resource<TrackerConsumer>(
  "AWS.Location.TrackerConsumer",
);

export const TrackerConsumerProvider = () =>
  Provider.effect(
    TrackerConsumer,
    Effect.gen(function* () {
      /** Whether `consumerArn` is currently linked to `trackerName`. */
      const observeAssociation = Effect.fn(function* (
        trackerName: string,
        consumerArn: string,
      ) {
        const consumerArns = yield* location.listTrackerConsumers
          .pages({ TrackerName: trackerName })
          .pipe(
            EffectStream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.ConsumerArns),
            ),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed([] as string[]),
            ),
          );
        return consumerArns.includes(consumerArn);
      });

      return {
        stables: ["trackerName", "consumerArn"],
        list: () =>
          Effect.gen(function* () {
            const trackerNames = yield* location.listTrackers.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Entries ?? []).map((entry) => entry.TrackerName),
                ),
              ),
            );
            const associations = yield* Effect.forEach(
              trackerNames,
              (trackerName) =>
                location.listTrackerConsumers
                  .pages({ TrackerName: trackerName })
                  .pipe(
                    EffectStream.runCollect,
                    Effect.map((chunk) =>
                      Array.from(chunk).flatMap((page) =>
                        page.ConsumerArns.map((consumerArn) => ({
                          trackerName,
                          consumerArn,
                        })),
                      ),
                    ),
                    // Tracker deleted between the two list calls.
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed([]),
                    ),
                  ),
              { concurrency: 5 },
            );
            return associations.flat();
          }),
        read: Effect.fn(function* ({ olds, output }) {
          const trackerName = output?.trackerName ?? olds?.trackerName;
          const consumerArn = output?.consumerArn ?? olds?.consumerArn;
          if (!trackerName || !consumerArn) return undefined;
          const exists = yield* observeAssociation(trackerName, consumerArn);
          return exists ? { trackerName, consumerArn } : undefined;
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (
            olds.trackerName !== news.trackerName ||
            olds.consumerArn !== news.consumerArn
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const exists = yield* observeAssociation(
            news.trackerName,
            news.consumerArn,
          );
          if (!exists) {
            yield* location
              .associateTrackerConsumer({
                TrackerName: news.trackerName,
                ConsumerArn: news.consumerArn,
              })
              .pipe(
                // Racing reconciles: the association already exists.
                Effect.catchTag("ConflictException", () => Effect.void),
              );
          }
          yield* session.note(`${news.trackerName} -> ${news.consumerArn}`);
          return {
            trackerName: news.trackerName,
            consumerArn: news.consumerArn,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* location
            .disassociateTrackerConsumer({
              TrackerName: output.trackerName,
              ConsumerArn: output.consumerArn,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
