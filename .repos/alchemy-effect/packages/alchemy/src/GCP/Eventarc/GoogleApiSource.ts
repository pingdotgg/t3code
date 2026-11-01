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
  expandResource,
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

const COLLECTION = "googleApiSources";

export type ProjectSubscriptions = {
  /**
   * Projects to receive events from, as `projects/{id}` or
   * `projects/{number}`. All projects must share an organization. At
   * most 100.
   */
  list?: string[];
};

export type OrganizationSubscription = {
  /**
   * When true, subscribe to events from every project in the source's
   * organization.
   */
  enabled?: boolean;
};

export type GoogleApiSourceProps = {
  /**
   * Google API source id (the `{googleApiSource}` segment of
   * `projects/{project}/locations/{location}/googleApiSources/{googleApiSource}`).
   * If omitted, a unique name is generated. Must match
   * `[a-z]([a-z0-9-]*[a-z0-9])?` and be 1-63 characters. Immutable —
   * changing it replaces the source.
   */
  googleApiSourceId?: string;
  /**
   * Eventarc Advanced location (`us-central1`, `us-east4`, …). Immutable
   * — changing it replaces the source. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`. One source is allowed per project per
   * region.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * MessageBus that receives Google API events, as
   * `projects/{project}/locations/{location}/messageBuses/{messageBus}`
   * or the `{messageBus}` segment.
   */
  destination: string;
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
   * Platform logging configuration.
   */
  loggingConfig?: LoggingConfig;
  /**
   * Subscribe to events from every project in the organization.
   */
  organizationSubscription?: OrganizationSubscription;
  /**
   * Subscribe to events from an explicit list of projects in the same
   * organization.
   */
  projectSubscriptions?: ProjectSubscriptions;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Free-form annotations.
   */
  annotations?: Record<string, string>;
};

export type GoogleApiSource = Resource<
  "GCP.Eventarc.GoogleApiSource",
  GoogleApiSourceProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/googleApiSources/{googleApiSource}`. */
    name: string;
    /** Google API source id (last path segment). */
    googleApiSourceId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Destination MessageBus resource name. */
    destination: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** Customer-managed KMS key, if any. */
    cryptoKeyName: string | undefined;
    /** Platform logging configuration. */
    loggingConfig: LoggingConfig | undefined;
    /** Organization-wide subscription config. */
    organizationSubscription: OrganizationSubscription | undefined;
    /** Explicit project subscription list. */
    projectSubscriptions: ProjectSubscriptions | undefined;
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
 * An Eventarc Advanced GoogleApiSource that delivers first-party Google
 * API events onto a MessageBus. One source is allowed per project per
 * region.
 *
 * `googleApiSourceId` and `location` are identity — changing either
 * replaces the source. Destination, display name, labels, annotations,
 * logging, CMEK, and subscription config update in place.
 *
 * ### Creating a GoogleApiSource
 * **Example:** Collect Google events onto a bus
 * ```typescript
 * const bus = yield* GCP.Eventarc.MessageBus("Events", {
 *   location: "us-central1",
 * });
 * const source = yield* GCP.Eventarc.GoogleApiSource("GoogleEvents", {
 *   location: "us-central1",
 *   destination: bus.name,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a GoogleApiSource
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical source and patches it in place.
 *
 * **Example:** Change labels and display name
 * ```typescript
 * const source = yield* GCP.Eventarc.GoogleApiSource("GoogleEvents", {
 *   location: "us-central1",
 *   destination: bus.name,
 *   displayName: "google events v2",
 *   labels: { env: "prod", role: "source" },
 * });
 * ```
 *
 * @resource
 * @category Eventarc
 */
export const GoogleApiSource = Resource<GoogleApiSource>(
  "GCP.Eventarc.GoogleApiSource",
);

const toProjectSubscriptions = (
  value: ProjectSubscriptions | eventarc.ProjectSubscriptions | undefined,
): ProjectSubscriptions | undefined => {
  const list = [...(value?.list ?? [])].filter((item) => item.length > 0);
  if (list.length === 0) return undefined;
  return { list };
};

const toOrganizationSubscription = (
  value:
    | OrganizationSubscription
    | eventarc.OrganizationSubscription
    | undefined,
): OrganizationSubscription | undefined => {
  if (value === undefined || value.enabled === undefined) return undefined;
  return { enabled: value.enabled };
};

const toAttrs = (
  source: eventarc.GoogleApiSource,
  project: string,
  region: string,
) => {
  const name = source.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    googleApiSourceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    destination: source.destination,
    displayName: source.displayName,
    cryptoKeyName: source.cryptoKeyName,
    loggingConfig: toLoggingConfig(source.loggingConfig),
    organizationSubscription: toOrganizationSubscription(
      source.organizationSubscription,
    ),
    projectSubscriptions: toProjectSubscriptions(source.projectSubscriptions),
    labels: userLabels(source.labels),
    annotations: userAnnotations(source.annotations),
    uid: source.uid,
    etag: source.etag,
    createTime: source.createTime,
    updateTime: source.updateTime,
  };
};

const getByName = (name: string) =>
  eventarc
    .getProjectsLocationsGoogleApiSources({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const GoogleApiSourceProvider = () =>
  Provider.succeed(GoogleApiSource, {
    stables: [
      "name",
      "googleApiSourceId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.googleApiSourceId ?? output?.googleApiSourceId;
      const nextId = news.googleApiSourceId
        ? rfc1035(news.googleApiSourceId, "google-api-source")
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
      const googleApiSourceId = yield* toPhysicalId(
        id,
        olds?.googleApiSourceId,
        output?.googleApiSourceId,
        "google-api-source",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, googleApiSourceId);
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
          eventarc.listProjectsLocationsGoogleApiSources.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.googleApiSources,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const googleApiSourceId = yield* toPhysicalId(
        id,
        news.googleApiSourceId,
        output?.googleApiSourceId,
        "google-api-source",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        googleApiSourceId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const destination = expandResource(
        news.destination,
        env.project,
        location,
        "messageBuses",
      );
      const desiredLogging = toLoggingConfig(news.loggingConfig);
      const desiredCrypto =
        news.cryptoKeyName && news.cryptoKeyName.length > 0
          ? news.cryptoKeyName
          : undefined;
      const desiredAnnotations = news.annotations
        ? tagRecord(news.annotations)
        : undefined;
      const desiredOrg = toOrganizationSubscription(
        news.organizationSubscription,
      );
      const desiredProjects = toProjectSubscriptions(news.projectSubscriptions);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* eventarc
          .createProjectsLocationsGoogleApiSources({
            parent: parentOf(env.project, location),
            googleApiSourceId,
            body: compact({
              name,
              destination,
              displayName: news.displayName,
              cryptoKeyName: desiredCrypto,
              loggingConfig: desiredLogging,
              organizationSubscription: desiredOrg,
              projectSubscriptions: desiredProjects,
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
          "organizationSubscription",
          !sameJson(
            toOrganizationSubscription(current.organizationSubscription),
            desiredOrg,
          ),
        ],
        [
          "projectSubscriptions",
          !sameJson(
            toProjectSubscriptions(current.projectSubscriptions),
            desiredProjects,
          ),
        ],
        [
          "annotations",
          !sameJson(tagRecord(current.annotations), desiredAnnotations ?? {}),
        ],
      ]);

      if (updateMask.length > 0) {
        const patched = yield* eventarc.patchProjectsLocationsGoogleApiSources({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            name: current.name ?? name,
            destination,
            displayName: news.displayName,
            cryptoKeyName: desiredCrypto,
            loggingConfig: desiredLogging,
            organizationSubscription: desiredOrg,
            projectSubscriptions: desiredProjects,
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
            .deleteProjectsLocationsGoogleApiSources({
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
