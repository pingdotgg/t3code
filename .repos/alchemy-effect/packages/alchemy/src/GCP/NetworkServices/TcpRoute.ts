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

const COLLECTION = "tcpRoutes";

export type TcpRouteRouteMatch = {
  /**
   * CIDR range to match (IPv4). Prefix length defaults to 32.
   * Examples: `10.0.0.1`, `10.0.0.0/8`, `0.0.0.0/0`.
   */
  address?: string;
  /** Destination port to match. */
  port?: string;
};

export type TcpRouteRouteDestination = {
  /**
   * BackendService resource name to route to, e.g.
   * `projects/{project}/locations/global/backendServices/{service}`.
   */
  serviceName?: string;
  /**
   * Relative weight of this destination. If any destination has a
   * weight, all destinations must.
   */
  weight?: number;
};

export type TcpRouteRouteAction = {
  /**
   * Destination services. At least one is required unless
   * `originalDestination` is true. Mutually exclusive with
   * `originalDestination`.
   */
  destinations?: TcpRouteRouteDestination[];
  /**
   * Use the original connection destination IP and port. Mutually
   * exclusive with `destinations`.
   * @default false
   */
  originalDestination?: boolean;
  /**
   * Idle timeout (e.g. `"30s"`). Default 30s; `"0s"` disables it.
   */
  idleTimeout?: string;
};

export type TcpRouteRouteRule = {
  /**
   * Match predicates, OR-ed. An empty list matches all traffic.
   */
  matches?: TcpRouteRouteMatch[];
  /** Routing action applied when a match succeeds. */
  action?: TcpRouteRouteAction;
};

export type TcpRouteProps = {
  /**
   * Route id (the `{tcpRoute}` segment of
   * `projects/{project}/locations/{location}/tcpRoutes/{tcpRoute}`). If
   * omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the route.
   */
  tcpRouteId?: string;
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
  rules: TcpRouteRouteRule[];
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
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type TcpRoute = Resource<
  "GCP.NetworkServices.TcpRoute",
  TcpRouteProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/tcpRoutes/{tcpRoute}`. */
    name: string;
    /** Route id (last path segment). */
    tcpRouteId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** Configured routing rules. */
    rules: TcpRouteRouteRule[];
    /** Attached mesh resource names. */
    meshes: string[];
    /** Attached gateway resource names. */
    gateways: string[];
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
 * A TcpRoute describes how a Mesh or Gateway routes TCP traffic.
 *
 * Changing `tcpRouteId` or `location` replaces the route. Description,
 * labels, rules, meshes, and gateways update in place.
 *
 * ### Creating a TcpRoute
 * **Example:** Original-destination sidecar route
 * ```typescript
 * const route = yield* GCP.NetworkServices.TcpRoute("Passthrough", {
 *   meshes: [mesh.name],
 *   rules: [
 *     {
 *       matches: [{ address: "0.0.0.0/0", port: "443" }],
 *       action: { originalDestination: true },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Weighted backend destinations
 * ```typescript
 * const route = yield* GCP.NetworkServices.TcpRoute("Split", {
 *   meshes: [mesh.name],
 *   rules: [
 *     {
 *       action: {
 *         destinations: [
 *           { serviceName: backend.name, weight: 80 },
 *           { serviceName: canary.name, weight: 20 },
 *         ],
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const TcpRoute = Resource<TcpRoute>("GCP.NetworkServices.TcpRoute");

const toDestination = (
  project: string,
  destination:
    | TcpRouteRouteDestination
    | networkservices.TcpRouteRouteDestination,
): TcpRouteRouteDestination => ({
  serviceName: destination.serviceName
    ? toBackendServiceResource(project, destination.serviceName)
    : undefined,
  weight: destination.weight,
});

const toAction = (
  project: string,
  action: TcpRouteRouteAction | networkservices.TcpRouteRouteAction | undefined,
): TcpRouteRouteAction | undefined => {
  if (action === undefined) return undefined;
  return {
    destinations: (action.destinations ?? []).map((destination) =>
      toDestination(project, destination),
    ),
    originalDestination: action.originalDestination,
    idleTimeout: action.idleTimeout,
  };
};

const toRule = (
  project: string,
  rule: TcpRouteRouteRule | networkservices.TcpRouteRouteRule,
): TcpRouteRouteRule => ({
  matches: (rule.matches ?? []).map((match) => ({
    address: match.address,
    port: match.port,
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

const toAttrs = (route: networkservices.TcpRoute, project: string) => {
  const name = route.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  const location = parsed.location || DEFAULT_GLOBAL;
  const proj = parsed.project || project;
  return {
    name,
    tcpRouteId: parsed.id,
    project: proj,
    location,
    description: route.description,
    rules: (route.rules ?? []).map((rule) => toRule(proj, rule)),
    meshes: toMeshes(proj, location, route.meshes),
    gateways: toGateways(proj, location, route.gateways),
    labels: userLabels(route.labels),
    selfLink: route.selfLink,
    createTime: route.createTime,
    updateTime: route.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsTcpRoutes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const TcpRouteProvider = () =>
  Provider.succeed(TcpRoute, {
    stables: [
      "name",
      "tcpRouteId",
      "project",
      "location",
      "createTime",
      "selfLink",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.tcpRouteId ?? output?.tcpRouteId;
      const nextId = news.tcpRouteId
        ? rfc1035(news.tcpRouteId, "tcp-route")
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
      const tcpRouteId = yield* toPhysicalId(
        id,
        olds?.tcpRouteId,
        output?.tcpRouteId,
        "tcp-route",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, tcpRouteId);
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
          networkservices.listProjectsLocationsTcpRoutes.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
            returnPartialSuccess: true,
          }),
          (page) => page.tcpRoutes,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const tcpRouteId = yield* toPhysicalId(
        id,
        news.tcpRouteId,
        output?.tcpRouteId,
        "tcp-route",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(env.project, location, COLLECTION, tcpRouteId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredRules = news.rules.map((rule) => toRule(env.project, rule));
      const desiredMeshes = toMeshes(env.project, location, news.meshes);
      const desiredGateways = toGateways(env.project, location, news.gateways);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsTcpRoutes({
            parent: parentOf(env.project, location),
            tcpRouteId,
            body: {
              description: news.description,
              labels: desiredLabels,
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
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsTcpRoutes({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
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
        .deleteProjectsLocationsTcpRoutes({ name: output.name })
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
