import * as monitoring from "@distilled.cloud/gcp/monitoring_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
import {
  compactStringMap,
  jsonEqual,
  lastSegment,
  parentOf,
  toEmptyObject,
} from "./ownership.ts";

const MAX_SERVICE_ID_LENGTH = 63;

export type GkeServiceIdentifier = {
  /** Project that owns the Kubernetes service. */
  projectId?: string;
  /** Parent cluster name. */
  clusterName?: string;
  /** Parent namespace name. */
  namespaceName?: string;
  /** Kubernetes service name. */
  serviceName?: string;
  /** Cluster location (zone or region). */
  location?: string;
};

export type ClusterIstioIdentifier = {
  /** Istio destination service name. */
  serviceName?: string;
  /** Cluster location. */
  location?: string;
  /** Kubernetes cluster name. */
  clusterName?: string;
  /** Istio destination service namespace. */
  serviceNamespace?: string;
};

export type AppEngineIdentifier = {
  /** App Engine module id (`module_id` on `gae_app`). */
  moduleId?: string;
};

export type GkeNamespaceIdentifier = {
  /** Cluster location. */
  location?: string;
  /** Parent cluster name. */
  clusterName?: string;
  /** Project that owns the namespace. */
  projectId?: string;
  /** Namespace name. */
  namespaceName?: string;
};

export type BasicServiceIdentifier = {
  /**
   * Well-known service type (`APP_ENGINE`, `CLOUD_RUN`,
   * `ISTIO_CANONICAL_SERVICE`, …).
   */
  serviceType?: string;
  /** Labels identifying the telemetry resource. */
  serviceLabels?: Record<string, string>;
};

export type MeshIstioIdentifier = {
  /** Istio destination service name. */
  serviceName?: string;
  /** Istio destination service namespace. */
  serviceNamespace?: string;
  /** Mesh uid (`mesh_uid` metric label). */
  meshUid?: string;
};

export type IstioCanonicalServiceIdentifier = {
  /** Canonical service namespace. */
  canonicalServiceNamespace?: string;
  /** Canonical service name. */
  canonicalService?: string;
  /** Mesh uid. */
  meshUid?: string;
};

export type CloudRunIdentifier = {
  /** Cloud Run service name. */
  serviceName?: string;
  /** Region the service runs in. */
  location?: string;
};

export type GkeWorkloadIdentifier = {
  /** Cluster location. */
  location?: string;
  /** Workload kind (`Deployment`, `DaemonSet`, …). */
  topLevelControllerType?: string;
  /** Parent namespace name. */
  namespaceName?: string;
  /** Parent cluster name. */
  clusterName?: string;
  /** Project that owns the workload. */
  projectId?: string;
  /** Workload name. */
  topLevelControllerName?: string;
};

export type CloudEndpointsIdentifier = {
  /** Cloud Endpoints service name. */
  service?: string;
};

export type ServiceTelemetry = {
  /** Full resource name of the telemetry source. */
  resourceName?: string;
};

export type ServiceProps = {
  /**
   * Service id (the `{service}` segment of
   * `projects/{project}/services/{service}`). If omitted, a unique id
   * is generated from the stack, stage, and logical id. Must match
   * `[a-z0-9-]`. Immutable — changing it replaces the service.
   */
  serviceId?: string;
  /**
   * Human-readable display name. If omitted, the service id is used.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Custom service identifier. Used when no other identifier is set.
   */
  custom?: Record<string, never>;
  /**
   * Well-known basic service type and labels.
   */
  basicService?: BasicServiceIdentifier;
  /** App Engine module identifier. */
  appEngine?: AppEngineIdentifier;
  /** Cloud Run identifier. */
  cloudRun?: CloudRunIdentifier;
  /** Cloud Endpoints identifier. */
  cloudEndpoints?: CloudEndpointsIdentifier;
  /** GKE Service identifier. */
  gkeService?: GkeServiceIdentifier;
  /** GKE Namespace identifier. */
  gkeNamespace?: GkeNamespaceIdentifier;
  /** GKE Workload identifier. */
  gkeWorkload?: GkeWorkloadIdentifier;
  /** Cluster-scoped Istio identifier. */
  clusterIstio?: ClusterIstioIdentifier;
  /** Mesh-scoped Istio identifier. */
  meshIstio?: MeshIstioIdentifier;
  /** Canonical Istio service identifier. */
  istioCanonicalService?: IstioCanonicalServiceIdentifier;
  /**
   * Telemetry resource to query for this service.
   */
  telemetry?: ServiceTelemetry;
};

export type Service = Resource<
  "GCP.Monitoring.Service",
  ServiceProps,
  {
    /** Full resource name `projects/{project}/services/{service}`. */
    name: string;
    /** Service id (last path segment). */
    serviceId: string;
    /** Project id. */
    project: string;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Custom identifier, if this is a custom service. */
    custom: Record<string, never> | undefined;
    /** Well-known basic service identifier, if set. */
    basicService: BasicServiceIdentifier | undefined;
    /** App Engine identifier, if set. */
    appEngine: AppEngineIdentifier | undefined;
    /** Cloud Run identifier, if set. */
    cloudRun: CloudRunIdentifier | undefined;
    /** Cloud Endpoints identifier, if set. */
    cloudEndpoints: CloudEndpointsIdentifier | undefined;
    /** GKE Service identifier, if set. */
    gkeService: GkeServiceIdentifier | undefined;
    /** GKE Namespace identifier, if set. */
    gkeNamespace: GkeNamespaceIdentifier | undefined;
    /** GKE Workload identifier, if set. */
    gkeWorkload: GkeWorkloadIdentifier | undefined;
    /** Cluster-scoped Istio identifier, if set. */
    clusterIstio: ClusterIstioIdentifier | undefined;
    /** Mesh-scoped Istio identifier, if set. */
    meshIstio: MeshIstioIdentifier | undefined;
    /** Canonical Istio identifier, if set. */
    istioCanonicalService: IstioCanonicalServiceIdentifier | undefined;
    /** Telemetry resource, if set. */
    telemetry: ServiceTelemetry | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Monitoring service — the root resource for SLO monitoring.
 *
 * Custom services (`custom: {}`) are the default when no other
 * identifier is set. Alchemy stamps ownership into `userLabels` so
 * `list` / `pnpm nuke:gcp` can find them. Changing `serviceId` or the
 * identifier kind replaces the service. Display name, labels, and
 * telemetry update in place.
 *
 * ### Creating a Service
 * **Example:** Generated custom service
 * ```typescript
 * const checkout = yield* GCP.Monitoring.Service("Checkout", {
 *   displayName: "Checkout",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const checkout = yield* GCP.Monitoring.Service("Checkout", {
 *   serviceId: "checkout",
 *   displayName: "Checkout API",
 * });
 * ```
 *
 * ### Updating a Service
 * **Example:** Rename and relabel
 * ```typescript
 * const checkout = yield* GCP.Monitoring.Service("Checkout", {
 *   displayName: "Checkout v2",
 *   labels: { env: "prod", team: "payments" },
 * });
 * ```
 *
 * @resource
 * @category Monitoring
 */
export const Service = Resource<Service>("GCP.Monitoring.Service");

export class ServiceNotResolved extends Data.TaggedError(
  "GCP.Monitoring.ServiceNotResolved",
)<{
  name: string;
}> {}

export type IdentifierKind =
  | "custom"
  | "basicService"
  | "appEngine"
  | "cloudRun"
  | "cloudEndpoints"
  | "gkeService"
  | "gkeNamespace"
  | "gkeWorkload"
  | "clusterIstio"
  | "meshIstio"
  | "istioCanonicalService";

const IDENTIFIER_KINDS = [
  "basicService",
  "appEngine",
  "cloudRun",
  "cloudEndpoints",
  "gkeService",
  "gkeNamespace",
  "gkeWorkload",
  "clusterIstio",
  "meshIstio",
  "istioCanonicalService",
  "custom",
] as const satisfies readonly IdentifierKind[];

const identifierKindOf = (value: {
  basicService?: unknown;
  appEngine?: unknown;
  cloudRun?: unknown;
  cloudEndpoints?: unknown;
  gkeService?: unknown;
  gkeNamespace?: unknown;
  gkeWorkload?: unknown;
  clusterIstio?: unknown;
  meshIstio?: unknown;
  istioCanonicalService?: unknown;
  custom?: unknown;
}): IdentifierKind => {
  for (const kind of IDENTIFIER_KINDS) {
    if (value[kind] !== undefined) return kind;
  }
  return "custom";
};

const resourceName = (project: string, serviceId: string) =>
  `${parentOf(project)}/services/${serviceId}`;

const userFacingLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, serviceId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (serviceId !== undefined) return serviceId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_SERVICE_ID_LENGTH,
      lowercase: true,
    });
    return generated.replace(/-+$/g, "").slice(0, MAX_SERVICE_ID_LENGTH);
  });

const toBasicService = (
  value: monitoring.BasicService | undefined,
): BasicServiceIdentifier | undefined => {
  if (value === undefined) return undefined;
  return {
    serviceType: value.serviceType,
    serviceLabels: compactStringMap(value.serviceLabels),
  };
};

const toAttrs = (service: monitoring.Service, project: string) => {
  const name = service.name ?? "";
  return {
    name,
    serviceId: lastSegment(name),
    project,
    displayName: service.displayName,
    labels: userFacingLabels(service.userLabels),
    custom: toEmptyObject(service.custom),
    basicService: toBasicService(service.basicService),
    appEngine: service.appEngine,
    cloudRun: service.cloudRun,
    cloudEndpoints: service.cloudEndpoints,
    gkeService: service.gkeService,
    gkeNamespace: service.gkeNamespace,
    gkeWorkload: service.gkeWorkload,
    clusterIstio: service.clusterIstio,
    meshIstio: service.meshIstio,
    istioCanonicalService: service.istioCanonicalService,
    telemetry: service.telemetry,
  };
};

const identifierBody = (
  news: ServiceProps,
): Pick<
  monitoring.Service,
  | "custom"
  | "basicService"
  | "appEngine"
  | "cloudRun"
  | "cloudEndpoints"
  | "gkeService"
  | "gkeNamespace"
  | "gkeWorkload"
  | "clusterIstio"
  | "meshIstio"
  | "istioCanonicalService"
> => {
  switch (identifierKindOf(news)) {
    case "basicService":
      return { basicService: news.basicService };
    case "appEngine":
      return { appEngine: news.appEngine };
    case "cloudRun":
      return { cloudRun: news.cloudRun };
    case "cloudEndpoints":
      return { cloudEndpoints: news.cloudEndpoints };
    case "gkeService":
      return { gkeService: news.gkeService };
    case "gkeNamespace":
      return { gkeNamespace: news.gkeNamespace };
    case "gkeWorkload":
      return { gkeWorkload: news.gkeWorkload };
    case "clusterIstio":
      return { clusterIstio: news.clusterIstio };
    case "meshIstio":
      return { meshIstio: news.meshIstio };
    case "istioCanonicalService":
      return { istioCanonicalService: news.istioCanonicalService };
    default:
      return { custom: news.custom ?? {} };
  }
};

const getByName = (name: string) =>
  monitoring
    .getServices({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listPages = (project: string) =>
  monitoring.listServices
    .pages({
      parent: parentOf(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.services ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const listOwned = (project: string) =>
  Effect.gen(function* () {
    const services = yield* listPages(project);
    return services
      .filter((service) =>
        Object.keys(service.userLabels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      )
      .map((service) => toAttrs(service, project));
  });

const findOwned = (project: string, id: string) =>
  Effect.gen(function* () {
    const services = yield* listPages(project);
    for (const service of services) {
      if (yield* hasAlchemyLabels(id, tagRecord(service.userLabels))) {
        return service;
      }
    }
    return undefined;
  });

const observe = (project: string, id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name !== undefined) {
      const existing = yield* getByName(name);
      if (existing !== undefined) return existing;
    }
    return yield* findOwned(project, id);
  });

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: ["name", "serviceId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.serviceId ?? output?.serviceId;
      const idChanged =
        news.serviceId !== undefined &&
        previousId !== undefined &&
        news.serviceId !== previousId;
      const previousKind = identifierKindOf({
        basicService: olds?.basicService ?? output?.basicService,
        appEngine: olds?.appEngine ?? output?.appEngine,
        cloudRun: olds?.cloudRun ?? output?.cloudRun,
        cloudEndpoints: olds?.cloudEndpoints ?? output?.cloudEndpoints,
        gkeService: olds?.gkeService ?? output?.gkeService,
        gkeNamespace: olds?.gkeNamespace ?? output?.gkeNamespace,
        gkeWorkload: olds?.gkeWorkload ?? output?.gkeWorkload,
        clusterIstio: olds?.clusterIstio ?? output?.clusterIstio,
        meshIstio: olds?.meshIstio ?? output?.meshIstio,
        istioCanonicalService:
          olds?.istioCanonicalService ?? output?.istioCanonicalService,
        custom: olds?.custom ?? output?.custom ?? {},
      });
      const nextKind = identifierKindOf(news);
      const kindChanged = previousKind !== nextKind;
      if (!idChanged && !kindChanged) return undefined;
      return {
        action: "replace" as const,
        deleteFirst: !idChanged,
      };
    }),

    read: Effect.fn(function* ({ id, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* observe(env.project, id, output?.name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.userLabels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceId = yield* toId(id, news.serviceId, output?.serviceId);
      const name = resourceName(env.project, serviceId);
      const displayName = news.displayName ?? serviceId;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* observe(env.project, id, output?.name ?? name);

      const body: monitoring.Service = {
        ...identifierBody(news),
        displayName,
        userLabels: desiredLabels,
        telemetry: news.telemetry,
      };

      if (current === undefined) {
        const created = yield* monitoring
          .createServices({
            parent: parentOf(env.project),
            serviceId,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByName(name).pipe(
                Effect.flatMap((existing) =>
                  existing !== undefined
                    ? Effect.succeed(existing)
                    : findOwned(env.project, id),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ServiceNotResolved({ name });
      }

      const resource = current.name ?? name;
      const observedLabels = tagRecord(current.userLabels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const telemetryChanged =
        news.telemetry !== undefined &&
        !jsonEqual(current.telemetry ?? null, news.telemetry);

      const updateMask = [
        displayNameChanged ? "display_name" : undefined,
        labelsChanged ? "user_labels" : undefined,
        telemetryChanged ? "telemetry" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* monitoring.patchServices({
          name: resource,
          updateMask: updateMask.join(","),
          body: {
            ...body,
            name: resource,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* monitoring
        .deleteServices({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
