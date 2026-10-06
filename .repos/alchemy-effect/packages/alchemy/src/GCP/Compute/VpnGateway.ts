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

const DEFAULT_GATEWAY_IP_VERSION = "IPV4";
const DEFAULT_STACK_TYPE = "IPV4_ONLY";
const MAX_NAME_LENGTH = 63;

export type VpnGatewayInterfaceProps = {
  /**
   * Interface id (`0` or `1`). Required when attaching a VLAN
   * attachment for HA VPN over Cloud Interconnect.
   */
  id?: number;
  /**
   * VLAN attachment URL for HA VPN over Cloud Interconnect. Immutable —
   * changing it replaces the gateway.
   */
  interconnectAttachment?: string;
};

export type VpnGatewayInterface = {
  /** Numeric interface id (`0` or `1`). */
  id: number | undefined;
  /** Regional external or internal IPv4 address. */
  ipAddress: string | undefined;
  /** Regional external IPv6 address, if any. */
  ipv6Address: string | undefined;
  /** VLAN attachment URL, if this interface is over Cloud Interconnect. */
  interconnectAttachment: string | undefined;
};

export type VpnGatewayProps = {
  /**
   * Gateway name. If omitted, a unique RFC1035 name is generated from
   * the stack, stage, and logical id. Immutable — changing it replaces
   * the gateway.
   */
  vpnGatewayName?: string;
  /**
   * Region the HA VPN gateway lives in. Immutable — changing it
   * replaces the gateway. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * VPC network this gateway is attached to. Accepts a name
   * (`default`), a partial URL (`global/networks/default`), or a full
   * resource URL. Immutable — changing it replaces the gateway.
   */
  network: string;
  /**
   * Optional description. Immutable — changing it replaces the
   * gateway.
   */
  description?: string;
  /**
   * IP family of the gateway interface addresses (`IPV4` or `IPV6`).
   * Immutable — changing it replaces the gateway.
   * @default "IPV4"
   */
  gatewayIpVersion?: compute.VpnGatewayGatewayIpVersionEnum | (string & {});
  /**
   * IP stack enabled on the gateway (`IPV4_ONLY`, `IPV4_IPV6`,
   * `IPV6_ONLY`). Immutable — changing it replaces the gateway.
   * @default "IPV4_ONLY"
   */
  stackType?: compute.VpnGatewayStackTypeEnum | (string & {});
  /**
   * VPN interfaces. Omit for a regular HA VPN (GCP allocates two
   * regional external IPs). Set `interconnectAttachment` for HA VPN
   * over Cloud Interconnect. Immutable — changing it replaces the
   * gateway.
   */
  vpnInterfaces?: VpnGatewayInterfaceProps[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `setLabels` (labels cannot be set on insert).
   */
  labels?: Record<string, string>;
};

export type VpnGateway = Resource<
  "GCP.Compute.VpnGateway",
  VpnGatewayProps,
  {
    /** Gateway name. */
    vpnGatewayName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Network URL. */
    network: string | undefined;
    /** Server-assigned numeric id. */
    vpnGatewayId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Gateway interface IP family. */
    gatewayIpVersion: string | undefined;
    /** Enabled IP stack. */
    stackType: string | undefined;
    /** VPN interfaces (ids, IPs, optional VLAN attachments). */
    vpnInterfaces: ReadonlyArray<VpnGatewayInterface>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine HA VPN gateway.
 *
 * HA VPN is a high-availability Cloud VPN that attaches two interfaces
 * to a VPC in a single region. Labels are the only in-place update
 * (`vpnGateways.setLabels`); name, region, network, description, IP
 * version, stack type, and interconnect attachments replace the
 * gateway.
 *
 * ### Creating a VpnGateway
 * **Example:** Generated name on a custom VPC
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const gateway = yield* GCP.Compute.VpnGateway("Gateway", {
 *   network: network.networkName,
 * });
 * ```
 *
 * **Example:** Named gateway with labels
 * ```typescript
 * const gateway = yield* GCP.Compute.VpnGateway("Gateway", {
 *   vpnGatewayName: "app-vpn",
 *   region: "us-central1",
 *   network: "default",
 *   description: "ha vpn",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Dual-stack HA VPN
 * **Example:** IPv4/IPv6 stack
 * ```typescript
 * const gateway = yield* GCP.Compute.VpnGateway("Gateway", {
 *   network: "default",
 *   stackType: "IPV4_IPV6",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const VpnGateway = Resource<VpnGateway>("GCP.Compute.VpnGateway");

export class VpnGatewayNotResolved extends Data.TaggedError(
  "GCP.Compute.VpnGatewayNotResolved",
)<{
  vpnGatewayName: string;
  region: string;
}> {}

export class VpnGatewayPending extends Data.TaggedError(
  "GCP.Compute.VpnGatewayPending",
)<{
  vpnGatewayName: string;
  status: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

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

const gatewayIpVersionOf = (value: string | undefined) =>
  value ?? DEFAULT_GATEWAY_IP_VERSION;

const stackTypeOf = (value: string | undefined) => value ?? DEFAULT_STACK_TYPE;

const networkUrl = (project: string, network: string) => {
  if (network.includes("/")) {
    return network.startsWith("projects/") || network.startsWith("http")
      ? network
      : `projects/${project}/${network.replace(/^\//, "")}`;
  }
  return `projects/${project}/global/networks/${network}`;
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
    const rfc = generated.replace(/^[^a-z]+/, "v").replace(/-+$/g, "");
    return rfc.slice(0, MAX_NAME_LENGTH);
  });

const toInterfaces = (
  interfaces: compute.VpnGatewayVpnGatewayInterfaceList | undefined,
): VpnGatewayInterface[] =>
  (interfaces ?? []).map((iface) => ({
    id: iface.id,
    ipAddress: iface.ipAddress,
    ipv6Address: iface.ipv6Address,
    interconnectAttachment: iface.interconnectAttachment,
  }));

const attachmentKey = (
  interfaces: ReadonlyArray<{
    id?: number;
    interconnectAttachment?: string;
  }>,
) =>
  interfaces
    .map(
      (iface) =>
        `${iface.id ?? ""}:${resourceRefOf(iface.interconnectAttachment)}`,
    )
    .sort()
    .join("|");

const toAttrs = (gateway: compute.VpnGateway, project: string) => ({
  vpnGatewayName: gateway.name ?? "",
  project,
  region: lastSegment(gateway.region ?? "").toLowerCase(),
  network: gateway.network,
  vpnGatewayId: gateway.id,
  selfLink: gateway.selfLink,
  description: gateway.description,
  gatewayIpVersion: gateway.gatewayIpVersion,
  stackType: gateway.stackType,
  vpnInterfaces: toInterfaces(gateway.vpnInterfaces),
  labels: userLabels(gateway.labels),
  creationTimestamp: gateway.creationTimestamp,
});

const getByName = (project: string, region: string, vpnGateway: string) =>
  compute
    .getVpnGateways({ project, region, vpnGateway })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const requireGateway = (
  project: string,
  region: string,
  vpnGatewayName: string,
) =>
  getByName(project, region, vpnGatewayName).pipe(
    Effect.flatMap((gateway) =>
      gateway
        ? Effect.succeed(gateway)
        : Effect.fail(new VpnGatewayNotResolved({ vpnGatewayName, region })),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.VpnGatewayNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  vpnGatewayName: string,
) =>
  getByName(project, region, vpnGatewayName).pipe(
    Effect.flatMap((gateway) =>
      gateway === undefined
        ? Effect.void
        : Effect.fail(
            new VpnGatewayPending({
              vpnGatewayName,
              status: "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.VpnGatewayPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const VpnGatewayProvider = () =>
  Provider.succeed(VpnGateway, {
    stables: [
      "vpnGatewayName",
      "project",
      "region",
      "network",
      "vpnGatewayId",
      "selfLink",
      "gatewayIpVersion",
      "stackType",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds.vpnGatewayName ?? output?.vpnGatewayName;
      const nextName = news.vpnGatewayName ?? previousName;
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

      const previousNetwork = resourceRefOf(olds.network ?? output?.network);
      const nextNetwork = resourceRefOf(news.network);
      const previousDescription = olds.description ?? output?.description ?? "";
      const previousIpVersion = gatewayIpVersionOf(
        olds.gatewayIpVersion ?? output?.gatewayIpVersion,
      );
      const previousStack = stackTypeOf(olds.stackType ?? output?.stackType);
      const previousAttachments = attachmentKey(
        output?.vpnInterfaces ?? olds.vpnInterfaces ?? [],
      );

      const immutableChanged =
        nextNetwork !== previousNetwork ||
        (news.description !== undefined &&
          (news.description ?? "") !== previousDescription) ||
        (news.gatewayIpVersion !== undefined &&
          gatewayIpVersionOf(news.gatewayIpVersion) !== previousIpVersion) ||
        (news.stackType !== undefined &&
          stackTypeOf(news.stackType) !== previousStack) ||
        (news.vpnInterfaces !== undefined &&
          attachmentKey(news.vpnInterfaces) !== previousAttachments);

      if (nameChanged || regionChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (immutableChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const vpnGatewayName = yield* toName(
        id,
        olds?.vpnGatewayName,
        output?.vpnGatewayName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, vpnGatewayName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListVpnGateways
          .pages({
            project: env.project,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.vpnGateways ?? [])
              .filter((gateway) =>
                Object.keys(gateway.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((gateway) => toAttrs(gateway, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const vpnGatewayName = yield* toName(
        id,
        news.vpnGatewayName,
        output?.vpnGatewayName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, region, vpnGatewayName);

      if (current === undefined) {
        const body: compute.VpnGateway = {
          name: vpnGatewayName,
          network: networkUrl(env.project, news.network),
          description: news.description,
          gatewayIpVersion: news.gatewayIpVersion,
          stackType: news.stackType,
        };
        if (news.vpnInterfaces !== undefined && news.vpnInterfaces.length > 0) {
          body.vpnInterfaces = news.vpnInterfaces.map((iface) => ({
            id: iface.id,
            interconnectAttachment: iface.interconnectAttachment,
          }));
        }
        const created = yield* compute
          .insertVpnGateways({
            project: env.project,
            region,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }).pipe(
                Effect.flatMap(() =>
                  requireGateway(env.project, region, vpnGatewayName),
                ),
              ),
            ),
            Effect.catchTag("Conflict", () =>
              getByName(env.project, region, vpnGatewayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new VpnGatewayNotResolved({ vpnGatewayName, region });
      }

      const resolved = current;
      const observedLabels = tagRecord(resolved.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* Effect.gen(function* () {
          const latest =
            (yield* getByName(env.project, region, vpnGatewayName)) ?? resolved;
          yield* compute
            .setLabelsVpnGateways({
              project: env.project,
              region,
              resource: vpnGatewayName,
              body: {
                labels: desiredLabels,
                labelFingerprint: latest.labelFingerprint,
              },
            })
            .pipe(
              Effect.flatMap((operation) =>
                waitRegionOperation(env.project, region, operation),
              ),
            );
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 5,
            schedule: Schedule.spaced("1 second"),
          }),
        );
        current =
          (yield* getByName(env.project, region, vpnGatewayName)) ?? resolved;
      }

      return toAttrs(current ?? resolved, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      if (!output.vpnGatewayName) return;
      yield* compute
        .deleteVpnGateways({
          project,
          region,
          vpnGateway: output.vpnGatewayName,
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
      yield* waitUntilGone(project, region, output.vpnGatewayName);
    }),
  });
