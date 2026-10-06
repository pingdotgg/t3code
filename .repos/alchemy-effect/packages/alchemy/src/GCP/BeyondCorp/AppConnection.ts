import * as beyondcorp from "@distilled.cloud/gcp/beyondcorp_v1";
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
  DEFAULT_CONNECTION_TYPE,
  DEFAULT_GATEWAY_KIND,
  ResourceNotResolved,
  collectPages,
  expandName,
  fieldMask,
  fingerprint,
  hasAlchemyLabelMap,
  lastSegment,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  rfc1035,
  sameStringList,
  sameText,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "appConnections";

export type AppConnectionApplicationEndpoint = {
  /** Hostname or IP of the remote application. */
  host?: string;
  /** Port of the remote application. */
  port?: number;
};

export type AppConnectionGateway = {
  /**
   * Hosting type of the gateway.
   * @default "GCP_REGIONAL_MIG"
   */
  type?:
    | beyondcorp.GoogleCloudBeyondcorpAppconnectionsV1AppConnectionGatewayTypeEnum
    | (string & {});
  /**
   * AppGateway resource name
   * (`projects/{project}/locations/{location}/appGateways/{appGateway}`)
   * or gateway id.
   */
  appGateway?: string;
  /** Ingress port reserved on the gateway. Output only. */
  ingressPort?: number;
  /** Server-defined URI. Output only. */
  uri?: string;
  /** L7 private service connection. Output only. */
  l7psc?: string;
};

export type AppConnectionProps = {
  /**
   * AppConnection id (the `{appConnection}` segment of
   * `projects/{project}/locations/{location}/appConnections/{appConnection}`).
   * If omitted, a unique RFC1035 name is generated. Must be 4-63
   * characters matching `[a-z]([a-z0-9-]{0,61}[a-z0-9])?`. Immutable —
   * changing it replaces the connection.
   */
  appConnectionId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * connection. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Network connectivity type. Immutable — changing it replaces the
   * connection.
   * @default "TCP_PROXY"
   */
  type?:
    | beyondcorp.GoogleCloudBeyondcorpAppconnectionsV1AppConnectionTypeEnum
    | (string & {});
  /**
   * Remote application endpoint. Host and port are required.
   */
  applicationEndpoint: AppConnectionApplicationEndpoint;
  /**
   * Gateway used by the connection. The nested `appGateway` is
   * immutable — changing it replaces the connection.
   */
  gateway?: AppConnectionGateway;
  /**
   * AppConnector resource names authorized to associate with this
   * connection.
   */
  connectors?: string[];
  /**
   * Human-readable name. Cannot exceed 64 characters.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type AppConnection = Resource<
  "GCP.BeyondCorp.AppConnection",
  AppConnectionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/appConnections/{appConnection}`. */
    name: string;
    /** AppConnection id (last path segment). */
    appConnectionId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Network connectivity type. */
    type: string | undefined;
    /** Remote application endpoint. */
    applicationEndpoint: AppConnectionApplicationEndpoint | undefined;
    /** Gateway used by the connection. */
    gateway: AppConnectionGateway | undefined;
    /** Authorized AppConnector names. */
    connectors: string[];
    /** Human-readable name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`CREATED`, `CREATING`, …). */
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
 * A BeyondCorp AppConnection that links a remote application endpoint
 * to an AppGateway and optional AppConnectors.
 *
 * Changing `appConnectionId`, `location`, `type`, or
 * `gateway.appGateway` replaces the connection. Display name, labels,
 * application endpoint, and connectors update in place.
 *
 * ### Creating an AppConnection
 * **Example:** TCP proxy through an AppGateway
 * ```typescript
 * const connection = yield* GCP.BeyondCorp.AppConnection("App", {
 *   applicationEndpoint: { host: "10.0.0.4", port: 8080 },
 *   gateway: { appGateway: gateway.name },
 *   connectors: [connector.name],
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const connection = yield* GCP.BeyondCorp.AppConnection("App", {
 *   appConnectionId: "app-tcp",
 *   type: "TCP_PROXY",
 *   applicationEndpoint: { host: "app.internal", port: 443 },
 *   gateway: { appGateway: gateway.name },
 *   displayName: "prod app",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category BeyondCorp
 */
export const AppConnection = Resource<AppConnection>(
  "GCP.BeyondCorp.AppConnection",
);

const resourceName = (
  project: string,
  location: string,
  appConnectionId: string,
) =>
  `projects/${project}/locations/${location}/appConnections/${appConnectionId}`;

const expandConnectors = (
  connectors: readonly string[] | undefined,
  project: string,
  location: string,
) =>
  (connectors ?? []).map((connector) =>
    expandName(connector, project, location, "appConnectors"),
  );

const expandGateway = (
  gateway: AppConnectionGateway | undefined,
  project: string,
  location: string,
): AppConnectionGateway | undefined => {
  if (gateway === undefined) return undefined;
  const appGateway = gateway.appGateway
    ? expandName(gateway.appGateway, project, location, "appGateways")
    : undefined;
  return {
    type: gateway.type ?? DEFAULT_GATEWAY_KIND,
    appGateway,
    ingressPort: gateway.ingressPort,
    uri: gateway.uri,
    l7psc: gateway.l7psc,
  };
};

const toGateway = (
  gateway:
    | beyondcorp.GoogleCloudBeyondcorpAppconnectionsV1AppConnectionGateway
    | undefined,
): AppConnectionGateway | undefined => {
  if (gateway === undefined) return undefined;
  return {
    type: gateway.type === undefined ? undefined : `${gateway.type}`,
    appGateway: gateway.appGateway,
    ingressPort: gateway.ingressPort,
    uri: gateway.uri,
    l7psc: gateway.l7psc,
  };
};

const toAttrs = (
  item: beyondcorp.GoogleCloudBeyondcorpAppconnectionsV1AppConnection,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    appConnectionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    type: item.type === undefined ? undefined : `${item.type}`,
    applicationEndpoint: item.applicationEndpoint
      ? {
          host: item.applicationEndpoint.host,
          port: item.applicationEndpoint.port,
        }
      : undefined,
    gateway: toGateway(item.gateway),
    connectors: item.connectors ? [...item.connectors] : [],
    displayName: item.displayName,
    labels: userLabels(item.labels),
    state: item.state === undefined ? undefined : `${item.state}`,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  beyondcorp
    .getProjectsLocationsAppConnections({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    collectPages(
      beyondcorp.listProjectsLocationsAppConnections.pages({
        parent,
        pageSize: 1000,
      }),
      (
        page,
      ):
        | readonly beyondcorp.GoogleCloudBeyondcorpAppconnectionsV1AppConnection[]
        | undefined => page.appConnections,
    ),
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelMap(item.labels)),
    ),
  );

export const AppConnectionProvider = () =>
  Provider.succeed(AppConnection, {
    stables: [
      "name",
      "appConnectionId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType =
        olds?.type ?? output?.type ?? DEFAULT_CONNECTION_TYPE;
      const nextType = news.type ?? previousType;
      const previousGateway = lastSegment(
        olds?.gateway?.appGateway ?? output?.gateway?.appGateway ?? "",
      );
      const nextGateway = lastSegment(news.gateway?.appGateway ?? "");
      return replaceOnIdentity({
        previousId: olds?.appConnectionId ?? output?.appConnectionId,
        nextId: news.appConnectionId
          ? rfc1035(news.appConnectionId, "appconnection")
          : (olds?.appConnectionId ?? output?.appConnectionId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          previousType !== nextType ||
          (previousGateway.length > 0 &&
            nextGateway.length > 0 &&
            previousGateway !== nextGateway),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const appConnectionId = yield* toPhysicalId(
        id,
        olds?.appConnectionId,
        output?.appConnectionId,
        "appconnection",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, appConnectionId);
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
      const appConnectionId = yield* toPhysicalId(
        id,
        news.appConnectionId,
        output?.appConnectionId,
        "appconnection",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, appConnectionId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const type = news.type ?? DEFAULT_CONNECTION_TYPE;
      const applicationEndpoint = {
        host: news.applicationEndpoint.host,
        port: news.applicationEndpoint.port,
      };
      const gateway = expandGateway(news.gateway, env.project, location);
      const connectors = expandConnectors(
        news.connectors,
        env.project,
        location,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* beyondcorp
          .createProjectsLocationsAppConnections({
            parent: parentOf(env.project, location),
            appConnectionId,
            body: {
              type,
              applicationEndpoint,
              gateway: gateway
                ? {
                    type: gateway.type,
                    appGateway: gateway.appGateway,
                  }
                : undefined,
              connectors,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const endpointChanged =
        fingerprint(current.applicationEndpoint) !==
        fingerprint(applicationEndpoint);
      const connectorsChanged = !sameStringList(current.connectors, connectors);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.displayName, news.displayName) && "display_name",
        endpointChanged && "application_endpoint",
        connectorsChanged && "connectors",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* beyondcorp.patchProjectsLocationsAppConnections({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              displayName: news.displayName,
              labels: desiredLabels,
              applicationEndpoint,
              connectors,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* beyondcorp
        .deleteProjectsLocationsAppConnections({ name: output.name })
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
