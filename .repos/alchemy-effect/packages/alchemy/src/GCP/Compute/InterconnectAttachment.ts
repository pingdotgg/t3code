import { ignoredCodes } from "./internal.ts";
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
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_TYPE = "PARTNER";
const DEFAULT_ENCRYPTION = "NONE";
const DEFAULT_STACK = "IPV4_ONLY";
const MAX_NAME_LENGTH = 63;

export type InterconnectAttachmentType =
  | compute.InterconnectAttachmentTypeEnum
  | (string & {});
export type InterconnectAttachmentBandwidth =
  | compute.InterconnectAttachmentBandwidthEnum
  | (string & {});
export type InterconnectAttachmentEncryption =
  | compute.InterconnectAttachmentEncryptionEnum
  | (string & {});
export type InterconnectAttachmentStackType =
  | compute.InterconnectAttachmentStackTypeEnum
  | (string & {});
export type InterconnectAttachmentEdgeAvailabilityDomain =
  | compute.InterconnectAttachmentEdgeAvailabilityDomainEnum
  | (string & {});
export type InterconnectAttachmentPartnerMetadata =
  compute.InterconnectAttachmentPartnerMetadata;
export type InterconnectAttachmentL2Forwarding =
  compute.InterconnectAttachmentL2Forwarding;

export type InterconnectAttachmentProps = {
  /**
   * Attachment name (RFC1035, 1-63 characters). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the attachment.
   */
  interconnectAttachmentName?: string;
  /**
   * Region the attachment lives in. Immutable — changing it replaces the
   * attachment. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Cloud Router URL or name in the same region. Required. Immutable —
   * changing it replaces the attachment.
   */
  router: string;
  /**
   * Attachment type (`DEDICATED`, `PARTNER`, `PARTNER_PROVIDER`,
   * `L2_DEDICATED`). Immutable — changing it replaces the attachment.
   * @default "PARTNER"
   */
  type?: InterconnectAttachmentType;
  /**
   * Underlying Interconnect URL or name. Required for `DEDICATED` and
   * `L2_DEDICATED`. Immutable — changing it replaces the attachment.
   */
  interconnect?: string;
  /**
   * Desired availability domain for `PARTNER` attachments. Immutable —
   * changing it replaces the attachment.
   */
  edgeAvailabilityDomain?: InterconnectAttachmentEdgeAvailabilityDomain;
  /**
   * Optional description. Updated in place via `patch`.
   */
  description?: string;
  /**
   * Administrative status. When `false`, the attachment carries no
   * packets. Updated in place.
   * @default true
   */
  adminEnabled?: boolean;
  /**
   * Provisioned bandwidth. Mutable for `DEDICATED` and
   * `PARTNER_PROVIDER`.
   */
  bandwidth?: InterconnectAttachmentBandwidth;
  /**
   * Packet MTU in bytes (`1440`, `1460`, `1500`, `8896`). Updated in
   * place.
   */
  mtu?: number;
  /**
   * IP stack (`IPV4_ONLY` or `IPV4_IPV6`). Updated in place.
   * @default "IPV4_ONLY"
   */
  stackType?: InterconnectAttachmentStackType;
  /**
   * VLAN encryption. Immutable — changing it replaces the attachment.
   * @default "NONE"
   */
  encryption?: InterconnectAttachmentEncryption;
  /**
   * IEEE 802.1Q VLAN tag (2-4093). Create-time only. Immutable —
   * changing it replaces the attachment.
   */
  vlanTag8021q?: number;
  /**
   * Reserved internal addresses for IPsec-encrypted attachments.
   * Immutable — changing them replaces the attachment.
   */
  ipsecInternalAddresses?: string[];
  /**
   * Partner metadata displayed to customers. Mutable for
   * `PARTNER_PROVIDER`.
   */
  partnerMetadata?: InterconnectAttachmentPartnerMetadata;
  /**
   * L2 forwarding config. Required when `type` is `L2_DEDICATED`.
   */
  l2Forwarding?: InterconnectAttachmentL2Forwarding;
  /**
   * IPv4 subnet mask length (`29` or `30`). Create-time only.
   */
  subnetLength?: number;
  /**
   * Candidate link-local prefixes for Cloud Router IPs. Create-time
   * only.
   */
  candidateSubnets?: string[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `setLabels` (labels cannot be set on insert).
   */
  labels?: Record<string, string>;
};

export type InterconnectAttachment = Resource<
  "GCP.Compute.InterconnectAttachment",
  InterconnectAttachmentProps,
  {
    /** Attachment name. */
    interconnectAttachmentName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Cloud Router URL. */
    router: string | undefined;
    /** Attachment type. */
    type: string | undefined;
    /** Underlying Interconnect URL. */
    interconnect: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Administrative status. */
    adminEnabled: boolean;
    /** Provisioned bandwidth. */
    bandwidth: string | undefined;
    /** Packet MTU. */
    mtu: number | undefined;
    /** IP stack. */
    stackType: string | undefined;
    /** VLAN encryption. */
    encryption: string | undefined;
    /** VLAN tag. */
    vlanTag8021q: number | undefined;
    /** Availability domain. */
    edgeAvailabilityDomain: string | undefined;
    /** Partner pairing key (PARTNER type). */
    pairingKey: string | undefined;
    /** Attachment state. */
    state: string | undefined;
    /** Operational status. */
    operationalStatus: string | undefined;
    /** Cloud Router IPv4 address. */
    cloudRouterIpAddress: string | undefined;
    /** Customer router IPv4 address. */
    customerRouterIpAddress: string | undefined;
    /** Cloud Router IPv6 address. */
    cloudRouterIpv6Address: string | undefined;
    /** Customer router IPv6 address. */
    customerRouterIpv6Address: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Partner metadata. */
    partnerMetadata: InterconnectAttachmentPartnerMetadata | undefined;
    /** L2 forwarding config. */
    l2Forwarding: InterconnectAttachmentL2Forwarding | undefined;
    /** Attachment group URL. */
    attachmentGroup: string | undefined;
    /** Server-assigned numeric id. */
    interconnectAttachmentId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** Label fingerprint for `setLabels`. */
    labelFingerprint: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine Interconnect VLAN attachment.
 *
 * VLAN attachments connect a Cloud Router to a Dedicated or Partner
 * Interconnect. Name, region, router, type, interconnect, encryption,
 * VLAN tag, and availability domain are immutable. Description, admin
 * status, bandwidth, MTU, and stack type update in place via
 * `interconnectAttachments.patch`. Labels are applied with `setLabels`
 * after the attachment exists.
 *
 * ### Creating an Interconnect Attachment
 * **Example:** Partner attachment
 * ```typescript
 * const attachment = yield* GCP.Compute.InterconnectAttachment("Vlan", {
 *   region: "us-central1",
 *   router: router.routerName,
 *   type: "PARTNER",
 *   edgeAvailabilityDomain: "AVAILABILITY_DOMAIN_1",
 *   mtu: 1500,
 * });
 * ```
 *
 * **Example:** Dedicated attachment
 * ```typescript
 * const attachment = yield* GCP.Compute.InterconnectAttachment("Vlan", {
 *   interconnectAttachmentName: "app-vlan",
 *   router: router.selfLink,
 *   type: "DEDICATED",
 *   interconnect: interconnect.selfLink,
 *   vlanTag8021q: 100,
 *   bandwidth: "BPS_1G",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const InterconnectAttachment = Resource<InterconnectAttachment>(
  "GCP.Compute.InterconnectAttachment",
);

export class InterconnectAttachmentNotResolved extends Data.TaggedError(
  "GCP.Compute.InterconnectAttachmentNotResolved",
)<{
  interconnectAttachmentName: string;
  region: string;
}> {}

export class InterconnectAttachmentStillExists extends Data.TaggedError(
  "GCP.Compute.InterconnectAttachmentStillExists",
)<{
  interconnectAttachmentName: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "attachment";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_TYPE).toUpperCase();

const encryptionOf = (value: string | undefined) =>
  (value ?? DEFAULT_ENCRYPTION).toUpperCase();

const stackOf = (value: string | undefined) =>
  (value ?? DEFAULT_STACK).toUpperCase();

const routerUrl = (project: string, region: string, value: string) => {
  if (value.includes("/")) return value;
  return `projects/${project}/regions/${region}/routers/${value}`;
};

const interconnectUrl = (project: string, value: string) => {
  if (value.includes("/")) return value;
  return `projects/${project}/global/interconnects/${value}`;
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (
  attachment: compute.InterconnectAttachment,
  project: string,
): InterconnectAttachment["Attributes"] => ({
  interconnectAttachmentName: attachment.name ?? "",
  project,
  region: lastSegment(attachment.region).toLowerCase(),
  router: attachment.router,
  type: attachment.type,
  interconnect: attachment.interconnect,
  description: attachment.description,
  adminEnabled: attachment.adminEnabled !== false,
  bandwidth: attachment.bandwidth,
  mtu: attachment.mtu !== undefined ? Number(attachment.mtu) : undefined,
  stackType: attachment.stackType,
  encryption: attachment.encryption,
  vlanTag8021q: attachment.vlanTag8021q,
  edgeAvailabilityDomain: attachment.edgeAvailabilityDomain,
  pairingKey: attachment.pairingKey,
  state: attachment.state,
  operationalStatus: attachment.operationalStatus,
  cloudRouterIpAddress: attachment.cloudRouterIpAddress,
  customerRouterIpAddress: attachment.customerRouterIpAddress,
  cloudRouterIpv6Address: attachment.cloudRouterIpv6Address,
  customerRouterIpv6Address: attachment.customerRouterIpv6Address,
  labels: userLabels(attachment.labels),
  partnerMetadata: attachment.partnerMetadata,
  l2Forwarding: attachment.l2Forwarding,
  attachmentGroup: attachment.attachmentGroup,
  interconnectAttachmentId: attachment.id,
  selfLink: attachment.selfLink,
  labelFingerprint: attachment.labelFingerprint,
  creationTimestamp: attachment.creationTimestamp,
  kind: attachment.kind,
});

const getByName = (
  project: string,
  region: string,
  interconnectAttachment: string,
) =>
  compute
    .getInterconnectAttachments({
      project,
      region,
      interconnectAttachment,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (
  project: string,
  region: string,
  interconnectAttachmentName: string,
) =>
  getByName(project, region, interconnectAttachmentName).pipe(
    Effect.flatMap((attachment) =>
      attachment !== undefined
        ? Effect.succeed(attachment)
        : Effect.fail(
            new InterconnectAttachmentNotResolved({
              interconnectAttachmentName,
              region,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InterconnectAttachmentNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  interconnectAttachmentName: string,
) =>
  getByName(project, region, interconnectAttachmentName).pipe(
    Effect.flatMap((attachment) =>
      attachment === undefined
        ? Effect.void
        : Effect.fail(
            new InterconnectAttachmentStillExists({
              interconnectAttachmentName,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.InterconnectAttachmentStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag(
      "GCP.Compute.InterconnectAttachmentStillExists",
      () => Effect.void,
    ),
  );

const runOp = <E extends { readonly _tag: string }, R>(
  project: string,
  region: string,
  interconnectAttachmentName: string,
  start: Effect.Effect<compute.Operation, E, R>,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitRegionOperation(project, region, operation, {
        ignore: ignoredCodes(options),
      }),
    ),
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const InterconnectAttachmentProvider = () =>
  Provider.succeed(InterconnectAttachment, {
    stables: [
      "interconnectAttachmentName",
      "project",
      "region",
      "interconnectAttachmentId",
      "selfLink",
      "type",
      "router",
      "interconnect",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName =
        olds?.interconnectAttachmentName ?? output?.interconnectAttachmentName;
      const nextName = news.interconnectAttachmentName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? previousRegion,
        env.region,
      );
      const previousRouter = lastSegment(olds?.router ?? output?.router);
      const nextRouter = lastSegment(news.router);
      const previousType = typeOf(olds?.type ?? output?.type);
      const nextType = typeOf(news.type ?? previousType);
      const previousIx = lastSegment(
        olds?.interconnect ?? output?.interconnect,
      );
      const nextIx = lastSegment(news.interconnect ?? previousIx);
      const previousEnc = encryptionOf(olds?.encryption ?? output?.encryption);
      const nextEnc = encryptionOf(news.encryption ?? previousEnc);
      const previousVlan = olds?.vlanTag8021q ?? output?.vlanTag8021q;
      const nextVlan = news.vlanTag8021q ?? previousVlan;
      const previousDomain =
        olds?.edgeAvailabilityDomain ?? output?.edgeAvailabilityDomain;
      const nextDomain = news.edgeAvailabilityDomain ?? previousDomain;

      const immutableChanged =
        previousRouter !== nextRouter ||
        previousType !== nextType ||
        previousIx !== nextIx ||
        previousEnc !== nextEnc ||
        previousVlan !== nextVlan ||
        previousDomain !== nextDomain;

      if (nameChanged || previousRegion !== nextRegion) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (immutableChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const interconnectAttachmentName = yield* toName(
        id,
        olds?.interconnectAttachmentName,
        output?.interconnectAttachmentName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        interconnectAttachmentName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListInterconnectAttachments
          .pages({
            project: env.project,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.interconnectAttachments ?? [])
              .filter((item) =>
                Object.keys(item.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const interconnectAttachmentName = yield* toName(
        id,
        news.interconnectAttachmentName,
        output?.interconnectAttachmentName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const router = routerUrl(env.project, region, news.router);
      const type = typeOf(news.type);
      const encryption = encryptionOf(news.encryption);
      const stackType = stackOf(news.stackType);
      const adminEnabled = news.adminEnabled !== false;

      let current = yield* getByName(
        env.project,
        region,
        interconnectAttachmentName,
      );

      if (current === undefined) {
        yield* compute
          .insertInterconnectAttachments({
            project: env.project,
            region,
            body: {
              name: interconnectAttachmentName,
              router,
              type,
              interconnect: news.interconnect
                ? interconnectUrl(env.project, news.interconnect)
                : undefined,
              edgeAvailabilityDomain: news.edgeAvailabilityDomain,
              description: news.description,
              adminEnabled,
              bandwidth: news.bandwidth,
              mtu: news.mtu,
              stackType,
              encryption,
              vlanTag8021q: news.vlanTag8021q,
              ipsecInternalAddresses: news.ipsecInternalAddresses,
              partnerMetadata: news.partnerMetadata,
              l2Forwarding: news.l2Forwarding,
              subnetLength: news.subnetLength,
              candidateSubnets: news.candidateSubnets,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* awaitResource(
          env.project,
          region,
          interconnectAttachmentName,
        );
      }

      const observedMtu =
        current.mtu !== undefined ? Number(current.mtu) : undefined;
      const needsPatch =
        (current.description ?? "") !== (news.description ?? "") ||
        (current.adminEnabled !== false) !== adminEnabled ||
        (news.bandwidth !== undefined &&
          (current.bandwidth ?? "") !== news.bandwidth) ||
        (news.mtu !== undefined && observedMtu !== news.mtu) ||
        (news.stackType !== undefined &&
          stackOf(current.stackType) !== stackType) ||
        (news.partnerMetadata !== undefined &&
          JSON.stringify(current.partnerMetadata ?? null) !==
            JSON.stringify(news.partnerMetadata ?? null));

      if (needsPatch) {
        yield* runOp(
          env.project,
          region,
          interconnectAttachmentName,
          compute.patchInterconnectAttachments({
            project: env.project,
            region,
            interconnectAttachment: interconnectAttachmentName,
            body: {
              description: news.description,
              adminEnabled,
              bandwidth: news.bandwidth,
              mtu: news.mtu,
              stackType,
              partnerMetadata: news.partnerMetadata,
            },
          }),
        );
        current =
          (yield* getByName(env.project, region, interconnectAttachmentName)) ??
          current;
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* Effect.gen(function* () {
          const latest =
            (yield* getByName(
              env.project,
              region,
              interconnectAttachmentName,
            )) ?? current;
          if (latest === undefined) {
            return yield* new InterconnectAttachmentNotResolved({
              interconnectAttachmentName,
              region,
            });
          }
          yield* runOp(
            env.project,
            region,
            interconnectAttachmentName,
            compute.setLabelsInterconnectAttachments({
              project: env.project,
              region,
              resource: interconnectAttachmentName,
              body: {
                labels: desiredLabels,
                labelFingerprint: latest.labelFingerprint,
              },
            }),
          );
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 5,
            schedule: Schedule.spaced("1 second"),
          }),
        );
        current =
          (yield* getByName(env.project, region, interconnectAttachmentName)) ??
          current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.interconnectAttachmentName) return;
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      yield* compute
        .deleteInterconnectAttachments({
          project,
          region,
          interconnectAttachment: output.interconnectAttachmentName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitRegionOperation(project, region, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(project, region, output.interconnectAttachmentName);
    }),
  });
