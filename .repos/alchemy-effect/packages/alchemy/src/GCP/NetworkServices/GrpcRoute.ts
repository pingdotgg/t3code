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
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameJson,
  sameStringList,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "grpcRoutes";

export type GrpcRouteMethodMatch = {
  /** How to match the method name. Defaults to `EXACT`. */
  type?: string;
  /** gRPC service name. Omitted matches every service. */
  grpcService?: string;
  /** gRPC method name. Omitted matches every method. */
  grpcMethod?: string;
  /**
   * Case-sensitive matching. Defaults to true. Must not be set with
   * `REGULAR_EXPRESSION`.
   */
  caseSensitive?: boolean;
};

export type GrpcRouteHeaderMatch = {
  /** How to match the header value. Defaults to `EXACT`. */
  type?: string;
  /** Header key. */
  key?: string;
  /** Header value. */
  value?: string;
};

export type GrpcRouteRouteMatch = {
  /** gRPC method matcher. Omitted matches every method. */
  method?: GrpcRouteMethodMatch;
  /** Header matchers. */
  headers?: GrpcRouteHeaderMatch[];
};

export type GrpcRouteDestination = {
  /** BackendService or Service Directory service URL. */
  serviceName?: string;
  /** Traffic weight relative to other destinations. */
  weight?: number;
};

export type GrpcRouteFaultInjectionDelay = {
  /** Fixed delay before forwarding (duration string). */
  fixedDelay?: string;
  /** Percentage of traffic delayed, 0-100. */
  percentage?: number;
};

export type GrpcRouteFaultInjectionAbort = {
  /** HTTP status used to abort, 200-599. */
  httpStatus?: number;
  /** Percentage of traffic aborted, 0-100. */
  percentage?: number;
};

export type GrpcRouteFaultInjectionPolicy = {
  /** Delay injection. */
  delay?: GrpcRouteFaultInjectionDelay;
  /** Abort injection. */
  abort?: GrpcRouteFaultInjectionAbort;
};

export type GrpcRouteRetryPolicy = {
  /**
   * Conditions that trigger a retry (`connect-failure`, `unavailable`,
   * `cancelled`, …).
   */
  retryConditions?: string[];
  /** Allowed retry count. Defaults to 1. */
  numRetries?: number;
};

export type GrpcRouteStatefulSessionAffinityPolicy = {
  /** Cookie TTL for the `GSSA` session cookie (`0s` is a session cookie). */
  cookieTtl?: string;
};

export type GrpcRouteRouteAction = {
  /** Destinations that receive matched traffic. */
  destinations?: GrpcRouteDestination[];
  /** Fault injection. */
  faultInjectionPolicy?: GrpcRouteFaultInjectionPolicy;
  /** End-to-end timeout including retries. */
  timeout?: string;
  /** Retry policy. */
  retryPolicy?: GrpcRouteRetryPolicy;
  /** Cookie-based session affinity. */
  statefulSessionAffinity?: GrpcRouteStatefulSessionAffinityPolicy;
  /** Idle timeout. `0s` disables it. */
  idleTimeout?: string;
};

export type GrpcRouteRouteRule = {
  /**
   * Matchers. The rule matches if any matcher matches. Omitted matches
   * every request.
   */
  matches?: GrpcRouteRouteMatch[];
  /** How to route matched traffic. */
  action?: GrpcRouteRouteAction;
};

export type GrpcRouteProps = {
  /**
   * GrpcRoute id (the `{grpcRoute}` segment of
   * `projects/{project}/locations/{location}/grpcRoutes/{grpcRoute}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and not start with a number.
   * Immutable — changing it replaces the route.
   */
  grpcRouteId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the route. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Service hostnames (with optional port) this route matches, e.g.
   * `foo.example.com` or `*.example.com`.
   */
  hostnames: string[];
  /**
   * Routing rules. The first matching rule is executed. At least one
   * rule is required.
   */
  rules: GrpcRouteRouteRule[];
  /**
   * Mesh resource names this route attaches to
   * (`projects/{project}/locations/{location}/meshes/{mesh}`).
   */
  meshes?: string[];
  /**
   * Gateway resource names this route attaches to
   * (`projects/{project}/locations/{location}/gateways/{gateway}`).
   */
  gateways?: string[];
  /**
   * Human-readable description. Max length 1024 characters.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type GrpcRoute = Resource<
  "GCP.NetworkServices.GrpcRoute",
  GrpcRouteProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/grpcRoutes/{grpcRoute}`. */
    name: string;
    /** GrpcRoute id (last path segment). */
    grpcRouteId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** Server-defined resource URL. */
    selfLink: string | undefined;
    /** Hostnames this route matches. */
    hostnames: string[];
    /** Routing rules. */
    rules: GrpcRouteRouteRule[];
    /** Attached Mesh resource names. */
    meshes: string[];
    /** Attached Gateway resource names. */
    gateways: string[];
    /** User-provided description. */
    description: string | undefined;
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
 * A Network Services GrpcRoute — how a Mesh or Gateway routes gRPC
 * traffic for a set of hostnames.
 *
 * Changing `grpcRouteId` or `location` replaces the route. Hostnames,
 * rules, mesh/gateway attachments, description, and labels update in
 * place.
 *
 * ### Creating a GrpcRoute
 * **Example:** Hostname with a retry policy
 * ```typescript
 * const route = yield* GCP.NetworkServices.GrpcRoute("Api", {
 *   hostnames: ["api.example.com"],
 *   rules: [
 *     {
 *       action: {
 *         retryPolicy: { retryConditions: ["unavailable"], numRetries: 2 },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Attach to a gateway
 * ```typescript
 * const route = yield* GCP.NetworkServices.GrpcRoute("Api", {
 *   grpcRouteId: "app-grpc",
 *   hostnames: ["api.example.com"],
 *   gateways: [gateway.name],
 *   labels: { env: "prod" },
 *   rules: [
 *     {
 *       matches: [{ method: { grpcService: "api.v1.Orders", grpcMethod: "Get" } }],
 *       action: { destinations: [{ serviceName: backend.selfLink }] },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const GrpcRoute = Resource<GrpcRoute>("GCP.NetworkServices.GrpcRoute");

const toMethod = (
  value:
    | GrpcRouteMethodMatch
    | networkservices.GrpcRouteMethodMatch
    | undefined,
): GrpcRouteMethodMatch | undefined => {
  if (value === undefined) return undefined;
  return {
    type: value.type,
    grpcService: value.grpcService,
    grpcMethod: value.grpcMethod,
    caseSensitive: value.caseSensitive,
  };
};

const toHeader = (
  value: GrpcRouteHeaderMatch | networkservices.GrpcRouteHeaderMatch,
): GrpcRouteHeaderMatch => ({
  type: value.type,
  key: value.key,
  value: value.value,
});

const toMatch = (
  value: GrpcRouteRouteMatch | networkservices.GrpcRouteRouteMatch,
): GrpcRouteRouteMatch => ({
  method: toMethod(value.method),
  headers: (value.headers ?? []).map(toHeader),
});

const toDestination = (
  value: GrpcRouteDestination | networkservices.GrpcRouteDestination,
): GrpcRouteDestination => ({
  serviceName: value.serviceName,
  weight: value.weight,
});

const toFault = (
  value:
    | GrpcRouteFaultInjectionPolicy
    | networkservices.GrpcRouteFaultInjectionPolicy
    | undefined,
): GrpcRouteFaultInjectionPolicy | undefined => {
  if (value === undefined) return undefined;
  return {
    delay: value.delay
      ? {
          fixedDelay: value.delay.fixedDelay,
          percentage: value.delay.percentage,
        }
      : undefined,
    abort: value.abort
      ? {
          httpStatus: value.abort.httpStatus,
          percentage: value.abort.percentage,
        }
      : undefined,
  };
};

const toRetry = (
  value:
    | GrpcRouteRetryPolicy
    | networkservices.GrpcRouteRetryPolicy
    | undefined,
): GrpcRouteRetryPolicy | undefined => {
  if (value === undefined) return undefined;
  return {
    retryConditions: value.retryConditions ?? [],
    numRetries: value.numRetries,
  };
};

const toAffinity = (
  value:
    | GrpcRouteStatefulSessionAffinityPolicy
    | networkservices.GrpcRouteStatefulSessionAffinityPolicy
    | undefined,
): GrpcRouteStatefulSessionAffinityPolicy | undefined => {
  if (value === undefined) return undefined;
  return { cookieTtl: value.cookieTtl };
};

const toAction = (
  value:
    | GrpcRouteRouteAction
    | networkservices.GrpcRouteRouteAction
    | undefined,
): GrpcRouteRouteAction | undefined => {
  if (value === undefined) return undefined;
  return {
    destinations: (value.destinations ?? []).map(toDestination),
    faultInjectionPolicy: toFault(value.faultInjectionPolicy),
    timeout: value.timeout,
    retryPolicy: toRetry(value.retryPolicy),
    statefulSessionAffinity: toAffinity(value.statefulSessionAffinity),
    idleTimeout: value.idleTimeout,
  };
};

const toRule = (
  value: GrpcRouteRouteRule | networkservices.GrpcRouteRouteRule,
): GrpcRouteRouteRule => ({
  matches: (value.matches ?? []).map(toMatch),
  action: toAction(value.action),
});

const toAttrs = (route: networkservices.GrpcRoute, project: string) => {
  const name = route.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    grpcRouteId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    selfLink: route.selfLink,
    hostnames: route.hostnames ?? [],
    rules: (route.rules ?? []).map(toRule),
    meshes: route.meshes ?? [],
    gateways: route.gateways ?? [],
    description: route.description,
    labels: userLabels(route.labels),
    createTime: route.createTime,
    updateTime: route.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsGrpcRoutes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const GrpcRouteProvider = () =>
  Provider.succeed(GrpcRoute, {
    stables: [
      "name",
      "grpcRouteId",
      "project",
      "location",
      "selfLink",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.grpcRouteId ?? output?.grpcRouteId;
      const nextId = news.grpcRouteId
        ? rfc1035(news.grpcRouteId, "grpc-route")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
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
      const grpcRouteId = yield* toPhysicalId(
        id,
        olds?.grpcRouteId,
        output?.grpcRouteId,
        "grpc-route",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, grpcRouteId);
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
          networkservices.listProjectsLocationsGrpcRoutes.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
            returnPartialSuccess: true,
          }),
          (page) => page.grpcRoutes,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const grpcRouteId = yield* toPhysicalId(
        id,
        news.grpcRouteId,
        output?.grpcRouteId,
        "grpc-route",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(env.project, location, COLLECTION, grpcRouteId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredRules = news.rules.map(toRule);
      const desiredHostnames = news.hostnames;
      const desiredMeshes = news.meshes ?? [];
      const desiredGateways = news.gateways ?? [];

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsGrpcRoutes({
            parent: parentOf(env.project, location),
            grpcRouteId,
            body: {
              labels: desiredLabels,
              description: news.description,
              hostnames: desiredHostnames,
              rules: desiredRules,
              meshes: desiredMeshes,
              gateways: desiredGateways,
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
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const hostnamesChanged = !sameStringList(
        current.hostnames,
        desiredHostnames,
      );
      const rulesChanged = !sameJson(
        (current.rules ?? []).map(toRule),
        desiredRules,
      );
      const meshesChanged = !sameStringList(current.meshes, desiredMeshes);
      const gatewaysChanged = !sameStringList(
        current.gateways,
        desiredGateways,
      );

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["hostnames", hostnamesChanged],
        ["rules", rulesChanged],
        ["meshes", meshesChanged],
        ["gateways", gatewaysChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsGrpcRoutes({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              hostnames: desiredHostnames,
              rules: desiredRules,
              meshes: desiredMeshes,
              gateways: desiredGateways,
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
        .deleteProjectsLocationsGrpcRoutes({ name: output.name })
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
