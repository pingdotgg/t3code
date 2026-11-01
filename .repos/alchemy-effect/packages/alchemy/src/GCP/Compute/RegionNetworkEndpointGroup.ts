import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
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
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_NETWORK_ENDPOINT_TYPE = "SERVERLESS";
const MAX_NAME_LENGTH = 63;

export type RegionNetworkEndpointGroupType =
  | "GCE_VM_IP"
  | "GCE_VM_IP_PORT"
  | "GCE_VM_IP_PORTMAP"
  | "INTERNET_FQDN_PORT"
  | "INTERNET_IP_PORT"
  | "NON_GCP_PRIVATE_IP_PORT"
  | "PRIVATE_SERVICE_CONNECT"
  | "SERVERLESS";

export type RegionNetworkEndpointGroupCloudRun = {
  /** Cloud Run service name (RFC1035). Provide this or `urlMask`. */
  service?: string;
  /** Named Cloud Run revision tag. */
  tag?: string;
  /** URL mask used to parse `service` and `tag` from request URLs. */
  urlMask?: string;
};

export type RegionNetworkEndpointGroupAppEngine = {
  /** App Engine service name. */
  service?: string;
  /** App Engine version. */
  version?: string;
  /** URL mask used to parse `service` and `version` from request URLs. */
  urlMask?: string;
};

export type RegionNetworkEndpointGroupCloudFunction = {
  /** Cloud Function name. Provide this or `urlMask`. */
  function?: string;
  /** URL mask used to parse the function name from request URLs. */
  urlMask?: string;
};

export type RegionNetworkEndpointGroupPscData = {
  /**
   * Producer port used to connect a PSC NEG to a specific port on the
   * producer side. Only valid for `PRIVATE_SERVICE_CONNECT`.
   */
  producerPort?: number;
  /** Address allocated from the given subnetwork for PSC. */
  consumerPscAddress?: string;
  /** PSC connection id. */
  pscConnectionId?: string;
  /** PSC forwarding-rule connection status. */
  pscConnectionStatus?: string;
};

export type RegionNetworkEndpointGroupProps = {
  /**
   * NEG name. If omitted, a unique RFC1035 name is generated from the
   * stack, stage, and logical id. Immutable — changing it replaces the
   * group.
   */
  networkEndpointGroupName?: string;
  /**
   * Region the NEG lives in. Immutable — changing it replaces the group.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Compute region NEGs have no labels field and no
   * update API, so Alchemy ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) is stored in a `[alchemy …]` prefix for `list` / nuke.
   * Immutable — changing the user-facing description replaces the group.
   */
  description?: string;
  /**
   * Endpoint type. Inferred from `cloudRun` / `appEngine` /
   * `cloudFunction` / `pscTargetService` when omitted.
   * @default "SERVERLESS"
   */
  networkEndpointType?: RegionNetworkEndpointGroupType | (string & {});
  /**
   * Default port when an endpoint omits one. Must not be set for
   * `SERVERLESS` or `PRIVATE_SERVICE_CONNECT`. Immutable.
   */
  defaultPort?: number;
  /**
   * VPC network URL or name. Required for internet NEGs. Must not be set
   * for `SERVERLESS` or `PRIVATE_SERVICE_CONNECT` (except some PSC
   * producer setups). Immutable.
   */
  network?: string;
  /**
   * Subnetwork URL or name. Immutable.
   */
  subnetwork?: string;
  /**
   * User annotations. Immutable — changing them replaces the group.
   */
  annotations?: Record<string, string>;
  /**
   * Cloud Run serverless config. Only valid when
   * `networkEndpointType` is `SERVERLESS`. Immutable.
   */
  cloudRun?: RegionNetworkEndpointGroupCloudRun;
  /**
   * App Engine serverless config. Only valid when
   * `networkEndpointType` is `SERVERLESS`. Immutable.
   */
  appEngine?: RegionNetworkEndpointGroupAppEngine;
  /**
   * Cloud Function serverless config. Only valid when
   * `networkEndpointType` is `SERVERLESS`. Immutable.
   */
  cloudFunction?: RegionNetworkEndpointGroupCloudFunction;
  /**
   * Target service URL for a Private Service Connect NEG (Google API or
   * producer service attachment). Immutable.
   */
  pscTargetService?: string;
  /**
   * PSC-specific settings (`producerPort`). Immutable.
   */
  pscData?: RegionNetworkEndpointGroupPscData;
};

export type RegionNetworkEndpointGroup = Resource<
  "GCP.Compute.RegionNetworkEndpointGroup",
  RegionNetworkEndpointGroupProps,
  {
    /** NEG name. */
    networkEndpointGroupName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Endpoint type. */
    networkEndpointType: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Default port, if any. */
    defaultPort: number | undefined;
    /** Network URL, if any. */
    network: string | undefined;
    /** Subnetwork URL, if any. */
    subnetwork: string | undefined;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Cloud Run config, if this is a Cloud Run serverless NEG. */
    cloudRun: RegionNetworkEndpointGroupCloudRun | undefined;
    /** App Engine config, if this is an App Engine serverless NEG. */
    appEngine: RegionNetworkEndpointGroupAppEngine | undefined;
    /** Cloud Function config, if this is a Cloud Function serverless NEG. */
    cloudFunction: RegionNetworkEndpointGroupCloudFunction | undefined;
    /** PSC target service, if any. */
    pscTargetService: string | undefined;
    /** PSC connection data, if any. */
    pscData: RegionNetworkEndpointGroupPscData | undefined;
    /** Number of endpoints in the group. */
    size: number | undefined;
    /** Server-assigned numeric id. */
    networkEndpointGroupId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine network endpoint group.
 *
 * Regional NEGs back serverless (Cloud Run, App Engine, Cloud Functions),
 * internet (`INTERNET_IP_PORT` / `INTERNET_FQDN_PORT`), and Private Service
 * Connect load-balancing backends. The regional collection has no labels
 * field and no update API — Alchemy stamps ownership into the description
 * so `list` / nuke can find leaked groups. Name, region, type, network,
 * serverless config, PSC target, port, annotations, and description are
 * all immutable (changing any of them replaces the group).
 *
 * ### Creating a RegionNetworkEndpointGroup
 * **Example:** Cloud Run serverless NEG with a URL mask
 * ```typescript
 * const neg = yield* GCP.Compute.RegionNetworkEndpointGroup("RunNeg", {
 *   region: "us-central1",
 *   networkEndpointType: "SERVERLESS",
 *   cloudRun: { urlMask: "<service>" },
 * });
 * ```
 *
 * **Example:** Cloud Run service backend
 * ```typescript
 * const neg = yield* GCP.Compute.RegionNetworkEndpointGroup("RunNeg", {
 *   cloudRun: { service: "api" },
 * });
 * ```
 *
 * ### Internet NEGs
 * **Example:** Regional internet IP:port NEG
 * ```typescript
 * const neg = yield* GCP.Compute.RegionNetworkEndpointGroup("Internet", {
 *   network: "default",
 *   networkEndpointType: "INTERNET_IP_PORT",
 *   defaultPort: 443,
 * });
 * ```
 *
 * ### Private Service Connect
 * **Example:** PSC NEG targeting a Google API
 * ```typescript
 * const neg = yield* GCP.Compute.RegionNetworkEndpointGroup("Kms", {
 *   networkEndpointType: "PRIVATE_SERVICE_CONNECT",
 *   pscTargetService: "us-central1-cloudkms.googleapis.com",
 *   subnetwork:
 *     "projects/{project}/regions/us-central1/subnetworks/default",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionNetworkEndpointGroup = Resource<RegionNetworkEndpointGroup>(
  "GCP.Compute.RegionNetworkEndpointGroup",
);

export class RegionNetworkEndpointGroupNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionNetworkEndpointGroupNotResolved",
)<{
  networkEndpointGroupName: string;
  region: string;
}> {}

export class RegionNetworkEndpointGroupPending extends Data.TaggedError(
  "GCP.Compute.RegionNetworkEndpointGroupPending",
)<{
  networkEndpointGroupName: string;
  status: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const resourceRefOf = (value: string | undefined) => {
  if (!value) return "";
  return lastSegment(value);
};

const networkUrl = (project: string, network: string) => {
  if (network.includes("/")) {
    return network.startsWith("projects/") || network.startsWith("http")
      ? network
      : `projects/${project}/${network.replace(/^\//, "")}`;
  }
  return `projects/${project}/global/networks/${network}`;
};

const subnetworkUrl = (project: string, region: string, subnetwork: string) => {
  if (subnetwork.includes("/")) {
    return subnetwork.startsWith("projects/") || subnetwork.startsWith("http")
      ? subnetwork
      : `projects/${project}/${subnetwork.replace(/^\//, "")}`;
  }
  return `projects/${project}/regions/${region}/subnetworks/${subnetwork}`;
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    const rfc = generated.replace(/^[^a-z]+/, "n").replace(/-+$/g, "");
    return rfc.slice(0, MAX_NAME_LENGTH);
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const inferType = (props: RegionNetworkEndpointGroupProps): string => {
  if (props.networkEndpointType) return props.networkEndpointType;
  if (props.pscTargetService) return "PRIVATE_SERVICE_CONNECT";
  if (props.cloudRun || props.appEngine || props.cloudFunction) {
    return "SERVERLESS";
  }
  return DEFAULT_NETWORK_ENDPOINT_TYPE;
};

const annotationsOf = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(annotations);

const sameAnnotations = (
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
) => {
  const a = annotationsOf(left);
  const b = annotationsOf(right);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
};

const subsetEqual = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return true;
  if (desired === null || observed === null) return desired === observed;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || desired.length !== observed.length) {
      return false;
    }
    return desired.every((item, index) => subsetEqual(observed[index], item));
  }
  if (typeof desired === "object") {
    if (typeof observed !== "object" || observed === undefined) return false;
    const current = observed as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) => value === undefined || subsetEqual(current[key], value),
    );
  }
  return observed === desired;
};

const toCloudRun = (
  value: compute.NetworkEndpointGroupCloudRun | undefined,
): RegionNetworkEndpointGroupCloudRun | undefined => {
  if (value === undefined) return undefined;
  if (
    value.service === undefined &&
    value.tag === undefined &&
    value.urlMask === undefined
  ) {
    return undefined;
  }
  return {
    service: value.service,
    tag: value.tag,
    urlMask: value.urlMask,
  };
};

const toAppEngine = (
  value: compute.NetworkEndpointGroupAppEngine | undefined,
): RegionNetworkEndpointGroupAppEngine | undefined => {
  if (value === undefined) return undefined;
  if (
    value.service === undefined &&
    value.version === undefined &&
    value.urlMask === undefined
  ) {
    return undefined;
  }
  return {
    service: value.service,
    version: value.version,
    urlMask: value.urlMask,
  };
};

const toCloudFunction = (
  value: compute.NetworkEndpointGroupCloudFunction | undefined,
): RegionNetworkEndpointGroupCloudFunction | undefined => {
  if (value === undefined) return undefined;
  if (value.function === undefined && value.urlMask === undefined) {
    return undefined;
  }
  return {
    function: value.function,
    urlMask: value.urlMask,
  };
};

const toPscData = (
  value: compute.NetworkEndpointGroupPscData | undefined,
): RegionNetworkEndpointGroupPscData | undefined => {
  if (value === undefined) return undefined;
  return {
    producerPort: value.producerPort,
    consumerPscAddress: value.consumerPscAddress,
    pscConnectionId: value.pscConnectionId,
    pscConnectionStatus: value.pscConnectionStatus,
  };
};

const toBody = (
  project: string,
  region: string,
  networkEndpointGroupName: string,
  props: RegionNetworkEndpointGroupProps,
  ownership: Record<string, string>,
): compute.NetworkEndpointGroup => {
  const networkEndpointType = inferType(props);
  const body: compute.NetworkEndpointGroup = {
    name: networkEndpointGroupName,
    description: encodeDescription(ownership, props.description),
    networkEndpointType,
    defaultPort: props.defaultPort,
    annotations:
      props.annotations !== undefined &&
      Object.keys(props.annotations).length > 0
        ? props.annotations
        : undefined,
    cloudRun: props.cloudRun,
    appEngine: props.appEngine,
    cloudFunction: props.cloudFunction,
    pscTargetService: props.pscTargetService,
  };
  if (props.network !== undefined) {
    body.network = networkUrl(project, props.network);
  }
  if (props.subnetwork !== undefined) {
    body.subnetwork = subnetworkUrl(project, region, props.subnetwork);
  }
  if (props.pscData?.producerPort !== undefined) {
    body.pscData = { producerPort: props.pscData.producerPort };
  }
  return body;
};

const toAttrs = (
  group: compute.NetworkEndpointGroup,
  project: string,
): RegionNetworkEndpointGroup["Attributes"] => {
  const parsed = parseDescription(group.description);
  return {
    networkEndpointGroupName: group.name ?? "",
    project,
    region: lastSegment(group.region ?? "").toLowerCase(),
    networkEndpointType: group.networkEndpointType,
    description: parsed.description,
    defaultPort: group.defaultPort,
    network: group.network,
    subnetwork: group.subnetwork,
    annotations: annotationsOf(group.annotations),
    cloudRun: toCloudRun(group.cloudRun),
    appEngine: toAppEngine(group.appEngine),
    cloudFunction: toCloudFunction(group.cloudFunction),
    pscTargetService: group.pscTargetService,
    pscData: toPscData(group.pscData),
    size: group.size,
    networkEndpointGroupId: group.id,
    selfLink: group.selfLink,
    creationTimestamp: group.creationTimestamp,
    kind: group.kind,
  };
};

const getByName = (
  project: string,
  region: string,
  networkEndpointGroup: string,
) =>
  compute
    .getRegionNetworkEndpointGroups({
      project,
      region,
      networkEndpointGroup,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const requireGroup = (
  project: string,
  region: string,
  networkEndpointGroupName: string,
) =>
  getByName(project, region, networkEndpointGroupName).pipe(
    Effect.flatMap((group) =>
      group
        ? Effect.succeed(group)
        : Effect.fail(
            new RegionNetworkEndpointGroupNotResolved({
              networkEndpointGroupName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (e) =>
        e._tag === "GCP.Compute.RegionNetworkEndpointGroupNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  networkEndpointGroupName: string,
) =>
  getByName(project, region, networkEndpointGroupName).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(
            new RegionNetworkEndpointGroupPending({
              networkEndpointGroupName,
              status: "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.RegionNetworkEndpointGroupPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const immutableChanged = (
  news: RegionNetworkEndpointGroupProps,
  olds: Partial<RegionNetworkEndpointGroupProps> | undefined,
  output: RegionNetworkEndpointGroup["Attributes"] | undefined,
) => {
  const previousType =
    (olds !== undefined ? inferType(olds) : undefined) ??
    output?.networkEndpointType ??
    DEFAULT_NETWORK_ENDPOINT_TYPE;
  if (inferType(news) !== previousType) return true;

  const previousDescription = olds?.description ?? output?.description ?? "";
  if ((news.description ?? "") !== previousDescription) return true;

  if (
    news.defaultPort !== undefined &&
    news.defaultPort !== (olds?.defaultPort ?? output?.defaultPort)
  ) {
    return true;
  }

  if (
    news.network !== undefined &&
    resourceRefOf(news.network) !==
      resourceRefOf(olds?.network ?? output?.network)
  ) {
    return true;
  }

  if (
    news.subnetwork !== undefined &&
    resourceRefOf(news.subnetwork) !==
      resourceRefOf(olds?.subnetwork ?? output?.subnetwork)
  ) {
    return true;
  }

  if (
    news.pscTargetService !== undefined &&
    news.pscTargetService !==
      (olds?.pscTargetService ?? output?.pscTargetService)
  ) {
    return true;
  }

  if (
    news.annotations !== undefined &&
    !sameAnnotations(news.annotations, olds?.annotations ?? output?.annotations)
  ) {
    return true;
  }

  if (
    news.cloudRun !== undefined &&
    !subsetEqual(olds?.cloudRun ?? output?.cloudRun, news.cloudRun)
  ) {
    return true;
  }
  if (
    news.appEngine !== undefined &&
    !subsetEqual(olds?.appEngine ?? output?.appEngine, news.appEngine)
  ) {
    return true;
  }
  if (
    news.cloudFunction !== undefined &&
    !subsetEqual(
      olds?.cloudFunction ?? output?.cloudFunction,
      news.cloudFunction,
    )
  ) {
    return true;
  }
  if (
    news.pscData?.producerPort !== undefined &&
    news.pscData.producerPort !==
      (olds?.pscData?.producerPort ?? output?.pscData?.producerPort)
  ) {
    return true;
  }
  return false;
};

export const RegionNetworkEndpointGroupProvider = () =>
  Provider.succeed(RegionNetworkEndpointGroup, {
    stables: [
      "networkEndpointGroupName",
      "project",
      "region",
      "networkEndpointType",
      "networkEndpointGroupId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName =
        olds.networkEndpointGroupName ?? output?.networkEndpointGroupName;
      const nextName = news.networkEndpointGroupName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        nextName !== previousName;

      const previousRegion = normalizeRegion(
        olds.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const regionChanged = previousRegion !== nextRegion;

      if (nameChanged || regionChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (immutableChanged(news, olds, output)) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const networkEndpointGroupName = yield* toName(
        id,
        olds?.networkEndpointGroupName,
        output?.networkEndpointGroupName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        networkEndpointGroupName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListNetworkEndpointGroups
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.networkEndpointGroups ?? [])
              .filter(
                (item) => item.region !== undefined && item.zone === undefined,
              )
              .filter((item) => hasOwnershipMarker(item.description))
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkEndpointGroupName = yield* toName(
        id,
        news.networkEndpointGroupName,
        output?.networkEndpointGroupName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(
        env.project,
        region,
        networkEndpointGroupName,
        news,
        ownership,
      );

      let current = yield* getByName(
        env.project,
        region,
        networkEndpointGroupName,
      );

      if (current === undefined) {
        const created = yield* compute
          .insertRegionNetworkEndpointGroups({
            project: env.project,
            region,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }).pipe(
                Effect.flatMap(() =>
                  requireGroup(env.project, region, networkEndpointGroupName),
                ),
              ),
            ),
            Effect.catchTag("Conflict", () =>
              getByName(env.project, region, networkEndpointGroupName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new RegionNetworkEndpointGroupNotResolved({
          networkEndpointGroupName,
          region,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      if (!output.networkEndpointGroupName) return;
      yield* compute
        .deleteRegionNetworkEndpointGroups({
          project,
          region,
          networkEndpointGroup: output.networkEndpointGroupName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitRegionOperation(project, region, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(project, region, output.networkEndpointGroupName);
    }),
  });
