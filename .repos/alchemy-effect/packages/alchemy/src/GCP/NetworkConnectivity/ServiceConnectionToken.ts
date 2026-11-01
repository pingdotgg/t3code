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
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "serviceConnectionTokens";

export type ServiceConnectionTokenProps = {
  /**
   * Token id (the `{service_connection_token}` segment). If omitted, a
   * unique name is generated. Immutable — changing it replaces the
   * token.
   */
  serviceConnectionTokenId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * token. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * VPC network associated with this token
   * (`projects/{project}/global/networks/{network}` or a Compute
   * self-link). Immutable — changing it replaces the token.
   */
  network: string;
  /**
   * Human-readable description. Set at create; the API has no update.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ServiceConnectionToken = Resource<
  "GCP.NetworkConnectivity.ServiceConnectionToken",
  ServiceConnectionTokenProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/serviceConnectionTokens/{id}`. */
    name: string;
    /** Token id (last path segment). */
    serviceConnectionTokenId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** VPC network resource path. */
    network: string | undefined;
    /** Automation-generated token value. */
    token: string | undefined;
    /** RFC3339 expiry. */
    expireTime: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server etag. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A PSC Service Connection Token that authenticates a consumer to
 * create connections in a producer Service Connection Map.
 *
 * Changing `serviceConnectionTokenId`, `location`, or `network`
 * replaces the token. The API has no patch method.
 *
 * ### Creating a ServiceConnectionToken
 * **Example:** Token for a consumer VPC
 * ```typescript
 * const network = yield* GCP.Compute.Network("AppVpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const token = yield* GCP.NetworkConnectivity.ServiceConnectionToken(
 *   "Consumer",
 *   {
 *     network: network.selfLink ?? network.networkName,
 *     description: "psc token",
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const ServiceConnectionToken = Resource<ServiceConnectionToken>(
  "GCP.NetworkConnectivity.ServiceConnectionToken",
);

const resourceName = (
  project: string,
  location: string,
  serviceConnectionTokenId: string,
) =>
  `projects/${project}/locations/${location}/serviceConnectionTokens/${serviceConnectionTokenId}`;

const toAttrs = (
  token: networkconnectivity.ServiceConnectionToken,
  project: string,
  region: string,
) => {
  const name = token.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    serviceConnectionTokenId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    network: token.network,
    token: token.token,
    expireTime: token.expireTime,
    description: token.description,
    labels: userLabels(token.labels),
    etag: token.etag,
    createTime: token.createTime,
    updateTime: token.updateTime,
  };
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsServiceConnectionTokens({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ServiceConnectionTokenProvider = () =>
  Provider.succeed(ServiceConnectionToken, {
    stables: [
      "name",
      "serviceConnectionTokenId",
      "project",
      "location",
      "network",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId =
        olds?.serviceConnectionTokenId ?? output?.serviceConnectionTokenId;
      const nextId = news.serviceConnectionTokenId
        ? rfc1035(news.serviceConnectionTokenId, "service-connection-token")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousNetwork = lastSegment(
        canonicalizeLink(olds?.network ?? output?.network),
      );
      const nextNetwork = lastSegment(canonicalizeLink(news.network));
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousNetwork.length > 0 && previousNetwork !== nextNetwork)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceConnectionTokenId = yield* toPhysicalId(
        id,
        olds?.serviceConnectionTokenId,
        output?.serviceConnectionTokenId,
        "service-connection-token",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, serviceConnectionTokenId);
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
          networkconnectivity.listProjectsLocationsServiceConnectionTokens.pages(
            {
              parent: parentOf(env.project, "-"),
              pageSize: 1000,
            },
          ),
          (page) => page.serviceConnectionTokens,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceConnectionTokenId = yield* toPhysicalId(
        id,
        news.serviceConnectionTokenId,
        output?.serviceConnectionTokenId,
        "service-connection-token",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        serviceConnectionTokenId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const network = toNetworkResource(env.project, news.network);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsServiceConnectionTokens({
            parent: parentOf(env.project, location),
            serviceConnectionTokenId,
            body: {
              network,
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

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkconnectivity
        .deleteProjectsLocationsServiceConnectionTokens({
          name: output.name,
          etag: output.etag,
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
