import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { isResolved } from "../../Diff.ts";
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

export type TopicProps = {
  /**
   * Topic id (the `{topic}` segment of `projects/{project}/topics/{topic}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id.
   */
  topicId?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Cloud KMS key used to encrypt messages, as
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   */
  kmsKeyName?: string;
  /**
   * Minimum duration to retain published messages (e.g. `"86400s"`).
   */
  messageRetentionDuration?: string;
};

export type Topic = Resource<
  "GCP.PubSub.Topic",
  TopicProps,
  {
    /** Full resource name `projects/{project}/topics/{topic}`. */
    name: string;
    /** Topic id (last path segment). */
    topicId: string;
    /** Project id. */
    project: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** KMS key used for encryption, if any. */
    kmsKeyName: string | undefined;
    /** Message retention duration, if set. */
    messageRetentionDuration: string | undefined;
    /** Server-reported topic state. */
    state: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Pub/Sub topic.
 *
 * ### Creating a Topic
 * **Example:** Generated name
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("events", {});
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("events", {
 *   topicId: "order-events",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Topic
 * **Example:** Change labels
 * ```typescript
 * const topic = yield* GCP.PubSub.Topic("events", {
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Binding from a Function
 * **Example:** Publish from Cloud Run
 * ```typescript
 * export class Api extends GCP.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* GCP.PubSub.Topic("events", {});
 *     const publish = yield* GCP.PubSub.Publish(topic);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* publish({
 *           body: { messages: [{ data: btoa("hello") }] },
 *         }).pipe(Effect.orDie);
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(Effect.provide([GCP.PubSub.PublishHttp])),
 * ) {}
 * ```
 *
 * ### Destroying a Topic
 * **Example:** `alchemy destroy` deletes the topic after its subscriptions.
 *
 * @resource
 * @category PubSub
 */
export const Topic = Resource<Topic>("GCP.PubSub.Topic");

export class TopicStillExists extends Data.TaggedError(
  "GCP.PubSub.TopicStillExists",
)<{ name: string }> {}

export class TopicNotResolved extends Data.TaggedError(
  "GCP.PubSub.TopicNotResolved",
)<{
  name: string;
}> {}

const topicIdOf = (name: string) => name.split("/").pop() ?? name;

const resourceName = (project: string, topicId: string) =>
  `projects/${project}/topics/${topicId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, topicId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      topicId ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: 255, lowercase: true }))
    );
  });

const toAttrs = (topic: pubsub.Topic, project: string) => {
  const name = topic.name ?? "";
  return {
    name,
    topicId: topicIdOf(name),
    project,
    labels: userLabels(topic.labels),
    kmsKeyName: topic.kmsKeyName,
    messageRetentionDuration: topic.messageRetentionDuration,
    state: topic.state,
  };
};

const getByName = (name: string) =>
  pubsub
    .getProjectsTopics({ topic: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

// Pub/Sub serves reads from replicas that lag writes: one successful GET
// does not mean the next one (or a publish routed to it) sees the
// resource. Require consecutive successful reads before reporting ready.
const CONSISTENT_READS = 3;

const waitUntilPresent = (name: string) =>
  Effect.gen(function* () {
    let found: pubsub.Topic | undefined;
    for (let read = 0; read < CONSISTENT_READS; read++) {
      if (read > 0) yield* Effect.sleep("1 second");
      found = yield* getByName(name);
      if (found === undefined) {
        return yield* new TopicNotResolved({ name });
      }
    }
    return found!;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.PubSub.TopicNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 60,
    }),
  );

export const TopicProvider = () =>
  Provider.succeed(Topic, {
    stables: ["name", "topicId", "project"],

    // topicId is the physical identity: a new id is a new topic, and the
    // old one must be deleted (not left behind by an in-place "update").
    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = output?.topicId ?? olds?.topicId;
      if (previous === undefined) return undefined;
      const next = yield* toId(id, news.topicId, output?.topicId);
      return next !== previous
        ? { action: "replace" as const, deleteFirst: false }
        : undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const topicId = yield* toId(id, olds?.topicId, output?.topicId);
      const name = output?.name ?? resourceName(env.project, topicId);
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
        return yield* pubsub.listProjectsTopics
          .pages({
            project: `projects/${env.project}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.topics ?? [])),
            Stream.filter((topic) =>
              Object.keys(topic.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((topic) => toAttrs(topic, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const topicId = yield* toId(id, news.topicId, output?.topicId);
      const name = resourceName(env.project, topicId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        yield* pubsub
          .createProjectsTopics({
            name,
            body: {
              labels: desiredLabels,
              kmsKeyName: news.kmsKeyName,
              messageRetentionDuration: news.messageRetentionDuration,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        // Block until Pub/Sub serves the topic, not just the create response.
        current = yield* waitUntilPresent(name);
      }

      if (current === undefined) {
        return yield* new TopicNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const kmsChanged = (current.kmsKeyName ?? "") !== (news.kmsKeyName ?? "");
      const retentionChanged =
        (current.messageRetentionDuration ?? "") !==
        (news.messageRetentionDuration ?? "");

      if (labelsChanged || kmsChanged || retentionChanged) {
        current = yield* pubsub.patchProjectsTopics({
          name,
          body: {
            topic: {
              name,
              labels: desiredLabels,
              kmsKeyName: news.kmsKeyName,
              messageRetentionDuration: news.messageRetentionDuration,
            },
            updateMask: [
              labelsChanged ? "labels" : undefined,
              kmsChanged ? "kmsKeyName" : undefined,
              retentionChanged ? "messageRetentionDuration" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* pubsub
        .deleteProjectsTopics({ topic: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      // Pub/Sub reads lag deletes; block until it stops serving it.
      yield* getByName(output.name).pipe(
        Effect.filterOrFail(
          (existing) => existing === undefined,
          () => new TopicStillExists({ name: output.name }),
        ),
        Effect.retry({
          while: (error) => error._tag === "GCP.PubSub.TopicStillExists",
          schedule: Schedule.spaced("2 seconds"),
          times: 30,
        }),
      );
    }),
  });
