import * as eventarc from "@distilled.cloud/gcp/eventarc_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  changedFields,
  compact,
  collectPages,
  expandResource,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameJson,
  textKey,
  toPhysicalId,
  userAnnotations,
  userLabels,
  retryOnTransient,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "enrollments";

export type EnrollmentProps = {
  /**
   * Enrollment id (the `{enrollment}` segment of
   * `projects/{project}/locations/{location}/enrollments/{enrollment}`).
   * If omitted, a unique name is generated. Must match
   * `[a-z]([a-z0-9-]*[a-z0-9])?` and be 1-63 characters. Immutable —
   * changing it replaces the enrollment.
   */
  enrollmentId?: string;
  /**
   * Eventarc Advanced location (`us-central1`, `us-east4`, …). Immutable
   * — changing it replaces the enrollment. `US-CENTRAL1` is accepted
   * and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * MessageBus this enrollment reads from, as
   * `projects/{project}/locations/{location}/messageBuses/{messageBus}`
   * or the `{messageBus}` segment. Immutable — changing it replaces the
   * enrollment.
   */
  messageBus: string;
  /**
   * Pipeline that receives matched messages, as
   * `projects/{project}/locations/{location}/pipelines/{pipeline}` or
   * the `{pipeline}` segment.
   */
  destination: string;
  /**
   * CEL expression identifying which messages this enrollment applies
   * to, e.g. `message.type == 'google.cloud.pubsub.topic.v1.messagePublished'`
   * or `true` to match every message.
   */
  celMatch: string;
  /**
   * Human-readable display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Free-form annotations.
   */
  annotations?: Record<string, string>;
};

export type Enrollment = Resource<
  "GCP.Eventarc.Enrollment",
  EnrollmentProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/enrollments/{enrollment}`. */
    name: string;
    /** Enrollment id (last path segment). */
    enrollmentId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Source MessageBus resource name. */
    messageBus: string | undefined;
    /** Destination Pipeline resource name. */
    destination: string | undefined;
    /** CEL match expression. */
    celMatch: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Server-assigned UUID4, stable until delete. */
    uid: string | undefined;
    /** Server checksum of the resource. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Eventarc Advanced enrollment that subscribes to messages on a
 * MessageBus and delivers matches to a Pipeline.
 *
 * `enrollmentId`, `location`, and `messageBus` are identity — changing
 * any of them replaces the enrollment. Destination, CEL match, display
 * name, labels, and annotations update in place.
 *
 * ### Creating an Enrollment
 * **Example:** Match every message
 * ```typescript
 * const bus = yield* GCP.Eventarc.MessageBus("Events", {
 *   location: "us-central1",
 * });
 * const pipeline = yield* GCP.Eventarc.Pipeline("Sink", {
 *   location: "us-central1",
 *   destinations: [{ topic: topic.name }],
 * });
 * const enrollment = yield* GCP.Eventarc.Enrollment("All", {
 *   location: "us-central1",
 *   messageBus: bus.name,
 *   destination: pipeline.name,
 *   celMatch: "true",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Enrollment
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical enrollment and patches it in place.
 *
 * **Example:** Tighten the CEL match
 * ```typescript
 * const enrollment = yield* GCP.Eventarc.Enrollment("All", {
 *   location: "us-central1",
 *   messageBus: bus.name,
 *   destination: pipeline.name,
 *   celMatch: "message.type == 'google.cloud.pubsub.topic.v1.messagePublished'",
 *   labels: { env: "prod", role: "enrollment" },
 * });
 * ```
 *
 * @resource
 * @category Eventarc
 */
export const Enrollment = Resource<Enrollment>("GCP.Eventarc.Enrollment");

const toAttrs = (
  enrollment: eventarc.Enrollment,
  project: string,
  region: string,
) => {
  const name = enrollment.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    enrollmentId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    messageBus: enrollment.messageBus,
    destination: enrollment.destination,
    celMatch: enrollment.celMatch,
    displayName: enrollment.displayName,
    labels: userLabels(enrollment.labels),
    annotations: userAnnotations(enrollment.annotations),
    uid: enrollment.uid,
    etag: enrollment.etag,
    createTime: enrollment.createTime,
    updateTime: enrollment.updateTime,
  };
};

const getByName = (name: string) =>
  eventarc
    .getProjectsLocationsEnrollments({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const EnrollmentProvider = () =>
  Provider.succeed(Enrollment, {
    stables: [
      "name",
      "enrollmentId",
      "project",
      "location",
      "messageBus",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.enrollmentId ?? output?.enrollmentId;
      const nextId = news.enrollmentId
        ? rfc1035(news.enrollmentId, "enrollment")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousBus = olds?.messageBus ?? output?.messageBus ?? "";
      const nextBus = news.messageBus;
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousBus.length > 0 && previousBus !== nextBus)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousId !== undefined &&
            nextId !== undefined &&
            previousId === nextId &&
            previousLocation === nextLocation,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const enrollmentId = yield* toPhysicalId(
        id,
        olds?.enrollmentId,
        output?.enrollmentId,
        "enrollment",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, enrollmentId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          eventarc.listProjectsLocationsEnrollments.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.enrollments,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const enrollmentId = yield* toPhysicalId(
        id,
        news.enrollmentId,
        output?.enrollmentId,
        "enrollment",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        enrollmentId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const messageBus = expandResource(
        news.messageBus,
        env.project,
        location,
        "messageBuses",
      );
      const destination = expandResource(
        news.destination,
        env.project,
        location,
        "pipelines",
      );
      const desiredAnnotations = news.annotations
        ? tagRecord(news.annotations)
        : undefined;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* eventarc
          .createProjectsLocationsEnrollments({
            parent: parentOf(env.project, location),
            enrollmentId,
            body: compact({
              name,
              messageBus,
              destination,
              celMatch: news.celMatch,
              displayName: news.displayName,
              labels: desiredLabels,
              annotations: desiredAnnotations,
            }),
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const updateMask = changedFields([
        ["labels", upsert.length > 0 || removed.length > 0],
        ["destination", textKey(current.destination) !== destination],
        ["celMatch", textKey(current.celMatch) !== news.celMatch],
        [
          "displayName",
          textKey(current.displayName) !== textKey(news.displayName),
        ],
        [
          "annotations",
          !sameJson(tagRecord(current.annotations), desiredAnnotations ?? {}),
        ],
      ]);

      if (updateMask.length > 0) {
        const patched = yield* eventarc.patchProjectsLocationsEnrollments({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            name: current.name ?? name,
            destination,
            celMatch: news.celMatch,
            displayName: news.displayName,
            labels: desiredLabels,
            annotations: desiredAnnotations ?? {},
          },
        });
        yield* waitForOperation(patched);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retryOnTransient(
        Effect.gen(function* () {
          const existing = yield* getByName(output.name);
          if (existing === undefined) return;
          const operation = yield* eventarc
            .deleteProjectsLocationsEnrollments({
              name: output.name,
              allowMissing: true,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
          if (operation !== undefined) {
            yield* waitForOperation(operation, { notFoundOk: true });
          }
        }),
      ).pipe(
        Effect.catchTag("GCP.OperationFailed", (error) =>
          getByName(output.name).pipe(
            Effect.flatMap((current) =>
              current === undefined ? Effect.void : Effect.fail(error),
            ),
          ),
        ),
      );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
