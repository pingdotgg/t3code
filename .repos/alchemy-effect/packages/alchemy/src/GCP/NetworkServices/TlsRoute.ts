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
  toBackendServiceResource,
  toNamedResource,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "tlsRoutes";

export type TlsRouteRouteMatch = {
  /**
   * SNI hosts to match, including wildcards (`*.example.com`). At least
   * one of `sniHost` or `alpn` is required. Up to 100 SNI hosts across
   * all matches.
   */
  sniHost?: string[];
  /**
   * ALPN values to match (`http/1.1`, `h2`). At least one of `sniHost`
   * or `alpn` is required. Up to 5 ALPNs across all matches.
   */
  alpn?: string[];
};

export type TlsRouteRouteDestination = {
  /**
   * BackendService resource name to route to, e.g.
   * `projects/{project}/locations/global/backendServices/{service}`.
   */
  serviceName?: string;
  /**
   * Relative weight of this destination. Weights do not need to sum to
   * 100.
   */
  weight?: number;
};

export type TlsRouteRouteAction = {
  /** Destination services. At least one is required. */
  destinations?: TlsRouteRouteDestination[];
  /**
   * Idle timeout (e.g. `"3600s"`). Default 1 hour; `"0s"` disables it.
   */
  idleTimeout?: string;
};

export type TlsRouteRouteRule = {
  /** Match predicates, OR-ed. At least one match is required. */
  matches?: TlsRouteRouteMatch[];
  /** Routing action applied when a match succeeds. */
  action?: TlsRouteRouteAction;
};

export type TlsRouteProps = {
  /**
   * Route id (the `{tlsRoute}` segment of
   * `projects/{project}/locations/{location}/tlsRoutes/{tlsRoute}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the route.
   */
  tlsRouteId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the route. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description. Max 1024 characters.
   */
  description?: string;
  /**
   * Routing rules evaluated in order. At least one rule is required.
   */
  rules: TlsRouteRouteRule[];
  /**
   * Mesh resource names this route attaches to
   * (`projects/{project}/locations/{location}/meshes/{mesh}`). Attached
   * meshes must be sidecar type.
   */
  meshes?: string[];
  /**
   * Gateway resource names this route attaches to
   * (`projects/{project}/locations/{location}/gateways/{gateway}`).
   */
  gateways?: string[];
  /**
   * TargetTcpProxy resource names this route attaches to
   * (`projects/{project}/locations/{location}/targetTcpProxies/{proxy}`).
   */
  targetProxies?: string[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type TlsRoute = Resource<
  "GCP.NetworkServices.TlsRoute",
  TlsRouteProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/tlsRoutes/{tlsRoute}`. */
    name: string;
    /** Route id (last path segment). */
    tlsRouteId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** Configured routing rules. */
    rules: TlsRouteRouteRule[];
    /** Attached mesh resource names. */
    meshes: string[];
    /** Attached gateway resource names. */
    gateways: string[];
    /** Attached TargetTcpProxy resource names. */
    targetProxies: string[];
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-defined resource URL. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A TlsRoute routes TLS traffic based on SNI and ALPN for a Mesh,
 * Gateway, or TargetTcpProxy.
 *
 * Changing `tlsRouteId` or `location` replaces the route. Description,
 * labels, rules, meshes, gateways, and target proxies update in place.
 *
 * ### Creating a TlsRoute
 * **Example:** SNI-based sidecar route
 * ```typescript
 * const route = yield* GCP.NetworkServices.TlsRoute("Secure", {
 *   meshes: [mesh.name],
 *   rules: [
 *     {
 *       matches: [{ sniHost: ["api.example.com"], alpn: ["h2"] }],
 *       action: {
 *         destinations: [{ serviceName: backend.name, weight: 1 }],
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const TlsRoute = Resource<TlsRoute>("GCP.NetworkServices.TlsRoute");

const toDestination = (
  project: string,
  destination:
    | TlsRouteRouteDestination
    | networkservices.TlsRouteRouteDestination,
): TlsRouteRouteDestination => ({
  serviceName: destination.serviceName
    ? toBackendServiceResource(project, destination.serviceName)
    : undefined,
  weight: destination.weight,
});

const toAction = (
  project: string,
  action: TlsRouteRouteAction | networkservices.TlsRouteRouteAction | undefined,
): TlsRouteRouteAction | undefined => {
  if (action === undefined) return undefined;
  return {
    destinations: (action.destinations ?? []).map((destination) =>
      toDestination(project, destination),
    ),
    idleTimeout: action.idleTimeout,
  };
};

const toRule = (
  project: string,
  rule: TlsRouteRouteRule | networkservices.TlsRouteRouteRule,
): TlsRouteRouteRule => ({
  matches: (rule.matches ?? []).map((match) => ({
    sniHost: [...(match.sniHost ?? [])],
    alpn: [...(match.alpn ?? [])],
  })),
  action: toAction(project, rule.action),
});

const toMeshes = (
  project: string,
  location: string,
  meshes: readonly string[] | undefined,
) =>
  (meshes ?? []).map((mesh) =>
    toNamedResource(project, location, "meshes", mesh),
  );

const toGateways = (
  project: string,
  location: string,
  gateways: readonly string[] | undefined,
) =>
  (gateways ?? []).map((gateway) =>
    toNamedResource(project, location, "gateways", gateway),
  );

const toTargetProxies = (
  project: string,
  location: string,
  proxies: readonly string[] | undefined,
) =>
  (proxies ?? []).map((proxy) =>
    toNamedResource(project, location, "targetTcpProxies", proxy),
  );

const toAttrs = (route: networkservices.TlsRoute, project: string) => {
  const name = route.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  const location = parsed.location || DEFAULT_GLOBAL;
  const proj = parsed.project || project;
  return {
    name,
    tlsRouteId: parsed.id,
    project: proj,
    location,
    description: route.description,
    rules: (route.rules ?? []).map((rule) => toRule(proj, rule)),
    meshes: toMeshes(proj, location, route.meshes),
    gateways: toGateways(proj, location, route.gateways),
    targetProxies: toTargetProxies(proj, location, route.targetProxies),
    labels: userLabels(route.labels),
    selfLink: route.selfLink,
    createTime: route.createTime,
    updateTime: route.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsTlsRoutes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const TlsRouteProvider = () =>
  Provider.succeed(TlsRoute, {
    stables: [
      "name",
      "tlsRouteId",
      "project",
      "location",
      "createTime",
      "selfLink",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.tlsRouteId ?? output?.tlsRouteId;
      const nextId = news.tlsRouteId
        ? rfc1035(news.tlsRouteId, "tls-route")
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
      const tlsRouteId = yield* toPhysicalId(
        id,
        olds?.tlsRouteId,
        output?.tlsRouteId,
        "tls-route",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, tlsRouteId);
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
          networkservices.listProjectsLocationsTlsRoutes.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
            returnPartialSuccess: true,
          }),
          (page) => page.tlsRoutes,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const tlsRouteId = yield* toPhysicalId(
        id,
        news.tlsRouteId,
        output?.tlsRouteId,
        "tls-route",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(env.project, location, COLLECTION, tlsRouteId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredRules = news.rules.map((rule) => toRule(env.project, rule));
      const desiredMeshes = toMeshes(env.project, location, news.meshes);
      const desiredGateways = toGateways(env.project, location, news.gateways);
      const desiredProxies = toTargetProxies(
        env.project,
        location,
        news.targetProxies,
      );

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsTlsRoutes({
            parent: parentOf(env.project, location),
            tlsRouteId,
            body: {
              description: news.description,
              labels: desiredLabels,
              rules: desiredRules,
              meshes: desiredMeshes,
              gateways: desiredGateways,
              targetProxies: desiredProxies,
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

      const observed = toAttrs(current, env.project);
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const updateMask = changedFields([
        ["labels", labelsChanged],
        [
          "description",
          (current.description ?? "") !== (news.description ?? ""),
        ],
        ["rules", !sameJson(observed.rules, desiredRules)],
        ["meshes", !sameStringList(observed.meshes, desiredMeshes)],
        ["gateways", !sameStringList(observed.gateways, desiredGateways)],
        [
          "targetProxies",
          !sameStringList(observed.targetProxies, desiredProxies),
        ],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsTlsRoutes({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              rules: desiredRules,
              meshes: desiredMeshes,
              gateways: desiredGateways,
              targetProxies: desiredProxies,
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
        .deleteProjectsLocationsTlsRoutes({ name: output.name })
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
