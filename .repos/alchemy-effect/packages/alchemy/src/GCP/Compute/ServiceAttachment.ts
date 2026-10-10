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
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_CONNECTION_PREFERENCE = "ACCEPT_AUTOMATIC";
const MAX_NAME_LENGTH = 63;

export type ServiceAttachmentConnectionPreference =
  | compute.ServiceAttachmentConnectionPreferenceEnum
  | (string & {});

export type ServiceAttachmentConsumerAccept = {
  /** Consumer project id or number allowed to connect. */
  projectIdOrNum?: string;
  /** Consumer network URL allowed to connect. */
  networkUrl?: string;
  /** Consumer endpoint URL allowed to connect. */
  endpointUrl?: string;
  /** Max consumer forwarding rules (or 1 for an endpoint). */
  connectionLimit?: number;
};

export type ServiceAttachmentConnectedEndpoint = {
  /** Connection status (`PENDING`, `ACCEPTED`, `REJECTED`, …). */
  status: string | undefined;
  /** Consumer forwarding-rule URL. */
  endpoint: string | undefined;
  /** Consumer network URL. */
  consumerNetwork: string | undefined;
  /** PSC connection id. */
  pscConnectionId: string | undefined;
  /** Propagated NCC spoke count. */
  propagatedConnectionCount: number | undefined;
  /** NAT IPs of the connected endpoint. */
  natIps: ReadonlyArray<string>;
};

export type ServiceAttachmentProps = {
  /**
   * Service attachment name (RFC1035, 1-63 characters). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the attachment.
   */
  serviceAttachmentName?: string;
  /**
   * Region the attachment lives in. Immutable — changing it replaces
   * the attachment. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Compute service attachments have no labels
   * field, so Alchemy ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) plus user `labels` are stored in a `[alchemy …]`
   * prefix for `list` / nuke. Updated in place via `patch`.
   */
  description?: string;
  /**
   * URL of the producer forwarding rule (or other target service) this
   * attachment exposes. Required. Names are expanded to
   * `projects/{project}/regions/{region}/forwardingRules/{name}`.
   * Updated in place via `patch`.
   */
  targetService: string;
  /**
   * Subnet URLs or names the producer provides for PSC NAT. Each subnet
   * must have purpose `PRIVATE_SERVICE_CONNECT`. Required. Updated in
   * place via `patch`.
   */
  natSubnets: string[];
  /**
   * How consumer connections are admitted.
   * `ACCEPT_AUTOMATIC` always accepts; `ACCEPT_MANUAL` uses the accept
   * and reject lists.
   * @default "ACCEPT_AUTOMATIC"
   */
  connectionPreference?: ServiceAttachmentConnectionPreference;
  /**
   * Send PROXY protocol v1 headers to backends. Must be `false` for
   * passthrough internal load balancers.
   * @default false
   */
  enableProxyProtocol?: boolean;
  /**
   * Projects, networks, or endpoints allowed to connect, each with a
   * connection limit. Used with `ACCEPT_MANUAL`. A given attachment
   * manages connections at one level — projects, networks, or
   * endpoints — not mixed. Updated in place via `patch`.
   */
  consumerAcceptLists?: ServiceAttachmentConsumerAccept[];
  /**
   * Projects or networks that must not connect. Must use the same
   * level as `consumerAcceptLists`. Updated in place via `patch`.
   */
  consumerRejectLists?: string[];
  /**
   * When `true`, accept/reject-list changes also move existing
   * `ACCEPTED` / `REJECTED` endpoints. When `false`, only `PENDING`
   * endpoints are affected. Updated in place via `patch`.
   */
  reconcileConnections?: boolean;
  /**
   * Max Network Connectivity Center spokes a connected endpoint may
   * propagate to. Default `250` when omitted.
   */
  propagatedConnectionLimit?: number;
  /**
   * NAT IPs allocated per connected endpoint.
   * @default 1
   */
  natIpsPerEndpoint?: number;
  /**
   * DNS domain names used when integrating connected endpoints with
   * Cloud DNS (max 1, for example `p.mycompany.com.`). Immutable —
   * changing them replaces the attachment.
   */
  domainNames?: string[];
  /**
   * User labels. Packed into the description marker (and `metadata`)
   * together with Alchemy ownership labels.
   */
  labels?: Record<string, string>;
};

export type ServiceAttachment = Resource<
  "GCP.Compute.ServiceAttachment",
  ServiceAttachmentProps,
  {
    /** Service attachment name. */
    serviceAttachmentName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Server-assigned numeric id. */
    serviceAttachmentId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Producer forwarding rule / target service URL. */
    targetService: string | undefined;
    /** Producer forwarding-rule URL, if the API reports it separately. */
    producerForwardingRule: string | undefined;
    /** NAT subnet URLs. */
    natSubnets: ReadonlyArray<string>;
    /** Connection preference. */
    connectionPreference: string | undefined;
    /** Whether PROXY protocol is enabled. */
    enableProxyProtocol: boolean;
    /** Accepted consumers. */
    consumerAcceptLists: ReadonlyArray<ServiceAttachmentConsumerAccept>;
    /** Rejected projects or networks. */
    consumerRejectLists: ReadonlyArray<string>;
    /** Whether list changes reconcile existing endpoints. */
    reconcileConnections: boolean;
    /** Propagated connection limit. */
    propagatedConnectionLimit: number | undefined;
    /** NAT IPs per connected endpoint. */
    natIpsPerEndpoint: number | undefined;
    /** Cloud DNS domain names. */
    domainNames: ReadonlyArray<string>;
    /** Connected consumer endpoints. */
    connectedEndpoints: ReadonlyArray<ServiceAttachmentConnectedEndpoint>;
    /** 128-bit PSC service-attachment id. */
    pscServiceAttachmentId:
      | { high: string | undefined; low: string | undefined }
      | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine Private Service Connect service attachment.
 *
 * A service attachment is how a producer exposes an internal load
 * balancer (or other target service) to consumers over Private Service
 * Connect. It points at a producer forwarding rule, lists NAT subnets
 * with purpose `PRIVATE_SERVICE_CONNECT`, and admits consumers either
 * automatically or via accept/reject lists.
 *
 * Compute ServiceAttachment has no labels field — Alchemy ownership is
 * stored in the description so nuke can find leaked attachments.
 *
 * ### Creating a Service Attachment
 * **Example:** Generated name, automatic accept
 * ```typescript
 * const attachment = yield* GCP.Compute.ServiceAttachment("Producer", {
 *   region: "us-central1",
 *   targetService: forwardingRule.selfLink,
 *   natSubnets: [natSubnet.selfLink],
 *   connectionPreference: "ACCEPT_AUTOMATIC",
 *   enableProxyProtocol: false,
 * });
 * ```
 *
 * **Example:** Named attachment with labels
 * ```typescript
 * const attachment = yield* GCP.Compute.ServiceAttachment("Producer", {
 *   serviceAttachmentName: "app-psc",
 *   region: "us-central1",
 *   targetService: forwardingRule.selfLink,
 *   natSubnets: [natSubnet.selfLink],
 *   description: "private service connect",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Manual admission
 * **Example:** Accept a consumer project
 * ```typescript
 * const attachment = yield* GCP.Compute.ServiceAttachment("Producer", {
 *   targetService: forwardingRule.selfLink,
 *   natSubnets: [natSubnet.selfLink],
 *   connectionPreference: "ACCEPT_MANUAL",
 *   consumerAcceptLists: [
 *     { projectIdOrNum: "my-consumer-project", connectionLimit: 10 },
 *   ],
 *   reconcileConnections: true,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const ServiceAttachment = Resource<ServiceAttachment>(
  "GCP.Compute.ServiceAttachment",
);

export class ServiceAttachmentNotResolved extends Data.TaggedError(
  "GCP.Compute.ServiceAttachmentNotResolved",
)<{
  serviceAttachmentName: string;
  region: string;
}> {}

export class ServiceAttachmentPending extends Data.TaggedError(
  "GCP.Compute.ServiceAttachmentPending",
)<{
  serviceAttachmentName: string;
  status: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const lastSegment = (value: string | undefined) => {
  if (!value) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const resourceRefOf = (value: string | undefined) => lastSegment(value);

const refsKey = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])]
    .map((value) => resourceRefOf(value))
    .filter((value) => value.length > 0)
    .sort()
    .join(",");

const connectionPreferenceOf = (value: string | undefined) =>
  value && value.length > 0 ? value : DEFAULT_CONNECTION_PREFERENCE;

const domainNamesKey = (names: ReadonlyArray<string> | undefined) =>
  [...(names ?? [])].map(String).sort().join(",");

const acceptKey = (item: ServiceAttachmentConsumerAccept) =>
  JSON.stringify({
    projectIdOrNum: item.projectIdOrNum ?? "",
    networkUrl: resourceRefOf(item.networkUrl),
    endpointUrl: resourceRefOf(item.endpointUrl),
    connectionLimit: item.connectionLimit ?? 0,
  });

const acceptListsKey = (
  lists: ReadonlyArray<ServiceAttachmentConsumerAccept> | undefined,
) => JSON.stringify([...(lists ?? [])].map(acceptKey).sort());

const encodeDescription = (
  user: string | undefined,
  labels: Record<string, string>,
): string => {
  const packed = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const marker = `[alchemy ${packed}]`;
  return user ? `${marker}\n${user}` : marker;
};

const parseDescription = (
  description: string | undefined,
): { labels: Record<string, string>; user: string | undefined } => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, user: description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, user: description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, user: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined): boolean =>
  (description ?? "").startsWith("[alchemy ");

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `s${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const toForwardingRuleUrl = (
  project: string,
  region: string,
  value: string,
) => {
  if (value.includes("/")) return value;
  return `projects/${project}/regions/${region}/forwardingRules/${value}`;
};

const toSubnetworkUrl = (project: string, region: string, value: string) => {
  if (value.includes("/")) return value;
  return `projects/${project}/regions/${region}/subnetworks/${value}`;
};

const toConnectedEndpoint = (
  endpoint: compute.ServiceAttachmentConnectedEndpoint,
): ServiceAttachmentConnectedEndpoint => ({
  status: endpoint.status,
  endpoint: endpoint.endpoint,
  consumerNetwork: endpoint.consumerNetwork,
  pscConnectionId: endpoint.pscConnectionId,
  propagatedConnectionCount: endpoint.propagatedConnectionCount,
  natIps: endpoint.natIps ?? [],
});

const toAccept = (
  item: compute.ServiceAttachmentConsumerProjectLimit,
): ServiceAttachmentConsumerAccept => ({
  projectIdOrNum: item.projectIdOrNum,
  networkUrl: item.networkUrl,
  endpointUrl: item.endpointUrl,
  connectionLimit: item.connectionLimit,
});

const toAttrs = (
  attachment: compute.ServiceAttachment,
  project: string,
): ServiceAttachment["Attributes"] => {
  const decoded = parseDescription(attachment.description);
  const fromMetadata = userLabels(attachment.metadata);
  const fromDescription = userLabels(decoded.labels);
  return {
    serviceAttachmentName: attachment.name ?? "",
    project,
    region: lastSegment(attachment.region).toLowerCase(),
    serviceAttachmentId: attachment.id,
    selfLink: attachment.selfLink,
    description: decoded.user,
    targetService: attachment.targetService,
    producerForwardingRule: attachment.producerForwardingRule,
    natSubnets: attachment.natSubnets ?? [],
    connectionPreference: attachment.connectionPreference,
    enableProxyProtocol: attachment.enableProxyProtocol === true,
    consumerAcceptLists: (attachment.consumerAcceptLists ?? []).map(toAccept),
    consumerRejectLists: attachment.consumerRejectLists ?? [],
    reconcileConnections: attachment.reconcileConnections === true,
    propagatedConnectionLimit: attachment.propagatedConnectionLimit,
    natIpsPerEndpoint: attachment.natIpsPerEndpoint,
    domainNames: attachment.domainNames ?? [],
    connectedEndpoints: (attachment.connectedEndpoints ?? []).map(
      toConnectedEndpoint,
    ),
    pscServiceAttachmentId: attachment.pscServiceAttachmentId
      ? {
          high: attachment.pscServiceAttachmentId.high,
          low: attachment.pscServiceAttachmentId.low,
        }
      : undefined,
    labels:
      Object.keys(fromMetadata).length > 0 ? fromMetadata : fromDescription,
    creationTimestamp: attachment.creationTimestamp,
    kind: attachment.kind,
  };
};

const getByName = (
  project: string,
  region: string,
  serviceAttachment: string,
) =>
  compute
    .getServiceAttachments({ project, region, serviceAttachment })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const requireAttachment = (
  project: string,
  region: string,
  serviceAttachmentName: string,
) =>
  getByName(project, region, serviceAttachmentName).pipe(
    Effect.flatMap((attachment) =>
      attachment
        ? Effect.succeed(attachment)
        : Effect.fail(
            new ServiceAttachmentNotResolved({
              serviceAttachmentName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.ServiceAttachmentNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  serviceAttachmentName: string,
) =>
  getByName(project, region, serviceAttachmentName).pipe(
    Effect.flatMap((attachment) =>
      attachment === undefined
        ? Effect.void
        : Effect.fail(
            new ServiceAttachmentPending({
              serviceAttachmentName,
              status: "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.ServiceAttachmentPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const runOp = <E, R>(
  project: string,
  region: string,
  serviceAttachmentName: string,
  operation: Effect.Effect<compute.Operation, E, R>,
) =>
  operation.pipe(
    Effect.flatMap((op) => waitRegionOperation(project, region, op)),
  );

export const ServiceAttachmentProvider = () =>
  Provider.succeed(ServiceAttachment, {
    stables: [
      "serviceAttachmentName",
      "project",
      "region",
      "serviceAttachmentId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName =
        olds.serviceAttachmentName ?? output?.serviceAttachmentName;
      const nextName = news.serviceAttachmentName ?? previousName;
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

      const previousDomains = domainNamesKey(
        olds.domainNames ?? output?.domainNames,
      );
      const nextDomains = domainNamesKey(
        news.domainNames ?? olds.domainNames ?? output?.domainNames,
      );
      const domainChanged =
        news.domainNames !== undefined && previousDomains !== nextDomains;

      if (nameChanged || regionChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (domainChanged) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            (news.serviceAttachmentName === undefined ||
              news.serviceAttachmentName === previousName),
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceAttachmentName = yield* toName(
        id,
        olds?.serviceAttachmentName,
        output?.serviceAttachmentName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        serviceAttachmentName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const decoded = parseDescription(existing.description);
      const owned =
        (yield* hasAlchemyLabels(id, decoded.labels)) ||
        (yield* hasAlchemyLabels(id, tagRecord(existing.metadata)));
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListServiceAttachments
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.serviceAttachments ?? [])
              .filter(
                (item) =>
                  hasOwnershipMarker(item.description) ||
                  Object.keys(item.metadata ?? {}).some((key) =>
                    key.startsWith("alchemy-"),
                  ),
              )
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceAttachmentName = yield* toName(
        id,
        news.serviceAttachmentName,
        output?.serviceAttachmentName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredDescription = encodeDescription(
        news.description,
        desiredLabels,
      );
      const targetService = toForwardingRuleUrl(
        env.project,
        region,
        news.targetService,
      );
      const natSubnets = news.natSubnets.map((subnet) =>
        toSubnetworkUrl(env.project, region, subnet),
      );
      const connectionPreference = connectionPreferenceOf(
        news.connectionPreference,
      );
      const enableProxyProtocol = news.enableProxyProtocol === true;

      let current = yield* getByName(
        env.project,
        region,
        serviceAttachmentName,
      );

      if (current === undefined) {
        const created = yield* compute
          .insertServiceAttachments({
            project: env.project,
            region,
            body: {
              name: serviceAttachmentName,
              description: desiredDescription,
              targetService,
              natSubnets,
              connectionPreference,
              enableProxyProtocol,
              consumerAcceptLists: news.consumerAcceptLists,
              consumerRejectLists: news.consumerRejectLists,
              reconcileConnections: news.reconcileConnections,
              propagatedConnectionLimit: news.propagatedConnectionLimit,
              natIpsPerEndpoint: news.natIpsPerEndpoint,
              domainNames: news.domainNames,
              metadata: desiredLabels,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }).pipe(
                Effect.flatMap(() =>
                  requireAttachment(env.project, region, serviceAttachmentName),
                ),
              ),
            ),
            Effect.catchTag("Conflict", () =>
              requireAttachment(env.project, region, serviceAttachmentName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ServiceAttachmentNotResolved({
          serviceAttachmentName,
          region,
        });
      }

      const observedPreference = connectionPreferenceOf(
        current.connectionPreference,
      );
      const observedTarget = resourceRefOf(
        current.targetService ?? current.producerForwardingRule,
      );
      const observedNat = refsKey(current.natSubnets);
      const observedAccept = acceptListsKey(
        (current.consumerAcceptLists ?? []).map(toAccept),
      );
      const observedReject = refsKey(current.consumerRejectLists);
      const decoded = parseDescription(current.description);
      const observedMetadata = tagRecord(current.metadata);
      const labelsChanged =
        JSON.stringify(observedMetadata) !== JSON.stringify(desiredLabels) ||
        decoded.user !== (news.description ?? undefined) ||
        JSON.stringify(userLabels(decoded.labels)) !==
          JSON.stringify(userLabels(desiredLabels));

      const needsPatch =
        labelsChanged ||
        observedPreference !== connectionPreference ||
        observedTarget !== resourceRefOf(targetService) ||
        observedNat !== refsKey(natSubnets) ||
        (current.enableProxyProtocol === true) !== enableProxyProtocol ||
        (news.consumerAcceptLists !== undefined &&
          observedAccept !== acceptListsKey(news.consumerAcceptLists)) ||
        (news.consumerRejectLists !== undefined &&
          observedReject !== refsKey(news.consumerRejectLists)) ||
        (news.reconcileConnections !== undefined &&
          (current.reconcileConnections === true) !==
            news.reconcileConnections) ||
        (news.propagatedConnectionLimit !== undefined &&
          (current.propagatedConnectionLimit ?? 250) !==
            news.propagatedConnectionLimit) ||
        (news.natIpsPerEndpoint !== undefined &&
          (current.natIpsPerEndpoint ?? 1) !== news.natIpsPerEndpoint);

      if (needsPatch) {
        const latest =
          (yield* getByName(env.project, region, serviceAttachmentName)) ??
          current;
        yield* runOp(
          env.project,
          region,
          serviceAttachmentName,
          compute.patchServiceAttachments({
            project: env.project,
            region,
            serviceAttachment: serviceAttachmentName,
            body: {
              name: serviceAttachmentName,
              fingerprint: latest.fingerprint,
              description: desiredDescription,
              targetService,
              natSubnets,
              connectionPreference,
              enableProxyProtocol,
              consumerAcceptLists:
                news.consumerAcceptLists ?? current.consumerAcceptLists,
              consumerRejectLists:
                news.consumerRejectLists ?? current.consumerRejectLists,
              reconcileConnections:
                news.reconcileConnections ?? current.reconcileConnections,
              propagatedConnectionLimit:
                news.propagatedConnectionLimit ??
                current.propagatedConnectionLimit,
              natIpsPerEndpoint:
                news.natIpsPerEndpoint ?? current.natIpsPerEndpoint,
              metadata: desiredLabels,
            },
          }),
        ).pipe(
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 5,
            schedule: Schedule.spaced("1 second"),
          }),
        );
        current =
          (yield* getByName(env.project, region, serviceAttachmentName)) ??
          current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      yield* compute
        .deleteServiceAttachments({
          project,
          region,
          serviceAttachment: output.serviceAttachmentName,
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
      yield* waitUntilGone(project, region, output.serviceAttachmentName);
    }),
  });
