import * as apphub from "@distilled.cloud/gcp/apphub_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  type Attributes,
  type WorkloadProperties,
  type WorkloadReference,
  encodeOwnership,
  expandApplication,
  fieldMask,
  listNestedOwned,
  listOwnedPages,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  resolveDiscoveredWorkload,
  ResourceNotResolved,
  sameJson,
  sameText,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type ApplicationsWorkloadProps = {
  /**
   * Parent Application. Full name
   * `projects/{project}/locations/{location}/applications/{application}`
   * or the application id (combined with `location`). Immutable —
   * changing it replaces the workload.
   */
  application: string;
  /**
   * Region used when `application` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Workload id (the `{workload}` segment). Must be RFC1035 (63 chars).
   * If omitted, a unique name is generated. Immutable — changing it
   * replaces the workload.
   */
  workloadId?: string;
  /**
   * Resource name of the original discovered workload, or the underlying
   * resource URI (looked up via `discoveredWorkloads:lookup`). Immutable
   * — changing it replaces the workload.
   */
  discoveredWorkload: string;
  /**
   * User-defined display name. Maximum length is 63 characters. Defaults
   * to the workload id.
   */
  displayName?: string;
  /**
   * User-defined description. Maximum length is 2048 characters.
   * Workloads have no labels field, so Alchemy stamps ownership into a
   * `[alchemy …]` prefix and strips it from attributes.
   */
  description?: string;
  /**
   * Consumer-provided attributes (criticality, environment, owners).
   */
  attributes?: Attributes;
};

export type ApplicationsWorkload = Resource<
  "GCP.AppHub.ApplicationsWorkload",
  ApplicationsWorkloadProps,
  {
    /** Full resource name. */
    name: string;
    /** Workload id (last path segment). */
    workloadId: string;
    /** Parent Application resource name. */
    application: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Discovered workload resource name. */
    discoveredWorkload: string | undefined;
    /** User-defined display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Consumer-provided attributes. */
    attributes: Attributes | undefined;
    /** Reference to the underlying compute resource. */
    workloadReference: WorkloadReference | undefined;
    /** Properties of the underlying compute resource. */
    workloadProperties: WorkloadProperties | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An App Hub workload registered onto an Application. A workload is a
 * discovered binary deployment (managed instance group, GKE deployment,
 * …) that performs the smallest logical subset of business
 * functionality.
 *
 * Workloads have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Application, workload id, and
 * `discoveredWorkload` are immutable. Display name, description, and
 * attributes update in place.
 *
 * ### Creating a Workload
 * **Example:** Register a discovered workload
 * ```typescript
 * const workload = yield* GCP.AppHub.ApplicationsWorkload("Api", {
 *   application: app.name,
 *   discoveredWorkload: discovered.name,
 * });
 * ```
 *
 * **Example:** Lookup from an underlying resource URI
 * ```typescript
 * const workload = yield* GCP.AppHub.ApplicationsWorkload("Api", {
 *   application: app.name,
 *   discoveredWorkload: instanceGroup.instanceGroup,
 *   displayName: "api",
 *   description: "checkout mig",
 * });
 * ```
 *
 * ### Updating a Workload
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Display name and attributes
 * ```typescript
 * const workload = yield* GCP.AppHub.ApplicationsWorkload("Api", {
 *   application: app.name,
 *   discoveredWorkload: discovered.name,
 *   displayName: "api-v2",
 *   attributes: { criticality: { type: "HIGH" } },
 * });
 * ```
 *
 * @resource
 * @category AppHub
 */
export const ApplicationsWorkload = Resource<ApplicationsWorkload>(
  "GCP.AppHub.ApplicationsWorkload",
);

const resourceName = (application: string, workloadId: string) =>
  `${application}/workloads/${workloadId}`;

const toAttrs = (item: apphub.Workload, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "workloads", region);
  const ownership = parseOwnership(item.description);
  return {
    name,
    workloadId: parsed.id,
    application: parsed.application,
    project: parsed.project || project,
    location: parsed.location,
    discoveredWorkload: item.discoveredWorkload,
    displayName: item.displayName,
    description: ownership.text,
    attributes: item.attributes,
    workloadReference: item.workloadReference,
    workloadProperties: item.workloadProperties,
    state: item.state,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apphub
        .getProjectsLocationsApplicationsWorkloads({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listNestedOwned(project, region, (application) =>
    listOwnedPages(
      apphub.listProjectsLocationsApplicationsWorkloads.pages({
        parent: application,
        pageSize: 1000,
      }),
      (page) => page.workloads,
      (item) => item.description,
    ),
  );

export const ApplicationsWorkloadProvider = () =>
  Provider.succeed(ApplicationsWorkload, {
    stables: [
      "name",
      "workloadId",
      "application",
      "project",
      "location",
      "discoveredWorkload",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousDiscovered =
        olds?.discoveredWorkload ?? output?.discoveredWorkload;
      return replaceOnIdentity({
        previousId: olds?.workloadId ?? output?.workloadId,
        nextId: news.workloadId ?? olds?.workloadId ?? output?.workloadId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.application ?? output?.application,
        nextParent: news.application,
        extra:
          previousDiscovered !== undefined &&
          news.discoveredWorkload !== undefined &&
          previousDiscovered !== news.discoveredWorkload &&
          !previousDiscovered.endsWith(`/${news.discoveredWorkload}`) &&
          !news.discoveredWorkload.endsWith(`/${previousDiscovered}`),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const workloadId = yield* toPhysicalId(
        id,
        olds?.workloadId,
        output?.workloadId,
        "workload",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const application = expandApplication(
        olds?.application ?? output?.application ?? "",
        env.project,
        location,
      );
      const name = output?.name ?? resourceName(application, workloadId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const workloadId = yield* toPhysicalId(
        id,
        news.workloadId,
        output?.workloadId,
        "workload",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const application = expandApplication(
        news.application,
        env.project,
        location,
      );
      const name = resourceName(application, workloadId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? workloadId;
      const discoveredWorkload = yield* resolveDiscoveredWorkload(
        locationParent(env.project, location),
        news.discoveredWorkload,
        env.project,
        location,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apphub
          .createProjectsLocationsApplicationsWorkloads({
            parent: application,
            workloadId,
            body: {
              discoveredWorkload,
              displayName,
              description,
              attributes: news.attributes,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      const mask = fieldMask([
        !sameText(current.description, description) && "description",
        !sameText(current.displayName, displayName) && "displayName",
        news.attributes !== undefined &&
          !sameJson(current.attributes, news.attributes) &&
          "attributes",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* apphub.patchProjectsLocationsApplicationsWorkloads({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              displayName,
              description,
              attributes: news.attributes,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apphub
        .deleteProjectsLocationsApplicationsWorkloads({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
