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
  expandName,
  fieldMask,
  fingerprint,
  hasAlchemyLabelKeys,
  lastSegment,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameRef,
  toPhysicalId,
  userAnnotations,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

const COLLECTION = "tenants";

export type TenantProps = {
  /**
   * Tenant id (the `{tenant}` segment of
   * `projects/{project}/locations/{location}/tenants/{tenant}`). If
   * omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the tenant.
   */
  tenantId?: string;
  /**
   * Region of the tenant (`us-central1`, …). Immutable — changing it
   * replaces the tenant. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * SaaS this tenant belongs to. Accepts a SaaS id or a full resource
   * name. Immutable — changing it replaces the tenant.
   */
  saas: string;
  /**
   * Consumer resource this tenant represents, e.g. a Cloud resource
   * handed to the customer. Immutable — changing it replaces the
   * tenant.
   */
  consumerResource?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Unstructured annotations preserved across updates.
   */
  annotations?: Record<string, string>;
};

export type Tenant = Resource<
  "GCP.SaasServiceManagement.Tenant",
  TenantProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/tenants/{tenant}`. */
    name: string;
    /** Tenant id (last path segment). */
    tenantId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** SaaS resource name. */
    saas: string | undefined;
    /** SaaS id (last path segment). */
    saasId: string | undefined;
    /** Consumer resource this tenant represents. */
    consumerResource: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Server UUID. */
    uid: string | undefined;
    /** Server etag. */
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
 * An App Lifecycle Manager tenant — the producer-side instance of a
 * SaaS created for one consumer.
 *
 * `tenantId`, `location`, `saas`, and `consumerResource` replace the
 * tenant. Labels and annotations update in place.
 *
 * ### Creating a Tenant
 * **Example:** Tenant of a SaaS
 * ```typescript
 * const product = yield* GCP.SaasServiceManagement.Saa("Inventory", {
 *   locations: [{ name: "us-central1" }],
 * });
 * const tenant = yield* GCP.SaasServiceManagement.Tenant("Acme", {
 *   saas: product.name,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Tenant
 * **Example:** Relabel
 * ```typescript
 * const tenant = yield* GCP.SaasServiceManagement.Tenant("Acme", {
 *   tenantId: "acme",
 *   saas: product.name,
 *   labels: { env: "prod", customer: "acme" },
 * });
 * ```
 *
 * @resource
 * @category SaasServiceManagement
 */
export const Tenant = Resource<Tenant>("GCP.SaasServiceManagement.Tenant");

const toAttrs = (item: saasservicemgmt.Tenant, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    tenantId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    saas: item.saas,
    saasId: item.saas ? lastSegment(item.saas) : undefined,
    consumerResource: item.consumerResource,
    labels: userLabels(item.labels),
    annotations: userAnnotations(item.annotations),
    uid: item.uid,
    etag: item.etag,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : saasservicemgmt
        .getProjectsLocationsTenants({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, location: string) =>
  collectPages(
    saasservicemgmt.listProjectsLocationsTenants.pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    }),
    (page) => page.tenants,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelKeys(item.labels)),
    ),
    Effect.flatMap((items) =>
      items.length > 0
        ? Effect.succeed(items)
        : collectPages(
            saasservicemgmt.listProjectsLocationsTenants.pages({
              parent: parentOf(project, location),
              pageSize: 1000,
            }),
            (page) => page.tenants,
          ).pipe(
            Effect.map((fallback) =>
              fallback.filter((item) => hasAlchemyLabelKeys(item.labels)),
            ),
          ),
    ),
  );

export const TenantProvider = () =>
  Provider.succeed(Tenant, {
    stables: [
      "name",
      "tenantId",
      "project",
      "location",
      "saasId",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.tenantId ?? output?.tenantId,
        nextId: news.tenantId ?? olds?.tenantId ?? output?.tenantId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra:
          !sameRef(olds?.saas ?? output?.saas, news.saas) ||
          (olds?.consumerResource ?? output?.consumerResource ?? "") !==
            (news.consumerResource ??
              olds?.consumerResource ??
              output?.consumerResource ??
              ""),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const tenantId = yield* toPhysicalId(
        id,
        olds?.tenantId,
        output?.tenantId,
        "tnt",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, tenantId);
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
      const tenantId = yield* toPhysicalId(
        id,
        news.tenantId,
        output?.tenantId,
        "tnt",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, COLLECTION, tenantId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const saas = expandName(news.saas, env.project, location, "saas");
      const annotations = news.annotations;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* saasservicemgmt
          .createProjectsLocationsTenants({
            parent: parentOf(env.project, location),
            tenantId,
            body: {
              saas,
              consumerResource: news.consumerResource,
              labels: desiredLabels,
              annotations,
            },
          })
          .pipe(
            // A Saas created seconds earlier is unreadable here until it
            // propagates.
            Effect.retry({
              while: (error) => error._tag === "SaasNotFound",
              schedule: Schedule.spaced("2 seconds"),
              times: 15,
            }),
            Effect.catchTag("Conflict", () => getByName(name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const annotationsChanged =
        annotations !== undefined &&
        fingerprint(userAnnotations(current.annotations)) !==
          fingerprint(annotations);
      const mask = fieldMask([
        labelsChanged && "labels",
        annotationsChanged && "annotations",
      ]);

      if (mask.length > 0) {
        current = yield* saasservicemgmt.patchProjectsLocationsTenants({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            etag: current.etag,
            labels: desiredLabels,
            annotations,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* saasservicemgmt
        .deleteProjectsLocationsTenants({ name: output.name })
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
