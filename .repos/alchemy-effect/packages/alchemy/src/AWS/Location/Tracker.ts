import * as location from "@distilled.cloud/aws/location";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import { toTagRecord } from "./internal.ts";

export type PositionFiltering = "TimeBased" | "DistanceBased" | "AccuracyBased";

export interface TrackerProps {
  /**
   * Name of the tracker. Immutable — changing it replaces the tracker.
   * @default ${app}-${stage}-${id}
   */
  trackerName?: string;
  /**
   * KMS key ID used to encrypt the tracker's position data. Immutable —
   * changing it replaces the tracker.
   */
  kmsKeyId?: string;
  /**
   * The position filtering method applied to device updates.
   * @default "TimeBased"
   */
  positionFiltering?: PositionFiltering;
  /**
   * Whether to publish device position updates to EventBridge.
   * @default false
   */
  eventBridgeEnabled?: boolean;
  /**
   * Optional description of the tracker resource.
   */
  description?: string;
  /**
   * Tags to associate with the tracker.
   */
  tags?: Record<string, string>;
}

export interface Tracker extends Resource<
  "AWS.Location.Tracker",
  TrackerProps,
  {
    /** Physical name of the tracker. */
    trackerName: string;
    /** ARN of the tracker. */
    trackerArn: string;
    /** KMS key ID backing the tracker, if configured. */
    kmsKeyId: string | undefined;
    /** Position filtering method applied to updates. */
    positionFiltering: string | undefined;
    /** Whether device updates are published to EventBridge. */
    eventBridgeEnabled: boolean | undefined;
    /** Description of the tracker. */
    description: string | undefined;
    /** Tags currently associated with the tracker. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Location Service tracker. A tracker records device positions and
 * evaluates them against linked geofence collections. The KMS key is
 * immutable; position filtering, EventBridge publishing, and the description
 * can be updated in place.
 *
 * @resource
 * @section Creating Trackers
 * @example Basic Tracker
 * ```typescript
 * import * as Location from "alchemy/AWS/Location";
 *
 * const tracker = yield* Location.Tracker("Devices", {});
 * ```
 *
 * @example Distance-Filtered Tracker with EventBridge
 * ```typescript
 * const tracker = yield* Location.Tracker("Fleet", {
 *   positionFiltering: "DistanceBased",
 *   eventBridgeEnabled: true,
 * });
 * ```
 */
export const Tracker = Resource<Tracker>("AWS.Location.Tracker");

const createTrackerName = (
  id: string,
  props: { trackerName?: string | undefined },
) =>
  Effect.gen(function* () {
    if (props.trackerName) return props.trackerName;
    return yield* createPhysicalName({ id, maxLength: 100 });
  });

const readTracker = Effect.fn(function* (trackerName: string) {
  const found = yield* location
    .describeTracker({ TrackerName: trackerName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!found) return undefined;
  return {
    trackerName: found.TrackerName,
    trackerArn: found.TrackerArn,
    kmsKeyId: found.KmsKeyId,
    positionFiltering: found.PositionFiltering,
    eventBridgeEnabled: found.EventBridgeEnabled,
    description: found.Description ? found.Description : undefined,
    tags: toTagRecord(found.Tags),
  } satisfies Tracker["Attributes"];
});

export const TrackerProvider = () =>
  Provider.effect(
    Tracker,
    Effect.gen(function* () {
      return {
        stables: ["trackerName", "trackerArn"],
        list: () =>
          Effect.gen(function* () {
            const names = yield* location.listTrackers.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Entries ?? []).map((entry) => entry.TrackerName),
                ),
              ),
            );
            const hydrated = yield* Effect.forEach(
              names,
              (name) => readTracker(name),
              { concurrency: 10 },
            );
            return hydrated.filter(
              (attrs): attrs is Tracker["Attributes"] => attrs !== undefined,
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const trackerName =
            output?.trackerName ?? (yield* createTrackerName(id, olds ?? {}));
          const state = yield* readTracker(trackerName);
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags as Tags))
            ? state
            : Unowned(state);
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return;
          const oldName = yield* createTrackerName(id, olds);
          const newName = yield* createTrackerName(id, news);
          if (oldName !== newName || olds.kmsKeyId !== news.kmsKeyId) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const trackerName =
            output?.trackerName ?? (yield* createTrackerName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          let state = yield* readTracker(trackerName);

          if (state === undefined) {
            yield* location
              .createTracker({
                TrackerName: trackerName,
                KmsKeyId: news.kmsKeyId,
                PositionFiltering: news.positionFiltering,
                EventBridgeEnabled: news.eventBridgeEnabled,
                Description: news.description,
                Tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            state = yield* readTracker(trackerName);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created tracker ${trackerName}`),
              );
            }
          }

          const desiredFiltering = news.positionFiltering ?? "TimeBased";
          const desiredEventBridge = news.eventBridgeEnabled ?? false;
          if (
            state.description !== (news.description ?? undefined) ||
            state.positionFiltering !== desiredFiltering ||
            (state.eventBridgeEnabled ?? false) !== desiredEventBridge
          ) {
            yield* location.updateTracker({
              TrackerName: trackerName,
              Description: news.description,
              PositionFiltering: news.positionFiltering,
              EventBridgeEnabled: news.eventBridgeEnabled,
            });
          }

          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (removed.length > 0) {
            yield* location.untagResource({
              ResourceArn: state.trackerArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* location.tagResource({
              ResourceArn: state.trackerArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }

          yield* session.note(state.trackerArn);

          const final = yield* readTracker(trackerName);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled tracker ${trackerName}`),
            );
          }
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* location
            .deleteTracker({ TrackerName: output.trackerName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
