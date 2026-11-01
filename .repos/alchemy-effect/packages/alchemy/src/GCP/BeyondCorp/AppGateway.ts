import * as beyondcorp from "@distilled.cloud/gcp/beyondcorp_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_GATEWAY_TYPE,
  DEFAULT_HOST_TYPE,
  ResourceNotResolved,
  collectPages,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  rfc1035,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "appGateways";

export type AppGatewayAllocatedConnection = {
  /** PSC URI of an allocated connection. */
  pscUri?: string;
  /** Ingress port of an allocated connection. */
  ingressPort?: number;
};

export type AppGatewayProps = {
  /**
   * AppGateway id (the `{appGateway}` segment of
   * `projects/{project}/locations/{location}/appGateways/{appGateway}`).
   * If omitted, a unique RFC1035 name is generated. Must be 4-63
   * characters matching `[a-z]([a-z0-9-]{0,61}[a-z0-9])?`. Immutable —
   * changing it replaces the gateway.
   */
  appGatewayId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * gateway. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Network connectivity type. Immutable — changing it replaces the
   * gateway.
   * @default "TCP_PROXY"
   */
  type?: beyondcorp.AppGatewayTypeEnum | (string & {});
  /**
   * Hosting type. Immutable — changing it replaces the gateway.
   * @default "GCP_REGIONAL_MIG"
   */
  hostType?: beyondcorp.AppGatewayHostTypeEnum | (string & {});
  /**
   * Human-readable name. Cannot exceed 64 characters. AppGateway has no
   * update API, so this is set at create only.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * AppGateway has no update API, so labels are set at create only.
   */
  labels?: Record<string, string>;
};

export type AppGateway = Resource<
  "GCP.BeyondCorp.AppGateway",
  AppGatewayProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/appGateways/{appGateway}`. */
    name: string;
    /** AppGateway id (last path segment). */
    appGatewayId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Network connectivity type. */
    type: string | undefined;
    /** Hosting type. */
    hostType: string | undefined;
    /** Human-readable name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`CREATED`, `CREATING`, …). */
    state: string | undefined;
    /** Server-defined URI. */
    uri: string | undefined;
    /** Allocated PSC connections. */
    allocatedConnections: AppGatewayAllocatedConnection[];
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
 * A BeyondCorp AppGateway that provisions the GCP components used to
 * reach a remote application.
 *
 * Changing `appGatewayId`, `location`, `type`, or `hostType` replaces
 * the gateway. The API has no patch method — display name and labels
 * are applied at create only.
 *
 * ### Creating an AppGateway
 * **Example:** Generated name
 * ```typescript
 * const gateway = yield* GCP.BeyondCorp.AppGateway("Edge", {});
 * ```
 *
 * **Example:** Explicit id, type, and labels
 * ```typescript
 * const gateway = yield* GCP.BeyondCorp.AppGateway("Edge", {
 *   appGatewayId: "app-edge",
 *   location: "us-central1",
 *   type: "TCP_PROXY",
 *   hostType: "GCP_REGIONAL_MIG",
 *   displayName: "edge gateway",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category BeyondCorp
 */
export const AppGateway = Resource<AppGateway>("GCP.BeyondCorp.AppGateway");

const resourceName = (
  project: string,
  location: string,
  appGatewayId: string,
) => `projects/${project}/locations/${location}/appGateways/${appGatewayId}`;

const toAttrs = (
  item: beyondcorp.AppGateway,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    appGatewayId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    type: item.type === undefined ? undefined : `${item.type}`,
    hostType: item.hostType === undefined ? undefined : `${item.hostType}`,
    displayName: item.displayName,
    labels: userLabels(item.labels),
    state: item.state === undefined ? undefined : `${item.state}`,
    uri: item.uri,
    allocatedConnections: (item.allocatedConnections ?? []).map(
      (connection) => ({
        pscUri: connection.pscUri,
        ingressPort: connection.ingressPort,
      }),
    ),
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  beyondcorp
    .getProjectsLocationsAppGateways({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    collectPages(
      beyondcorp.listProjectsLocationsAppGateways.pages({
        parent,
        pageSize: 1000,
      }),
      (page): readonly beyondcorp.AppGateway[] | undefined => page.appGateways,
    ),
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelMap(item.labels)),
    ),
  );

export const AppGatewayProvider = () =>
  Provider.succeed(AppGateway, {
    stables: [
      "name",
      "appGatewayId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = olds?.type ?? output?.type ?? DEFAULT_GATEWAY_TYPE;
      const nextType = news.type ?? previousType;
      const previousHost =
        olds?.hostType ?? output?.hostType ?? DEFAULT_HOST_TYPE;
      const nextHost = news.hostType ?? previousHost;
      return replaceOnIdentity({
        previousId: olds?.appGatewayId ?? output?.appGatewayId,
        nextId: news.appGatewayId
          ? rfc1035(news.appGatewayId, "appgateway")
          : (olds?.appGatewayId ?? output?.appGatewayId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra: previousType !== nextType || previousHost !== nextHost,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const appGatewayId = yield* toPhysicalId(
        id,
        olds?.appGatewayId,
        output?.appGatewayId,
        "appgateway",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, appGatewayId);
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
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const appGatewayId = yield* toPhysicalId(
        id,
        news.appGatewayId,
        output?.appGatewayId,
        "appgateway",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, appGatewayId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const type = news.type ?? DEFAULT_GATEWAY_TYPE;
      const hostType = news.hostType ?? DEFAULT_HOST_TYPE;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* beyondcorp
          .createProjectsLocationsAppGateways({
            parent: parentOf(env.project, location),
            appGatewayId,
            body: {
              type,
              hostType,
              displayName: news.displayName,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(getByName(name), name, (item) =>
          item.state === undefined ? undefined : `${item.state}`,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* beyondcorp
        .deleteProjectsLocationsAppGateways({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
