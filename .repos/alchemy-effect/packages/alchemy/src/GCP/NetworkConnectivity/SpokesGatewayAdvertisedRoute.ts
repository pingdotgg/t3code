import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
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
  NetworkConnectivityNotResolved,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  lastSegment,
  parentOfName,
  parseName,
  rfc1035,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "gatewayAdvertisedRoutes";
const DEFAULT_PRIORITY = 100;

export type GatewayAdvertisedRouteRecipient =
  | networkconnectivity.GatewayAdvertisedRouteRecipientEnum
  | (string & {});

export type SpokesGatewayAdvertisedRouteProps = {
  /**
   * Parent gateway spoke resource name
   * `projects/{project}/locations/{location}/spokes/{spoke}`. Immutable —
   * changing it replaces the route.
   */
  parent: string;
  /**
   * Route id (the `{gateway_advertised_route}` segment). If omitted, a
   * unique name is generated. Immutable — changing it replaces the
   * route.
   */
  gatewayAdvertisedRouteId?: string;
  /**
   * Advertised CIDR (`"10.0.0.0/24"` or a single IP, interpreted as
   * `/32` or `/128`). Immutable — changing it replaces the route.
   */
  ipRange: string;
  /**
   * Priority from `0` to `65335`. Defaults to `100`.
   * @default 100
   */
  priority?: number;
  /**
   * Recipient of this advertised route.
   */
  recipient?: GatewayAdvertisedRouteRecipient;
  /**
   * Human-readable description. Immutable — changing it replaces the
   * route (GCP rejects `description` in PATCH).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Immutable — changing them replaces the route.
   */
  labels?: Record<string, string>;
};

export type SpokesGatewayAdvertisedRoute = Resource<
  "GCP.NetworkConnectivity.SpokesGatewayAdvertisedRoute",
  SpokesGatewayAdvertisedRouteProps,
  {
    /** Full resource name `.../spokes/{spoke}/gatewayAdvertisedRoutes/{id}`. */
    name: string;
    /** Route id (last path segment). */
    gatewayAdvertisedRouteId: string;
    /** Parent gateway spoke resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Spoke id. */
    spokeId: string;
    /** Advertised CIDR. */
    ipRange: string | undefined;
    /** Advertised-route priority. */
    priority: number | undefined;
    /** Recipient of this advertised route. */
    recipient: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-generated UUID. */
    uniqueId: string | undefined;
    /** Server-reported lifecycle state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A route a Network Connectivity Center gateway spoke advertises to a
 * hub (or other recipient).
 *
 * Changing `parent`, `gatewayAdvertisedRouteId`, `ipRange`, `labels`, or
 * `description` replaces the route (GCP does not allow updating labels or
 * the description). `priority` and `recipient` update in place.
 *
 * ### Creating a GatewayAdvertisedRoute
 * **Example:** Advertise a CIDR to the hub
 * ```typescript
 * const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {});
 * const spoke = yield* GCP.NetworkConnectivity.Spoke("Gw", {
 *   location: "us-central1",
 *   hub: hub.name,
 *   gateway: {
 *     capacity: "CAPACITY_1_GBPS",
 *     ipRangeReservations: [{ ipRange: "10.200.0.0/23" }],
 *   },
 * });
 * const route = yield* GCP.NetworkConnectivity.SpokesGatewayAdvertisedRoute(
 *   "OnPrem",
 *   {
 *     parent: spoke.name,
 *     ipRange: "192.168.0.0/16",
 *     recipient: "ADVERTISE_TO_HUB",
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * ### Updating a GatewayAdvertisedRoute
 * **Example:** Description and priority
 * ```typescript
 * const route = yield* GCP.NetworkConnectivity.SpokesGatewayAdvertisedRoute(
 *   "OnPrem",
 *   {
 *     parent: spoke.name,
 *     ipRange: "192.168.0.0/16",
 *     priority: 200,
 *     recipient: "ADVERTISE_TO_HUB",
 *     description: "on-prem v2",
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const SpokesGatewayAdvertisedRoute =
  Resource<SpokesGatewayAdvertisedRoute>(
    "GCP.NetworkConnectivity.SpokesGatewayAdvertisedRoute",
  );

const resourceNameOf = (parent: string, gatewayAdvertisedRouteId: string) =>
  `${parent}/gatewayAdvertisedRoutes/${gatewayAdvertisedRouteId}`;

const toAttrs = (
  route: networkconnectivity.GatewayAdvertisedRoute,
  project: string,
  region: string,
) => {
  const name = route.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const parent = parentOfName(name, COLLECTION);
  return {
    name,
    gatewayAdvertisedRouteId: parsed.id,
    parent,
    project: parsed.project || project,
    location: parsed.location || region,
    spokeId: lastSegment(parent),
    ipRange: route.ipRange,
    priority: route.priority,
    recipient: route.recipient,
    description: route.description,
    labels: userLabels(route.labels),
    uniqueId: route.uniqueId,
    state: route.state,
    createTime: route.createTime,
    updateTime: route.updateTime,
  };
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsSpokesGatewayAdvertisedRoutes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const SpokesGatewayAdvertisedRouteProvider = () =>
  Provider.succeed(SpokesGatewayAdvertisedRoute, {
    stables: [
      "name",
      "gatewayAdvertisedRouteId",
      "parent",
      "project",
      "location",
      "spokeId",
      "ipRange",
      "uniqueId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.gatewayAdvertisedRouteId ?? output?.gatewayAdvertisedRouteId;
      const nextId = news.gatewayAdvertisedRouteId
        ? rfc1035(news.gatewayAdvertisedRouteId, "gateway-advertised-route")
        : previousId;
      const previousParent = olds?.parent ?? output?.parent;
      const previousRange = olds?.ipRange ?? output?.ipRange;
      const previousLabels = olds?.labels ?? output?.labels;
      const previousDescription = olds?.description ?? output?.description;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;
      const parentChanged =
        previousParent !== undefined && previousParent !== news.parent;
      const rangeChanged =
        previousRange !== undefined && previousRange !== news.ipRange;
      // `labels` is not mutable on GatewayAdvertisedRoute (PATCH rejects the
      // path), so a labels change replaces the route.
      const labels = diffLabels(
        toLabels(previousLabels),
        toLabels(news.labels),
      );
      const labelsChanged =
        previousLabels !== undefined &&
        (labels.upsert.length > 0 || labels.removed.length > 0);
      // `description` is not mutable either.
      const descriptionChanged =
        (olds !== undefined || output !== undefined) &&
        (previousDescription ?? "") !== (news.description ?? "");
      if (
        idChanged ||
        parentChanged ||
        rangeChanged ||
        labelsChanged ||
        descriptionChanged
      ) {
        return {
          action: "replace" as const,
          // A route with a pinned id, or the same CIDR on the same spoke,
          // collides with the old route; delete it first.
          deleteFirst:
            !parentChanged &&
            (!rangeChanged ||
              (news.gatewayAdvertisedRouteId !== undefined && !idChanged)),
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const gatewayAdvertisedRouteId = yield* toPhysicalId(
        id,
        olds?.gatewayAdvertisedRouteId,
        output?.gatewayAdvertisedRouteId,
        "gateway-advertised-route",
      );
      const parent = olds?.parent ?? output?.parent;
      const name =
        output?.name ??
        (parent !== undefined
          ? resourceNameOf(parent, gatewayAdvertisedRouteId)
          : undefined);
      if (name === undefined) return undefined;
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
        const spokes = yield* collectPages(
          networkconnectivity.listProjectsLocationsSpokes.pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          }),
          (page) => page.spokes,
        );
        const nested = yield* Effect.forEach(
          spokes.filter((spoke) => spoke.name),
          (spoke) =>
            collectPages(
              networkconnectivity.listProjectsLocationsSpokesGatewayAdvertisedRoutes.pages(
                {
                  parent: spoke.name!,
                  pageSize: 1000,
                },
              ),
              (page) => page.gatewayAdvertisedRoutes,
            ),
          { concurrency: 4 },
        );
        return nested
          .flat()
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const gatewayAdvertisedRouteId = yield* toPhysicalId(
        id,
        news.gatewayAdvertisedRouteId,
        output?.gatewayAdvertisedRouteId,
        "gateway-advertised-route",
      );
      const name = resourceNameOf(news.parent, gatewayAdvertisedRouteId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const priority = news.priority ?? DEFAULT_PRIORITY;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsSpokesGatewayAdvertisedRoutes({
            parent: news.parent,
            gatewayAdvertisedRouteId,
            body: {
              ipRange: news.ipRange,
              priority,
              recipient: news.recipient,
              description: news.description,
              labels: desiredLabels,
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
        current = yield* waitUntilReady(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new NetworkConnectivityNotResolved({ name });
      }

      // Labels and description are create-only; `diff` replaces the route
      // when they change.
      const priorityChanged =
        (current.priority ?? DEFAULT_PRIORITY) !== priority;
      const recipientChanged =
        (current.recipient ?? "") !== (news.recipient ?? "");
      const updateMask = changedFields([
        ["priority", priorityChanged],
        ["recipient", recipientChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkconnectivity.patchProjectsLocationsSpokesGatewayAdvertisedRoutes(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                description: news.description,
                priority,
                recipient: news.recipient,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkconnectivity
        .deleteProjectsLocationsSpokesGatewayAdvertisedRoutes({
          name: output.name,
        })
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
