import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
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
  DEFAULT_GLOBAL,
  canonicalizeLink,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  linkKey,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "serviceBindings";

export type ServiceBindingProps = {
  /**
   * Binding id (the `{serviceBinding}` segment of
   * `projects/{project}/locations/{location}/serviceBindings/{serviceBinding}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the binding.
   */
  serviceBindingId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the binding. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description. Max 1024 characters.
   */
  description?: string;
  /**
   * Service Directory service resource name
   * `projects/{project}/locations/{location}/namespaces/{namespace}/services/{service}`.
   * This field is for the deprecated Service Directory integration.
   * Immutable — changing it replaces the binding.
   */
  service?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ServiceBinding = Resource<
  "GCP.NetworkServices.ServiceBinding",
  ServiceBindingProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/serviceBindings/{serviceBinding}`. */
    name: string;
    /** Binding id (last path segment). */
    serviceBindingId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** Bound Service Directory service name, if set. */
    service: string | undefined;
    /** UUID of the validated Service Directory service, if populated. */
    serviceId: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A ServiceBinding attaches a producer service (Service Directory, PSC,
 * or Cloud Run) so Cloud Service Mesh or an Application Load Balancer
 * can send traffic to it.
 *
 * Changing `serviceBindingId`, `location`, or `service` replaces the
 * binding. Description and labels update in place.
 *
 * ### Creating a ServiceBinding
 * **Example:** Named binding
 * ```typescript
 * const binding = yield* GCP.NetworkServices.ServiceBinding("Api", {
 *   location: "global",
 *   description: "prod api",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const ServiceBinding = Resource<ServiceBinding>(
  "GCP.NetworkServices.ServiceBinding",
);

const toService = (service: string | undefined) => {
  const trimmed = canonicalizeLink(service);
  return trimmed.length > 0 ? trimmed : undefined;
};

const toAttrs = (binding: networkservices.ServiceBinding, project: string) => {
  const name = binding.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    serviceBindingId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    description: binding.description,
    service: toService(binding.service),
    serviceId: binding.serviceId,
    labels: userLabels(binding.labels),
    createTime: binding.createTime,
    updateTime: binding.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsServiceBindings({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ServiceBindingProvider = () =>
  Provider.succeed(ServiceBinding, {
    stables: [
      "name",
      "serviceBindingId",
      "project",
      "location",
      "service",
      "serviceId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.serviceBindingId ?? output?.serviceBindingId;
      const nextId = news.serviceBindingId
        ? rfc1035(news.serviceBindingId, "service-binding")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const previousService = linkKey(olds?.service ?? output?.service);
      const nextService = linkKey(news.service);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousService.length > 0 &&
          nextService.length > 0 &&
          previousService !== nextService)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceBindingId = yield* toPhysicalId(
        id,
        olds?.serviceBindingId,
        output?.serviceBindingId,
        "service-binding",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, serviceBindingId);
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
        const items = yield* collectPages(
          networkservices.listProjectsLocationsServiceBindings.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.serviceBindings,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceBindingId = yield* toPhysicalId(
        id,
        news.serviceBindingId,
        output?.serviceBindingId,
        "service-binding",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        serviceBindingId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const service = toService(news.service);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsServiceBindings({
            parent: parentOf(env.project, location),
            serviceBindingId,
            body: {
              description: news.description,
              labels: desiredLabels,
              service,
            },
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
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const updateMask = changedFields([
        ["labels", labelsChanged],
        [
          "description",
          (current.description ?? "") !== (news.description ?? ""),
        ],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsServiceBindings({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkservices
        .deleteProjectsLocationsServiceBindings({ name: output.name })
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
