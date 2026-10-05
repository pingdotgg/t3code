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
  type LoggingConfig,
  changedFields,
  compact,
  cryptoKeyKey,
  collectPages,
  hasAlchemyLabelKeys,
  loggingKey,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameJson,
  textKey,
  toLoggingConfig,
  toPhysicalId,
  userAnnotations,
  userLabels,
  retryOnTransient,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

export type { LoggingConfig } from "./internal.ts";

const COLLECTION = "messageBuses";

export type MessageBusProps = {
  /**
   * Message bus id (the `{messageBus}` segment of
   * `projects/{project}/locations/{location}/messageBuses/{messageBus}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must match `[a-z]([a-z0-9-]*[a-z0-9])?` and be 1-63
   * characters. Immutable — changing it replaces the bus.
   */
  messageBusId?: string;
  /**
   * Eventarc Advanced location (`us-central1`, `us-east4`, …). Immutable
   * — changing it replaces the bus. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable display name.
   */
  displayName?: string;
  /**
   * Customer-managed Cloud KMS key used to encrypt/decrypt event data,
   * as
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   */
  cryptoKeyName?: string;
  /**
   * Platform logging configuration applied to the bus and its
   * enrollments.
   */
  loggingConfig?: LoggingConfig;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Free-form annotations.
   */
  annotations?: Record<string, string>;
};

export type MessageBus = Resource<
  "GCP.Eventarc.MessageBus",
  MessageBusProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/messageBuses/{messageBus}`. */
    name: string;
    /** Message bus id (last path segment). */
    messageBusId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Customer-managed KMS key, if any. */
    cryptoKeyName: string | undefined;
    /** Platform logging configuration. */
    loggingConfig: LoggingConfig | undefined;
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
 * An Eventarc Advanced message bus that routes published events to
 * enrollments. One bus may exist per project per region.
 *
 * `messageBusId` and `location` are identity — changing either replaces
 * the bus. Display name, labels, annotations, logging, and CMEK update
 * in place.
 *
 * ### Creating a MessageBus
 * **Example:** Generated name
 * ```typescript
 * const bus = yield* GCP.Eventarc.MessageBus("Events", {
 *   location: "us-central1",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Named bus with logging
 * ```typescript
 * const bus = yield* GCP.Eventarc.MessageBus("Events", {
 *   messageBusId: "app-events",
 *   location: "us-central1",
 *   displayName: "app events",
 *   loggingConfig: { logSeverity: "INFO" },
 * });
 * ```
 *
 * ### Updating a MessageBus
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical bus and patches it in place.
 *
 * **Example:** Change labels and display name
 * ```typescript
 * const bus = yield* GCP.Eventarc.MessageBus("Events", {
 *   location: "us-central1",
 *   displayName: "app events v2",
 *   labels: { env: "prod", role: "bus" },
 * });
 * ```
 *
 * @resource
 * @category Eventarc
 */
export const MessageBus = Resource<MessageBus>("GCP.Eventarc.MessageBus");

const toAttrs = (bus: eventarc.MessageBus, project: string, region: string) => {
  const name = bus.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    messageBusId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: bus.displayName,
    cryptoKeyName: bus.cryptoKeyName,
    loggingConfig: toLoggingConfig(bus.loggingConfig),
    labels: userLabels(bus.labels),
    annotations: userAnnotations(bus.annotations),
    uid: bus.uid,
    etag: bus.etag,
    createTime: bus.createTime,
    updateTime: bus.updateTime,
  };
};

const getByName = (name: string) =>
  eventarc
    .getProjectsLocationsMessageBuses({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const MessageBusProvider = () =>
  Provider.succeed(MessageBus, {
    stables: [
      "name",
      "messageBusId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.messageBusId ?? output?.messageBusId;
      const nextId = news.messageBusId
        ? rfc1035(news.messageBusId, "message-bus")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const messageBusId = yield* toPhysicalId(
        id,
        olds?.messageBusId,
        output?.messageBusId,
        "message-bus",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, messageBusId);
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
          eventarc.listProjectsLocationsMessageBuses.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.messageBuses,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const messageBusId = yield* toPhysicalId(
        id,
        news.messageBusId,
        output?.messageBusId,
        "message-bus",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        messageBusId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredLogging = toLoggingConfig(news.loggingConfig);
      const desiredCrypto =
        news.cryptoKeyName && news.cryptoKeyName.length > 0
          ? news.cryptoKeyName
          : undefined;
      const desiredAnnotations = news.annotations
        ? tagRecord(news.annotations)
        : undefined;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* eventarc
          .createProjectsLocationsMessageBuses({
            parent: parentOf(env.project, location),
            messageBusId,
            body: compact({
              name,
              displayName: news.displayName,
              cryptoKeyName: desiredCrypto,
              loggingConfig: desiredLogging,
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
        [
          "displayName",
          textKey(current.displayName) !== textKey(news.displayName),
        ],
        [
          "cryptoKeyName",
          cryptoKeyKey(current.cryptoKeyName) !== cryptoKeyKey(desiredCrypto),
        ],
        [
          "loggingConfig",
          loggingKey(current.loggingConfig) !== loggingKey(desiredLogging),
        ],
        [
          "annotations",
          !sameJson(tagRecord(current.annotations), desiredAnnotations ?? {}),
        ],
      ]);

      if (updateMask.length > 0) {
        const patched = yield* eventarc.patchProjectsLocationsMessageBuses({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            name: current.name ?? name,
            displayName: news.displayName,
            cryptoKeyName: desiredCrypto,
            loggingConfig: desiredLogging,
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
            .deleteProjectsLocationsMessageBuses({
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
