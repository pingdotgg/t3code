import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type SnapshotProps = {
  /**
   * Snapshot id (the `{snapshot}` segment of
   * `projects/{project}/snapshots/{snapshot}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Changing it
   * replaces the snapshot.
   */
  snapshotId?: string;
  /**
   * Subscription whose backlog this snapshot retains. Accepts a full
   * resource name (`projects/{project}/subscriptions/{subscription}`) or
   * a subscription id. Immutable — changing it replaces the snapshot.
   */
  subscription: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Snapshot = Resource<
  "GCP.PubSub.Snapshot",
  SnapshotProps,
  {
    /** Full resource name `projects/{project}/snapshots/{snapshot}`. */
    name: string;
    /** Snapshot id (last path segment). */
    snapshotId: string;
    /** Project id. */
    project: string;
    /** Topic this snapshot is retaining messages from. */
    topic: string | undefined;
    /** RFC3339 time after which the snapshot is no longer guaranteed. */
    expireTime: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Pub/Sub snapshot of a subscription's message backlog.
 *
 * Snapshots capture unacked messages at creation time (and subsequent
 * publishes to the topic) so a subscription can later `Seek` back to that
 * point. The source `subscription` is immutable — changing it replaces the
 * snapshot. Labels can be updated in place.
 *
 * ### Creating a Snapshot
 * **Example:** Snapshot of a pull subscription
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("events", {});
 * const subscription = yield* GCP.PubSub.Subscription("orders", {
 *   topic: topic.name,
 * });
 * const snapshot = yield* GCP.PubSub.Snapshot("checkpoint", {
 *   subscription: subscription.name,
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("events", {});
 * const subscription = yield* GCP.PubSub.Subscription("orders", {
 *   topic: topic.name,
 * });
 * const snapshot = yield* GCP.PubSub.Snapshot("checkpoint", {
 *   snapshotId: "order-checkpoint",
 *   subscription: subscription.name,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category PubSub
 */
export const Snapshot = Resource<Snapshot>("GCP.PubSub.Snapshot");

export class SnapshotNotResolved extends Data.TaggedError(
  "GCP.PubSub.SnapshotNotResolved",
)<{
  name: string;
}> {}

export class SnapshotStillExists extends Data.TaggedError(
  "GCP.PubSub.SnapshotStillExists",
)<{
  name: string;
}> {}

const snapshotIdOf = (name: string) => name.split("/").pop() ?? name;

const resourceName = (project: string, snapshotId: string) =>
  `projects/${project}/snapshots/${snapshotId}`;

const subscriptionNameOf = (project: string, subscription: string) =>
  subscription.startsWith("projects/")
    ? subscription
    : `projects/${project}/subscriptions/${subscription}`;

const resourceKey = (value: string | undefined) =>
  value === undefined ? undefined : snapshotIdOf(value);

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, snapshotId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (snapshotId !== undefined) return snapshotId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 255,
      lowercase: true,
      forbiddenPrefixes: ["goog"],
    });
    return /^[a-z]/.test(generated) ? generated : `s${generated}`.slice(0, 255);
  });

const toAttrs = (snapshot: pubsub.Snapshot, project: string) => {
  const name = snapshot.name ?? "";
  return {
    name,
    snapshotId: snapshotIdOf(name),
    project,
    topic: snapshot.topic,
    expireTime: snapshot.expireTime,
    labels: userLabels(snapshot.labels),
  };
};

const getByName = (name: string) =>
  pubsub
    .getProjectsSnapshots({ snapshot: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (existing): existing is undefined => existing === undefined,
      () => new SnapshotStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) => error._tag === "GCP.PubSub.SnapshotStillExists",
      // Pub/Sub reads lag deletes; allow up to a minute.
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
  );

const CONSISTENT_READS = 3;

const waitUntilPresent = (name: string) =>
  Effect.gen(function* () {
    let found: pubsub.Snapshot | undefined;
    for (let read = 0; read < CONSISTENT_READS; read++) {
      if (read > 0) yield* Effect.sleep("1 second");
      found = yield* getByName(name);
      if (found === undefined) return yield* new SnapshotNotResolved({ name });
    }
    return found!;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.PubSub.SnapshotNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 60,
    }),
  );

export const SnapshotProvider = () =>
  Provider.succeed(Snapshot, {
    stables: ["name", "snapshotId", "project", "topic"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.snapshotId ?? output?.snapshotId;
      const nameChanged =
        news.snapshotId !== undefined &&
        previousId !== undefined &&
        news.snapshotId !== previousId;
      const previousSubscription = olds?.subscription;
      const subscriptionChanged =
        previousSubscription !== undefined &&
        resourceKey(news.subscription) !== resourceKey(previousSubscription);
      if (!nameChanged && !subscriptionChanged) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst:
          !nameChanged &&
          previousId !== undefined &&
          (news.snapshotId ?? previousId) === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const snapshotId = yield* toId(id, olds?.snapshotId, output?.snapshotId);
      const name = output?.name ?? resourceName(env.project, snapshotId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* pubsub.listProjectsSnapshots
          .pages({
            project: `projects/${env.project}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.snapshots ?? [])),
            Stream.filter((snapshot) =>
              Object.keys(snapshot.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((snapshot) => toAttrs(snapshot, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const snapshotId = yield* toId(id, news.snapshotId, output?.snapshotId);
      const name = resourceName(env.project, snapshotId);
      const subscriptionName = subscriptionNameOf(
        env.project,
        news.subscription,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      // Snapshot GET does not return the source subscription. Recreate when
      // persisted props show it changed — the field is immutable.
      const subscriptionChanged =
        olds?.subscription !== undefined &&
        resourceKey(news.subscription) !== resourceKey(olds.subscription);

      let current = yield* getByName(name);
      if (current !== undefined && subscriptionChanged) {
        yield* pubsub
          .deleteProjectsSnapshots({ snapshot: name })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* waitUntilGone(name);
        current = undefined;
      }

      if (current === undefined) {
        yield* pubsub
          .createProjectsSnapshots({
            name,
            body: {
              subscription: subscriptionName,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        // Block until Pub/Sub consistently serves the snapshot; the next
        // call (label patch) can otherwise hit a lagging replica.
        current = yield* waitUntilPresent(name);
      }

      if (current === undefined) {
        return yield* new SnapshotNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        current = yield* pubsub.patchProjectsSnapshots({
          name,
          body: {
            snapshot: {
              name,
              labels: desiredLabels,
            },
            updateMask: "labels",
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* pubsub
        .deleteProjectsSnapshots({ snapshot: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(output.name);
    }),
  });
