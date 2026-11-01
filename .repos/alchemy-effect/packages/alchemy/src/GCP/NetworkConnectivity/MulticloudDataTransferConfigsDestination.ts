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
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "destinations";

export type DestinationEndpoint = {
  /** ASN of the remote IP prefix. */
  asn?: string;
  /** Cloud service provider of the remote IP prefix. */
  csp?: string;
  /** Server-reported endpoint state (`VALID`, `INVALID`). */
  state?: string;
  /** RFC3339 last-update timestamp. */
  updateTime?: string;
};

export type DestinationStateTimeline = {
  /** Ordered state/activation entries. */
  states?: Array<{
    state?: string;
    effectiveTime?: string;
  }>;
};

export type MulticloudDataTransferConfigsDestinationProps = {
  /**
   * Parent `MulticloudDataTransferConfig` resource name
   * `projects/{project}/locations/{location}/multicloudDataTransferConfigs/{config}`.
   * Immutable — changing it replaces the destination.
   */
  parent: string;
  /**
   * Destination id (the `{destination}` segment). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the destination.
   */
  destinationId?: string;
  /**
   * IP prefix that represents the remote workload. Immutable — changing
   * it replaces the destination.
   */
  ipPrefix: string;
  /**
   * Endpoints (ASN + CSP) configured for the prefix.
   */
  endpoints: DestinationEndpoint[];
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type MulticloudDataTransferConfigsDestination = Resource<
  "GCP.NetworkConnectivity.MulticloudDataTransferConfigsDestination",
  MulticloudDataTransferConfigsDestinationProps,
  {
    /** Full resource name `.../multicloudDataTransferConfigs/{config}/destinations/{destination}`. */
    name: string;
    /** Destination id (last path segment). */
    destinationId: string;
    /** Parent config resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Config id. */
    multicloudDataTransferConfigId: string;
    /** Remote IP prefix. */
    ipPrefix: string | undefined;
    /** Endpoints currently configured. */
    endpoints: DestinationEndpoint[];
    /** User-provided description. */
    description: string | undefined;
    /** Server-reported state timeline. */
    stateTimeline: DestinationStateTimeline | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Google-generated unique id. */
    uid: string | undefined;
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
 * A Data Transfer Essentials `Destination` — an IP prefix plus ASN/CSP
 * endpoints billed through a `MulticloudDataTransferConfig`.
 *
 * Changing `parent`, `destinationId`, or `ipPrefix` replaces the
 * destination. Description, labels, and `endpoints` update in place.
 *
 * ### Creating a Destination
 * **Example:** Prefix with one endpoint
 * ```typescript
 * const config = yield* GCP.NetworkConnectivity.MulticloudDataTransferConfig(
 *   "Dte",
 *   {},
 * );
 * const destination =
 *   yield* GCP.NetworkConnectivity.MulticloudDataTransferConfigsDestination(
 *     "OnPrem",
 *     {
 *       parent: config.name,
 *       ipPrefix: "203.0.113.0/24",
 *       endpoints: [{ asn: "64512", csp: "aws" }],
 *       labels: { env: "prod" },
 *     },
 *   );
 * ```
 *
 * ### Updating a Destination
 * **Example:** Description, labels, and endpoints
 * ```typescript
 * const destination =
 *   yield* GCP.NetworkConnectivity.MulticloudDataTransferConfigsDestination(
 *     "OnPrem",
 *     {
 *       parent: config.name,
 *       ipPrefix: "203.0.113.0/24",
 *       endpoints: [
 *         { asn: "64512", csp: "aws" },
 *         { asn: "64513", csp: "azure" },
 *       ],
 *       description: "on-prem v2",
 *       labels: { env: "prod", role: "dte" },
 *     },
 *   );
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const MulticloudDataTransferConfigsDestination =
  Resource<MulticloudDataTransferConfigsDestination>(
    "GCP.NetworkConnectivity.MulticloudDataTransferConfigsDestination",
  );

const resourceNameOf = (parent: string, destinationId: string) =>
  `${parent}/destinations/${destinationId}`;

const toEndpoint = (
  endpoint: DestinationEndpoint | networkconnectivity.DestinationEndpoint,
): DestinationEndpoint => ({
  asn: endpoint.asn,
  csp: endpoint.csp,
  state: endpoint.state,
  updateTime: endpoint.updateTime,
});

const desiredEndpoints = (endpoints: DestinationEndpoint[]) =>
  endpoints.map((endpoint) => ({
    asn: endpoint.asn,
    csp: endpoint.csp,
  }));

const endpointsKey = (endpoints: readonly DestinationEndpoint[] | undefined) =>
  JSON.stringify(
    [...(endpoints ?? [])]
      .map((endpoint) => ({
        asn: endpoint.asn ?? "",
        csp: (endpoint.csp ?? "").toLowerCase(),
      }))
      .sort((left, right) =>
        left.asn === right.asn
          ? left.csp.localeCompare(right.csp)
          : left.asn.localeCompare(right.asn),
      ),
  );

const configIdOf = (parent: string) => lastSegment(parent);

const toAttrs = (
  destination: networkconnectivity.Destination,
  project: string,
  region: string,
) => {
  const name = destination.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const parent = parentOfName(name, COLLECTION);
  return {
    name,
    destinationId: parsed.id,
    parent,
    project: parsed.project || project,
    location: parsed.location || region,
    multicloudDataTransferConfigId: configIdOf(parent),
    ipPrefix: destination.ipPrefix,
    endpoints: (destination.endpoints ?? []).map(toEndpoint),
    description: destination.description,
    stateTimeline: destination.stateTimeline
      ? {
          states: (destination.stateTimeline.states ?? []).map((entry) => ({
            state: entry.state,
            effectiveTime: entry.effectiveTime,
          })),
        }
      : undefined,
    labels: userLabels(destination.labels),
    uid: destination.uid,
    etag: destination.etag,
    createTime: destination.createTime,
    updateTime: destination.updateTime,
  };
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsMulticloudDataTransferConfigsDestinations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const MulticloudDataTransferConfigsDestinationProvider = () =>
  Provider.succeed(MulticloudDataTransferConfigsDestination, {
    stables: [
      "name",
      "destinationId",
      "parent",
      "project",
      "location",
      "multicloudDataTransferConfigId",
      "ipPrefix",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.destinationId ?? output?.destinationId;
      const nextId = news.destinationId
        ? rfc1035(news.destinationId, "destination")
        : previousId;
      const previousParent = olds?.parent ?? output?.parent;
      const previousPrefix = olds?.ipPrefix ?? output?.ipPrefix;
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousParent !== undefined && previousParent !== news.parent) ||
        (previousPrefix !== undefined && previousPrefix !== news.ipPrefix)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const destinationId = yield* toPhysicalId(
        id,
        olds?.destinationId,
        output?.destinationId,
        "destination",
      );
      const parent = olds?.parent ?? output?.parent;
      const name =
        output?.name ??
        (parent !== undefined
          ? resourceNameOf(parent, destinationId)
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
        const configs = yield* collectPages(
          networkconnectivity.listProjectsLocationsMulticloudDataTransferConfigs.pages(
            {
              parent: `projects/${env.project}/locations/-`,
              pageSize: 1000,
              returnPartialSuccess: true,
            },
          ),
          (page) => page.multicloudDataTransferConfigs,
        );
        const nested = yield* Effect.forEach(
          configs.filter((config) => config.name),
          (config) =>
            collectPages(
              networkconnectivity.listProjectsLocationsMulticloudDataTransferConfigsDestinations.pages(
                {
                  parent: config.name!,
                  pageSize: 1000,
                  returnPartialSuccess: true,
                },
              ),
              (page) => page.destinations,
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
      const destinationId = yield* toPhysicalId(
        id,
        news.destinationId,
        output?.destinationId,
        "destination",
      );
      const name = resourceNameOf(news.parent, destinationId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const endpoints = desiredEndpoints(news.endpoints);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsMulticloudDataTransferConfigsDestinations({
            parent: news.parent,
            destinationId,
            body: {
              ipPrefix: news.ipPrefix,
              endpoints,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const endpointsChanged =
        endpointsKey((current.endpoints ?? []).map(toEndpoint)) !==
        endpointsKey(news.endpoints);
      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["endpoints", endpointsChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkconnectivity.patchProjectsLocationsMulticloudDataTransferConfigsDestinations(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
                description: news.description,
                endpoints,
                etag: current.etag,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkconnectivity
        .deleteProjectsLocationsMulticloudDataTransferConfigsDestinations({
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
