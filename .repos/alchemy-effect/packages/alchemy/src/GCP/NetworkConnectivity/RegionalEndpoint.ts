import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
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
  NetworkConnectivityNotResolved,
  canonicalizeLink,
  collectPages,
  hasAlchemyLabelKeys,
  lastSegment,
  normalizeLocation,
  parentOf,
  parseName,
  rfc1035,
  toNetworkResource,
  toPhysicalId,
  toSubnetworkResource,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "regionalEndpoints";
const MAX_ID_LENGTH = 46;

export type RegionalEndpointAccessType =
  | networkconnectivity.RegionalEndpointAccessTypeEnum
  | (string & {});

export type RegionalEndpointProps = {
  /**
   * RegionalEndpoint id (the `{regional_endpoint}` segment of
   * `projects/{project}/locations/{location}/regionalEndpoints/{regional_endpoint}`).
   * If omitted, a unique name is generated. Must match
   * `[-a-z0-9]([-a-z0-9]{0,44})[a-z0-9]`. Immutable — changing it
   * replaces the endpoint.
   */
  regionalEndpointId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * endpoint. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Service endpoint this private regional endpoint connects to, e.g.
   * `"storage.us-central1.p.rep.googleapis.com"`. Immutable — changing
   * it replaces the endpoint.
   */
  targetGoogleApi: string;
  /**
   * Access type reflected on the PSC forwarding rule (`REGIONAL` or
   * `GLOBAL`). Immutable — changing it replaces the endpoint.
   */
  accessType: RegionalEndpointAccessType;
  /**
   * VPC network
   * (`projects/{project}/global/networks/{network}` or a Compute
   * self-link). Immutable — changing it replaces the endpoint.
   */
  network?: string;
  /**
   * Subnetwork used to allocate the IP
   * (`projects/{project}/regions/{region}/subnetworks/{subnetwork}` or a
   * Compute self-link). Immutable — changing it replaces the endpoint.
   */
  subnetwork?: string;
  /**
   * IP address or Address resource URI. When omitted, an IP is allocated
   * from `subnetwork`. Immutable — changing it replaces the endpoint.
   */
  address?: string;
  /**
   * Human-readable description. Set at create; the API has no update.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type RegionalEndpoint = Resource<
  "GCP.NetworkConnectivity.RegionalEndpoint",
  RegionalEndpointProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/regionalEndpoints/{regional_endpoint}`. */
    name: string;
    /** RegionalEndpoint id (last path segment). */
    regionalEndpointId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Target Google API hostname. */
    targetGoogleApi: string | undefined;
    /** Access type (`REGIONAL` or `GLOBAL`). */
    accessType: string | undefined;
    /** VPC network resource path. */
    network: string | undefined;
    /** Subnetwork resource path. */
    subnetwork: string | undefined;
    /** Allocated address or Address resource URI. */
    address: string | undefined;
    /** Literal IP of the PSC forwarding rule (deprecated; prefer `address`). */
    ipAddress: string | undefined;
    /** PSC forwarding rule created on behalf of the customer. */
    pscForwardingRule: string | undefined;
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
 * A Private Service Connect regional endpoint for a Google API.
 *
 * Identity fields (`regionalEndpointId`, `location`, `targetGoogleApi`,
 * `accessType`, `network`, `subnetwork`, `address`) replace the
 * endpoint. The API has no patch method.
 *
 * ### Creating a RegionalEndpoint
 * **Example:** Regional access to Cloud Storage
 * ```typescript
 * const network = yield* GCP.Compute.Network("AppVpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const subnet = yield* GCP.Compute.Subnetwork("AppSubnet", {
 *   network: network.selfLink ?? network.networkName,
 *   ipCidrRange: "10.20.0.0/24",
 *   privateIpGoogleAccess: true,
 * });
 * const endpoint = yield* GCP.NetworkConnectivity.RegionalEndpoint("Storage", {
 *   targetGoogleApi: "storage.us-central1.p.rep.googleapis.com",
 *   accessType: "REGIONAL",
 *   network: network.selfLink ?? network.networkName,
 *   subnetwork: subnet.selfLink ?? subnet.subnetworkName,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const RegionalEndpoint = Resource<RegionalEndpoint>(
  "GCP.NetworkConnectivity.RegionalEndpoint",
);

const resourceName = (
  project: string,
  location: string,
  regionalEndpointId: string,
) =>
  `projects/${project}/locations/${location}/regionalEndpoints/${regionalEndpointId}`;

const identityKey = (props: {
  targetGoogleApi?: string;
  accessType?: string;
  network?: string;
  subnetwork?: string;
  address?: string;
}) =>
  JSON.stringify({
    targetGoogleApi: (props.targetGoogleApi ?? "").toLowerCase(),
    accessType: (props.accessType ?? "").toUpperCase(),
    network: lastSegment(canonicalizeLink(props.network)),
    subnetwork: lastSegment(canonicalizeLink(props.subnetwork)),
    address: canonicalizeLink(props.address),
  });

const toAttrs = (
  endpoint: networkconnectivity.RegionalEndpoint,
  project: string,
  region: string,
) => {
  const name = endpoint.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    regionalEndpointId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    targetGoogleApi: endpoint.targetGoogleApi,
    accessType: endpoint.accessType,
    network: endpoint.network,
    subnetwork: endpoint.subnetwork,
    address: endpoint.address,
    ipAddress: endpoint.ipAddress,
    pscForwardingRule: endpoint.pscForwardingRule,
    description: endpoint.description,
    labels: userLabels(endpoint.labels),
    createTime: endpoint.createTime,
    updateTime: endpoint.updateTime,
  };
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsRegionalEndpoints({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const RegionalEndpointProvider = () =>
  Provider.succeed(RegionalEndpoint, {
    stables: [
      "name",
      "regionalEndpointId",
      "project",
      "location",
      "targetGoogleApi",
      "accessType",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.regionalEndpointId ?? output?.regionalEndpointId;
      const nextId = news.regionalEndpointId
        ? rfc1035(news.regionalEndpointId, "regional-endpoint", MAX_ID_LENGTH)
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousKey = identityKey({
        targetGoogleApi: olds?.targetGoogleApi ?? output?.targetGoogleApi,
        accessType: olds?.accessType ?? output?.accessType,
        network: olds?.network ?? output?.network,
        subnetwork: olds?.subnetwork ?? output?.subnetwork,
        address: olds?.address ?? output?.address,
      });
      const nextKey = identityKey({
        targetGoogleApi: news.targetGoogleApi,
        accessType: news.accessType,
        network: news.network,
        subnetwork: news.subnetwork,
        address: news.address,
      });
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousKey !== nextKey
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const regionalEndpointId = yield* toPhysicalId(
        id,
        olds?.regionalEndpointId,
        output?.regionalEndpointId,
        "regional-endpoint",
        MAX_ID_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, regionalEndpointId);
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
        const items = yield* collectPages(
          networkconnectivity.listProjectsLocationsRegionalEndpoints.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.regionalEndpoints,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const regionalEndpointId = yield* toPhysicalId(
        id,
        news.regionalEndpointId,
        output?.regionalEndpointId,
        "regional-endpoint",
        MAX_ID_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, regionalEndpointId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const network =
        news.network !== undefined
          ? toNetworkResource(env.project, news.network)
          : undefined;
      const subnetwork =
        news.subnetwork !== undefined
          ? toSubnetworkResource(env.project, location, news.subnetwork)
          : undefined;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsRegionalEndpoints({
            parent: parentOf(env.project, location),
            regionalEndpointId,
            body: {
              targetGoogleApi: news.targetGoogleApi,
              accessType: news.accessType,
              network,
              subnetwork,
              address: news.address,
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
        current = yield* waitUntilPresent(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new NetworkConnectivityNotResolved({ name });
      }

      current = yield* getByName(current.name ?? name).pipe(
        Effect.filterOrFail(
          (value): value is networkconnectivity.RegionalEndpoint =>
            value !== undefined &&
            (value.pscForwardingRule !== undefined ||
              value.address !== undefined ||
              value.ipAddress !== undefined),
          () => new NetworkConnectivityNotResolved({ name }),
        ),
        Effect.retry({
          while: (error) =>
            error._tag === "GCP.NetworkConnectivity.NotResolved",
          times: 10,
          schedule: Schedule.spaced("4 seconds"),
        }),
      );

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkconnectivity
        .deleteProjectsLocationsRegionalEndpoints({ name: output.name })
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
