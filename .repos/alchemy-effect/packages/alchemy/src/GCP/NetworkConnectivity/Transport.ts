import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./internal.ts";

const MAX_NAME_LENGTH = 63;

export type TransportBandwidth =
  | networkconnectivity.TransportBandwidthEnum
  | (string & {});
export type TransportStackType =
  | networkconnectivity.TransportStackTypeEnum
  | (string & {});
export type TransportState =
  | networkconnectivity.TransportStateEnum
  | (string & {});

export type TransportProps = {
  /**
   * Transport id (the `{transport}` segment of
   * `projects/{project}/locations/{location}/transports/{transport}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-63 characters and match
   * `[a-z]([-a-z0-9]*[a-z0-9])?`. Immutable — changing it replaces the
   * transport.
   */
  transportId?: string;
  /**
   * Region of the transport (e.g. `us-east4`). Remote transport profiles
   * are location-scoped, so this must match the profile's location.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`. Immutable
   * — changing it replaces the transport.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * VPC network peered with this transport. Accepts a name (`app-vpc`), a
   * resource path (`projects/{project}/global/networks/{network}`), or a
   * Compute self-link. Immutable — changing it replaces the transport.
   */
  network: string;
  /**
   * Remote transport profile this transport connects to. Accepts a
   * profile id (`aws-us-east-1`), a resource name, or a full API URL.
   * Immutable — changing it replaces the transport. Required when
   * `providedActivationKey` is omitted.
   */
  remoteProfile?: string;
  /**
   * Partner-supplied activation key (INPUT key flow). Only valid while
   * the transport is `PENDING_KEY`. Immutable — changing it replaces the
   * transport. Required when `remoteProfile` and `bandwidth` are omitted.
   */
  providedActivationKey?: string;
  /**
   * Cloud-service-provider account id associated with `remoteProfile`.
   * Immutable — changing it replaces the transport.
   */
  remoteAccountId?: string;
  /**
   * Bandwidth. Must be one of the profile's supported values, and is
   * required when no activation key is provided.
   */
  bandwidth?: TransportBandwidth;
  /**
   * IP version stack for the established connectivity.
   */
  stackType?: TransportStackType;
  /**
   * IPv4 and IPv6 prefixes advertised to the remote provider.
   */
  advertisedRoutes?: string[];
  /**
   * Human-readable description of the transport.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Transport = Resource<
  "GCP.NetworkConnectivity.Transport",
  TransportProps,
  {
    /**
     * Full resource name
     * `projects/{project}/locations/{location}/transports/{transport}`.
     */
    name: string;
    /** Transport id (last path segment). */
    transportId: string;
    /** Project id. */
    project: string;
    /** Location id (region). */
    location: string;
    /** Network URI as reported by the API. */
    network: string | undefined;
    /** VPC network id (last path segment). */
    networkName: string | undefined;
    /** Remote transport profile URI as reported by the API. */
    remoteProfile: string | undefined;
    /** Remote profile id (last path segment). */
    remoteProfileId: string | undefined;
    /** Cloud-service-provider account id. */
    remoteAccountId: string | undefined;
    /** Configured bandwidth enum. */
    bandwidth: string | undefined;
    /** Configured IP stack. */
    stackType: string | undefined;
    /** Prefixes advertised to the remote provider. */
    advertisedRoutes: ReadonlyArray<string>;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** VPC created for peering to `network` (output-only). */
    peeringNetwork: string | undefined;
    /** Packet MTU in bytes (output-only). */
    mtuLimit: number | undefined;
    /**
     * Google-generated activation key (OUTPUT key flow). Only present
     * while the transport is `PENDING_KEY`.
     */
    generatedActivationKey: string | undefined;
    /** Server-reported lifecycle state (`PENDING_KEY`, `ACTIVE`, …). */
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
 * A Network Connectivity Partner Cross-Cloud Interconnect transport.
 *
 * Transports attach a VPC (or NCC hub, on the beta API) to a remote
 * cloud-service-provider profile such as AWS or Azure. `transportId`,
 * `location`, `network`, `remoteProfile`, `providedActivationKey`, and
 * `remoteAccountId` are immutable. Description, labels, bandwidth,
 * stack type, and advertised routes update in place. Creating a
 * transport without an activation key typically leaves it in
 * `PENDING_KEY` until the remote provider accepts the generated key.
 *
 * ### Creating a Transport
 * **Example:** Generated name with an AWS profile
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const transport = yield* GCP.NetworkConnectivity.Transport("Aws", {
 *   location: "us-east4",
 *   network: network.selfLink ?? network.networkName,
 *   remoteProfile: "aws-us-east-1",
 *   bandwidth: "BPS_1G",
 *   remoteAccountId: "123456789012",
 *   advertisedRoutes: ["10.0.0.0/8"],
 * });
 * ```
 *
 * **Example:** Named transport with labels
 * ```typescript
 * const transport = yield* GCP.NetworkConnectivity.Transport("Aws", {
 *   transportId: "app-aws",
 *   location: "us-east4",
 *   network: "projects/{project}/global/networks/app-vpc",
 *   remoteProfile: "aws-us-east-1",
 *   bandwidth: "BPS_1G",
 *   remoteAccountId: "123456789012",
 *   description: "prod aws interconnect",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Activation key
 * **Example:** Accept a partner-supplied key
 * ```typescript
 * const transport = yield* GCP.NetworkConnectivity.Transport("Azure", {
 *   location: "us-east4",
 *   network: network.networkName,
 *   providedActivationKey: "ABC1234",
 * });
 * ```
 *
 * ### Updating a Transport
 * **Example:** Description, labels, and advertised routes
 * ```typescript
 * const transport = yield* GCP.NetworkConnectivity.Transport("Aws", {
 *   transportId: "app-aws",
 *   location: "us-east4",
 *   network: "app-vpc",
 *   remoteProfile: "aws-us-east-1",
 *   bandwidth: "BPS_2G",
 *   remoteAccountId: "123456789012",
 *   advertisedRoutes: ["10.0.0.0/8", "192.168.0.0/16"],
 *   description: "prod aws interconnect v2",
 *   labels: { env: "prod", role: "cci" },
 * });
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const Transport = Resource<Transport>(
  "GCP.NetworkConnectivity.Transport",
);

export class TransportNotResolved extends Data.TaggedError(
  "GCP.NetworkConnectivity.TransportNotResolved",
)<{
  name: string;
}> {}

export class TransportFailed extends Data.TaggedError(
  "GCP.NetworkConnectivity.TransportFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class TransportStillExists extends Data.TaggedError(
  "GCP.NetworkConnectivity.TransportStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `t${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "transport";
};

const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

const networkNameOf = (network: string | undefined) =>
  network === undefined || network.length === 0
    ? undefined
    : lastSegment(network);

const profileIdOf = (profile: string | undefined) =>
  profile === undefined || profile.length === 0
    ? undefined
    : lastSegment(profile);

const toNetworkResource = (project: string, network: string) => {
  const trimmed = network.trim();
  if (trimmed.includes("/")) return trimmed;
  return `projects/${project}/global/networks/${trimmed}`;
};

const toRemoteProfileResource = (
  project: string,
  location: string,
  profile: string | undefined,
) => {
  if (profile === undefined || profile.length === 0) return undefined;
  const trimmed = profile.trim();
  if (trimmed.includes("/")) return trimmed;
  return `projects/${project}/locations/${location}/remoteTransportProfiles/${trimmed}`;
};

const resourceName = (project: string, location: string, transportId: string) =>
  `projects/${project}/locations/${location}/transports/${transportId}`;

const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const transportsAt = parts.lastIndexOf("transports");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    transportId:
      transportsAt >= 0 && parts[transportsAt + 1]
        ? parts[transportsAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, transportId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (transportId !== undefined) return transportId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const sameList = (left?: readonly string[], right?: readonly string[]) =>
  [...(left ?? [])].sort().join("\0") === [...(right ?? [])].sort().join("\0");

const normalizeBandwidth = (value: string | undefined) =>
  value === undefined || value.length === 0 || value === "BANDWIDTH_UNSPECIFIED"
    ? ""
    : value;

const normalizeStackType = (value: string | undefined) =>
  value === undefined ||
  value.length === 0 ||
  value === "STACK_TYPE_UNSPECIFIED"
    ? ""
    : value;

const toAttrs = (
  transport: networkconnectivity.Transport,
  project: string,
  region: string,
) => {
  const name = transport.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    transportId: parsed.transportId,
    project: parsed.project || project,
    location: parsed.location || region,
    network: transport.network,
    networkName: networkNameOf(transport.network),
    remoteProfile: transport.remoteProfile,
    remoteProfileId: profileIdOf(transport.remoteProfile),
    remoteAccountId: transport.remoteAccountId,
    bandwidth: transport.bandwidth,
    stackType: transport.stackType,
    advertisedRoutes: transport.advertisedRoutes ?? [],
    description: transport.description,
    labels: userLabels(transport.labels),
    peeringNetwork: transport.peeringNetwork,
    mtuLimit: transport.mtuLimit,
    generatedActivationKey: transport.generatedActivationKey,
    state: transport.state,
    createTime: transport.createTime,
    updateTime: transport.updateTime,
  };
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsTransports({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isPendingState = (state: string | undefined) =>
  state === "CREATING" ||
  state === "DELETING" ||
  state === "STATE_UNSPECIFIED" ||
  state === undefined;

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (transport): transport is networkconnectivity.Transport =>
        transport !== undefined,
      () => new TransportNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (transport) => transport.state !== "DEPROVISIONED",
      (transport) => new TransportFailed({ name, state: transport.state }),
    ),
    Effect.filterOrFail(
      (transport) => !isPendingState(transport.state),
      () => new TransportNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkConnectivity.TransportNotResolved",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((transport) =>
      transport === undefined
        ? Effect.void
        : Effect.fail(new TransportStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkConnectivity.TransportStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const listOwnedTransports = (parent: string, project: string, region: string) =>
  networkconnectivity.listProjectsLocationsTransports
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.transports ?? [])),
      Stream.filter((transport) =>
        Object.keys(transport.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((transport) => toAttrs(transport, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toCreateBody = (
  news: TransportProps,
  project: string,
  location: string,
  desiredLabels: Record<string, string>,
): networkconnectivity.Transport => ({
  network: toNetworkResource(project, news.network),
  remoteProfile: toRemoteProfileResource(project, location, news.remoteProfile),
  providedActivationKey: news.providedActivationKey,
  remoteAccountId: news.remoteAccountId,
  bandwidth: news.bandwidth,
  stackType: news.stackType,
  advertisedRoutes: news.advertisedRoutes,
  description: news.description,
  labels: desiredLabels,
});

export const TransportProvider = () =>
  Provider.succeed(Transport, {
    stables: [
      "name",
      "transportId",
      "project",
      "location",
      "networkName",
      "remoteProfileId",
      "remoteAccountId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.transportId ?? output?.transportId;
      const nextId = news.transportId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const locationChanged = previousLocation !== nextLocation;

      const previousNetwork = networkNameOf(
        olds?.network ?? output?.networkName ?? output?.network,
      );
      const nextNetwork = networkNameOf(news.network ?? previousNetwork);
      const networkChanged =
        previousNetwork !== undefined &&
        nextNetwork !== undefined &&
        previousNetwork !== nextNetwork;

      const previousProfile = profileIdOf(
        olds?.remoteProfile ?? output?.remoteProfileId ?? output?.remoteProfile,
      );
      const nextProfile = profileIdOf(news.remoteProfile ?? previousProfile);
      const profileChanged =
        previousProfile !== undefined &&
        nextProfile !== undefined &&
        previousProfile !== nextProfile;

      const previousAccount =
        olds?.remoteAccountId ?? output?.remoteAccountId ?? "";
      const nextAccount = news.remoteAccountId ?? previousAccount;
      const accountChanged = previousAccount !== nextAccount;

      const previousKey = olds?.providedActivationKey ?? "";
      const nextKey = news.providedActivationKey ?? previousKey;
      const keyChanged =
        previousKey.length > 0 && nextKey.length > 0 && previousKey !== nextKey;

      if (
        !idChanged &&
        !locationChanged &&
        !networkChanged &&
        !profileChanged &&
        !accountChanged &&
        !keyChanged
      ) {
        return undefined;
      }

      return {
        action: "replace" as const,
        deleteFirst:
          !idChanged &&
          !locationChanged &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const transportId = yield* toId(
        id,
        olds?.transportId,
        output?.transportId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, transportId);
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
        const aggregated = yield* listOwnedTransports(
          parentOf(env.project, "-"),
          env.project,
          env.region,
        );
        if (aggregated.length > 0) return aggregated;
        return yield* listOwnedTransports(
          parentOf(env.project, env.region),
          env.project,
          env.region,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const transportId = yield* toId(
        id,
        news.transportId,
        output?.transportId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, transportId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);
      if (current?.state === "DELETING") {
        yield* waitUntilGone(name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsTransports({
            parent: parentOf(env.project, location),
            transportId,
            body: toCreateBody(news, env.project, location, desiredLabels),
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
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new TransportNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const bandwidthChanged =
        news.bandwidth !== undefined &&
        normalizeBandwidth(current.bandwidth) !==
          normalizeBandwidth(news.bandwidth);
      const stackTypeChanged =
        news.stackType !== undefined &&
        normalizeStackType(current.stackType) !==
          normalizeStackType(news.stackType);
      const routesChanged =
        news.advertisedRoutes !== undefined &&
        !sameList(news.advertisedRoutes, current.advertisedRoutes);

      if (
        labelsChanged ||
        descriptionChanged ||
        bandwidthChanged ||
        stackTypeChanged ||
        routesChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          bandwidthChanged ? "bandwidth" : undefined,
          stackTypeChanged ? "stackType" : undefined,
          routesChanged ? "advertisedRoutes" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* networkconnectivity.patchProjectsLocationsTransports({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              bandwidth: news.bandwidth,
              stackType: news.stackType,
              advertisedRoutes: news.advertisedRoutes,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(current.name ?? name);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkconnectivity
        .deleteProjectsLocationsTransports({ name: output.name })
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
      yield* waitUntilGone(output.name);
    }),
  });
