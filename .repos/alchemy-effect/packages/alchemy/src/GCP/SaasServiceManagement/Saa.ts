import * as saasservicemgmt from "@distilled.cloud/gcp/saasservicemgmt_v1";
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
  ResourceNotResolved,
  collectPages,
  fieldMask,
  fingerprint,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  toPhysicalId,
  userAnnotations,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

const COLLECTION = "saas";

export type SaasLocation = {
  /** Location id, e.g. `us-central1`. */
  name?: string;
};

export type SaasCondition = {
  reason: string | undefined;
  status: string | undefined;
  type: string | undefined;
  message: string | undefined;
  lastTransitionTime: string | undefined;
};

export type SaaProps = {
  /**
   * SaaS id (the `{saas}` segment of
   * `projects/{project}/locations/{location}/saas/{saas}`). If omitted, a
   * unique RFC1035 name is generated. Immutable — changing it replaces
   * the SaaS.
   */
  saasId?: string;
  /**
   * Region of the SaaS resource (`us-central1`, …). Immutable —
   * changing it replaces the SaaS. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Locations the product is offered in. Rollouts use this list to
   * build a plan. Defaults to the resource location.
   */
  locations?: SaasLocation[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Unstructured annotations preserved across updates.
   */
  annotations?: Record<string, string>;
};

export type Saa = Resource<
  "GCP.SaasServiceManagement.Saa",
  SaaProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/saas/{saas}`. */
    name: string;
    /** SaaS id (last path segment). */
    saasId: string;
    /** Project id. */
    project: string;
    /** Location id of the resource. */
    location: string;
    /** Locations the product is offered in. */
    locations: SaasLocation[];
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Server-reported state (`STATE_ACTIVE`, …). */
    state: string | undefined;
    /** Server UUID. */
    uid: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** Status conditions. */
    conditions: SaasCondition[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An App Lifecycle Manager SaaS product definition.
 *
 * A SaaS is the producer-side product that Tenants, UnitKinds, and
 * Units hang off. `saasId` and `location` replace the resource.
 * `locations`, labels, and annotations update in place.
 *
 * ### Creating a SaaS
 * **Example:** Generated name
 * ```typescript
 * const product = yield* GCP.SaasServiceManagement.Saa("Inventory", {
 *   locations: [{ name: "us-central1" }],
 * });
 * ```
 *
 * **Example:** Named SaaS with labels
 * ```typescript
 * const product = yield* GCP.SaasServiceManagement.Saa("Inventory", {
 *   saasId: "inventory",
 *   locations: [{ name: "us-central1" }, { name: "europe-west1" }],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a SaaS
 * **Example:** Offer an extra region
 * ```typescript
 * const product = yield* GCP.SaasServiceManagement.Saa("Inventory", {
 *   saasId: "inventory",
 *   locations: [{ name: "us-central1" }, { name: "us-east1" }],
 *   labels: { env: "prod", role: "saas" },
 * });
 * ```
 *
 * @resource
 * @category SaasServiceManagement
 */
export const Saa = Resource<Saa>("GCP.SaasServiceManagement.Saa");

const desiredLocations = (
  news: SaaProps,
  location: string,
): saasservicemgmt.Location[] => {
  const listed = news.locations ?? [{ name: location }];
  return listed.map((item) => ({
    name: item.name ? normalizeLocation(item.name) : location,
  }));
};

const toAttrs = (item: saasservicemgmt.Saas, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    saasId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    locations: (item.locations ?? []).map((entry) => ({ name: entry.name })),
    labels: userLabels(item.labels),
    annotations: userAnnotations(item.annotations),
    state: item.state,
    uid: item.uid,
    etag: item.etag,
    conditions: (item.conditions ?? []).map((condition) => ({
      reason: condition.reason,
      status: condition.status,
      type: condition.type,
      message: condition.message,
      lastTransitionTime: condition.lastTransitionTime,
    })),
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : saasservicemgmt
        .getProjectsLocationsSaas({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, location: string) =>
  collectPages(
    saasservicemgmt.listProjectsLocationsSaas.pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    }),
    (page) => page.saas,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelKeys(item.labels)),
    ),
    Effect.flatMap((items) =>
      items.length > 0
        ? Effect.succeed(items)
        : collectPages(
            saasservicemgmt.listProjectsLocationsSaas.pages({
              parent: parentOf(project, location),
              pageSize: 1000,
            }),
            (page) => page.saas,
          ).pipe(
            Effect.map((fallback) =>
              fallback.filter((item) => hasAlchemyLabelKeys(item.labels)),
            ),
          ),
    ),
  );

export const SaaProvider = () =>
  Provider.succeed(Saa, {
    stables: ["name", "saasId", "project", "location", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.saasId ?? output?.saasId,
        nextId: news.saasId ?? olds?.saasId ?? output?.saasId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const saasId = yield* toPhysicalId(
        id,
        olds?.saasId,
        output?.saasId,
        "saa",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, COLLECTION, saasId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const saasId = yield* toPhysicalId(
        id,
        news.saasId,
        output?.saasId,
        "saa",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, COLLECTION, saasId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const locations = desiredLocations(news, location);
      const annotations = news.annotations;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* saasservicemgmt
          .createProjectsLocationsSaas({
            parent: parentOf(env.project, location),
            saasId,
            body: {
              locations,
              labels: desiredLabels,
              annotations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        // The create response omits server fields such as createTime.
        current = created === undefined ? undefined : yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const locationsChanged =
        news.locations !== undefined &&
        fingerprint(current.locations) !== fingerprint(locations);
      const annotationsChanged =
        annotations !== undefined &&
        fingerprint(userAnnotations(current.annotations)) !==
          fingerprint(annotations);
      const mask = fieldMask([
        labelsChanged && "labels",
        locationsChanged && "locations",
        annotationsChanged && "annotations",
      ]);

      if (mask.length > 0) {
        current = yield* saasservicemgmt.patchProjectsLocationsSaas({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            etag: current.etag,
            locations,
            labels: desiredLabels,
            annotations,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* saasservicemgmt
        .deleteProjectsLocationsSaas({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
