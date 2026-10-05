import * as dm from "@distilled.cloud/gcp/datamigration_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fingerprint,
  hasAlchemyLabelMap,
  locationParent,
  networkOf,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type PrivateConnectionState =
  | dm.PrivateConnectionStateEnum
  | (string & {});
export type VpcPeeringConfig = dm.VpcPeeringConfig;
export type PscInterfaceConfig = dm.PscInterfaceConfig;
type Status = dm.Status;

export type PrivateConnectionProps = {
  /**
   * Private connection id (the `{privateConnection}` segment of
   * `projects/{project}/locations/{location}/privateConnections/{privateConnection}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the connection.
   */
  privateConnectionId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * connection. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name. The API has no patch method — changing
   * display name replaces the connection.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * The API has no patch method — changing labels replaces the
   * connection.
   */
  labels?: Record<string, string>;
  /**
   * VPC peering configuration. Mutually exclusive with
   * `pscInterfaceConfig`. Immutable — changing it replaces the
   * connection. `vpcName` may be a full resource name or a bare network
   * id.
   */
  vpcPeeringConfig?: {
    vpcName: string;
    subnet: string;
  };
  /**
   * PSC interface configuration. Mutually exclusive with
   * `vpcPeeringConfig`. Immutable — changing it replaces the connection.
   */
  pscInterfaceConfig?: PscInterfaceConfig;
  /**
   * Skip validations on create.
   */
  skipValidation?: boolean;
  /**
   * PSC interface only: resolve the tenant project without creating.
   */
  validateOnly?: boolean;
};

export type PrivateConnection = Resource<
  "GCP.DataMigration.PrivateConnection",
  PrivateConnectionProps,
  {
    /** Full resource name. */
    name: string;
    /** Private connection id (last path segment). */
    privateConnectionId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** VPC peering configuration. */
    vpcPeeringConfig: VpcPeeringConfig | undefined;
    /** PSC interface configuration. */
    pscInterfaceConfig: PscInterfaceConfig | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Failure details when `state` is `FAILED`. */
    error: Status | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Database Migration Service private connection: VPC peering or a PSC
 * interface between DMS and a consumer network.
 *
 * The API has no patch method. `privateConnectionId`, `location`,
 * `vpcPeeringConfig`, `pscInterfaceConfig`, display name, and labels are
 * replacement triggers.
 *
 * ### Creating a Private Connection
 * **Example:** VPC peering
 * ```typescript
 * const network = yield* GCP.Compute.Network("DmsVpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const peering = yield* GCP.DataMigration.PrivateConnection("DmsPeer", {
 *   displayName: "dms-peer",
 *   vpcPeeringConfig: {
 *     vpcName: network.selfLink ?? network.networkName,
 *     subnet: "10.8.0.0/29",
 *   },
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @category DataMigration
 */
export const PrivateConnection = Resource<PrivateConnection>(
  "GCP.DataMigration.PrivateConnection",
);

const resourceName = (
  project: string,
  location: string,
  privateConnectionId: string,
) =>
  `${locationParent(project, location)}/privateConnections/${privateConnectionId}`;

const peeringOf = (
  value:
    | PrivateConnectionProps["vpcPeeringConfig"]
    | VpcPeeringConfig
    | undefined,
  project: string,
) =>
  value?.vpcName === undefined && value?.subnet === undefined
    ? undefined
    : {
        vpcName: value?.vpcName ? networkOf(value.vpcName, project) : undefined,
        subnet: value?.subnet,
      };

const kindOf = (value: {
  vpcPeeringConfig?: unknown;
  pscInterfaceConfig?: unknown;
}) => (value.vpcPeeringConfig ? "vpc" : value.pscInterfaceConfig ? "psc" : "");

const toAttrs = (item: dm.PrivateConnection, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "privateConnections");
  return {
    name,
    privateConnectionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: item.displayName,
    labels: userLabels(item.labels),
    vpcPeeringConfig: item.vpcPeeringConfig,
    pscInterfaceConfig: item.pscInterfaceConfig,
    state: item.state,
    error: item.error,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dm
        .getProjectsLocationsPrivateConnections({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  dm.listProjectsLocationsPrivateConnections
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.privateConnections ?? []),
      ),
      Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        dm.listProjectsLocationsPrivateConnections
          .pages({
            parent: locationParent(project, region),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.privateConnections ?? []),
            ),
            Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as dm.PrivateConnection[]),
            ),
          ),
      ),
    );

export const PrivateConnectionProvider = () =>
  Provider.succeed(PrivateConnection, {
    stables: [
      "name",
      "privateConnectionId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousKind = kindOf({
        vpcPeeringConfig: olds?.vpcPeeringConfig ?? output?.vpcPeeringConfig,
        pscInterfaceConfig:
          olds?.pscInterfaceConfig ?? output?.pscInterfaceConfig,
      });
      const nextKind = kindOf(news) || previousKind;
      const previousPeering = fingerprint(
        olds?.vpcPeeringConfig ?? output?.vpcPeeringConfig,
      );
      const nextPeering = fingerprint(news.vpcPeeringConfig);
      const previousPsc = fingerprint(
        olds?.pscInterfaceConfig ?? output?.pscInterfaceConfig,
      );
      const nextPsc = fingerprint(news.pscInterfaceConfig);
      const previousDisplay = olds?.displayName ?? output?.displayName;
      const nextDisplay = news.displayName ?? previousDisplay;
      const previousLabels = fingerprint(olds?.labels ?? output?.labels);
      const nextLabels = fingerprint(
        news.labels ?? olds?.labels ?? output?.labels,
      );
      return replaceOnIdentity({
        previousId: olds?.privateConnectionId ?? output?.privateConnectionId,
        nextId:
          news.privateConnectionId ??
          olds?.privateConnectionId ??
          output?.privateConnectionId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (olds !== undefined || output !== undefined) &&
          (previousKind !== nextKind ||
            (news.vpcPeeringConfig !== undefined &&
              previousPeering !== nextPeering) ||
            (news.pscInterfaceConfig !== undefined &&
              previousPsc !== nextPsc) ||
            previousDisplay !== nextDisplay ||
            previousLabels !== nextLabels),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const privateConnectionId = yield* toPhysicalId(
        id,
        olds?.privateConnectionId,
        output?.privateConnectionId,
        "pconn",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, privateConnectionId);
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
      const privateConnectionId = yield* toPhysicalId(
        id,
        news.privateConnectionId,
        output?.privateConnectionId,
        "pconn",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, privateConnectionId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? privateConnectionId;
      const vpcPeeringConfig = peeringOf(news.vpcPeeringConfig, env.project);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dm
          .createProjectsLocationsPrivateConnections({
            parent: locationParent(env.project, location),
            privateConnectionId,
            skipValidation: news.skipValidation,
            validateOnly: news.validateOnly,
            body: {
              displayName,
              labels: desiredLabels,
              vpcPeeringConfig,
              pscInterfaceConfig: news.pscInterfaceConfig,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* Effect.gen(function* () {
        const operation = yield* dm
          .deleteProjectsLocationsPrivateConnections({ name: output.name })
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
      }).pipe(
        // Tearing down the VPC peering occasionally ends with a server-side
        // DEADLINE_EXCEEDED ("Operation timed out."); a fresh delete succeeds.
        Effect.retry({
          while: (error) =>
            error._tag === "GCP.OperationFailed" && error.code === 4,
          times: 5,
          schedule: Schedule.spaced("10 seconds"),
        }),
      );
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
