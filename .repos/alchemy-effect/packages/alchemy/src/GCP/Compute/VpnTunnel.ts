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

const DEFAULT_IKE_VERSION = 2;
const MAX_NAME_LENGTH = 63;

export type VpnTunnelCipherSuitePhase1 = {
  /** Phase 1 encryption algorithms (for example `AES-CBC-256`). */
  encryption?: string[];
  /** Phase 1 integrity algorithms (for example `HMAC-SHA2-256-128`). */
  integrity?: string[];
  /** Phase 1 PRF algorithms (for example `PRF-HMAC-SHA2-256`). */
  prf?: string[];
  /** Phase 1 Diffie-Hellman groups (for example `Group-14`). */
  dh?: string[];
};

export type VpnTunnelCipherSuitePhase2 = {
  /** Phase 2 encryption algorithms (for example `AES-CBC-128`). */
  encryption?: string[];
  /** Phase 2 integrity algorithms (for example `HMAC-SHA2-256-128`). */
  integrity?: string[];
  /** Phase 2 PFS groups (for example `Group-14`). */
  pfs?: string[];
};

export type VpnTunnelCipherSuiteProps = {
  /** Cipher configuration for IKE phase 1. */
  phase1?: VpnTunnelCipherSuitePhase1;
  /** Cipher configuration for IKE phase 2. */
  phase2?: VpnTunnelCipherSuitePhase2;
};

export type VpnTunnelProps = {
  /**
   * Tunnel name. If omitted, a unique RFC1035 name is generated from
   * the stack, stage, and logical id. Immutable — changing it replaces
   * the tunnel.
   */
  vpnTunnelName?: string;
  /**
   * Region the tunnel lives in. Immutable — changing it replaces the
   * tunnel. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Immutable — changing it replaces the tunnel.
   */
  description?: string;
  /**
   * HA VPN gateway this tunnel attaches to. Accepts a name, a partial
   * URL (`regions/{region}/vpnGateways/{name}`), or a full resource URL.
   * Mutually exclusive with `targetVpnGateway`. Immutable.
   */
  vpnGateway?: string;
  /**
   * Interface id on `vpnGateway` (`0` or `1`). Defaults to `0` when
   * `vpnGateway` is set. Immutable.
   */
  vpnGatewayInterface?: number;
  /**
   * Peer HA VPN gateway in another VPC. Exclusive with
   * `peerExternalGateway`. Immutable.
   */
  peerGcpGateway?: string;
  /**
   * Peer external VPN gateway (on-prem / other cloud). Exclusive with
   * `peerGcpGateway`. Immutable.
   */
  peerExternalGateway?: string;
  /**
   * Interface id on `peerExternalGateway` (`0`–`3`). Defaults to `0`
   * when `peerExternalGateway` is set. Immutable.
   */
  peerExternalGatewayInterface?: number;
  /**
   * Classic VPN target gateway. Mutually exclusive with `vpnGateway`.
   * Immutable.
   */
  targetVpnGateway?: string;
  /**
   * Peer VPN gateway IPv4. Classic VPN only. Immutable.
   */
  peerIp?: string;
  /**
   * Cloud Router used for dynamic routing (required for HA VPN).
   * Accepts a name or URL. Immutable.
   */
  router?: string;
  /**
   * IKE pre-shared key (1–96 printable ASCII characters). Write-only —
   * the API never returns it. Immutable — changing it replaces the
   * tunnel.
   */
  sharedSecret: string;
  /**
   * IKE protocol version (`1` or `2`).
   * @default 2
   */
  ikeVersion?: number;
  /**
   * Local traffic selector CIDRs. Classic VPN only (output-only on HA
   * VPN). Immutable.
   */
  localTrafficSelector?: string[];
  /**
   * Remote traffic selector CIDRs. Classic VPN only (output-only on HA
   * VPN). Immutable.
   */
  remoteTrafficSelector?: string[];
  /**
   * User-specified IKE cipher suite. Immutable.
   */
  cipherSuite?: VpnTunnelCipherSuiteProps;
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `setLabels` (labels cannot be set on insert).
   */
  labels?: Record<string, string>;
};

export type VpnTunnel = Resource<
  "GCP.Compute.VpnTunnel",
  VpnTunnelProps,
  {
    /** Tunnel name. */
    vpnTunnelName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Description. */
    description: string | undefined;
    /** HA VPN gateway URL, if this is an HA tunnel. */
    vpnGateway: string | undefined;
    /** HA VPN gateway interface id. */
    vpnGatewayInterface: number | undefined;
    /** Peer HA VPN gateway URL. */
    peerGcpGateway: string | undefined;
    /** Peer external VPN gateway URL. */
    peerExternalGateway: string | undefined;
    /** Peer external VPN gateway interface id. */
    peerExternalGatewayInterface: number | undefined;
    /** Classic VPN target gateway URL. */
    targetVpnGateway: string | undefined;
    /** Peer IPv4 (Classic VPN). */
    peerIp: string | undefined;
    /** Cloud Router URL. */
    router: string | undefined;
    /** IKE protocol version. */
    ikeVersion: number | undefined;
    /** Local traffic selector CIDRs. */
    localTrafficSelector: ReadonlyArray<string>;
    /** Remote traffic selector CIDRs. */
    remoteTrafficSelector: ReadonlyArray<string>;
    /** Configured IKE cipher suite, if any. */
    cipherSuite: VpnTunnelCipherSuiteProps | undefined;
    /** Hash of the shared secret. */
    sharedSecretHash: string | undefined;
    /** Server-reported tunnel status. */
    status: string | undefined;
    /** Human-readable status detail. */
    detailedStatus: string | undefined;
    /** Server-assigned numeric id. */
    vpnTunnelId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine Cloud VPN tunnel.
 *
 * HA VPN tunnels attach to a `VpnGateway` plus a Cloud Router and a
 * peer (`peerExternalGateway` or `peerGcpGateway`). Classic VPN
 * tunnels attach to a `TargetVpnGateway` and a `peerIp`. Labels are
 * the only in-place update (`vpnTunnels.setLabels`); every other
 * field replaces the tunnel.
 *
 * ### Creating an HA VPN tunnel
 * **Example:** HA VPN to an external peer
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const gateway = yield* GCP.Compute.VpnGateway("Gateway", {
 *   network: network.networkName,
 * });
 * const router = yield* GCP.Compute.Router("Edge", {
 *   network: network.networkName,
 *   bgp: { asn: 64514 },
 * });
 * const peer = yield* GCP.Compute.ExternalVpnGateway("Peer", {
 *   redundancyType: "SINGLE_IP_INTERNALLY_REDUNDANT",
 *   interfaces: [{ id: 0, ipAddress: "15.0.0.120" }],
 * });
 * const tunnel = yield* GCP.Compute.VpnTunnel("Tunnel", {
 *   vpnGateway: gateway.vpnGatewayName,
 *   vpnGatewayInterface: 0,
 *   peerExternalGateway: peer.externalVpnGatewayName,
 *   peerExternalGatewayInterface: 0,
 *   router: router.routerName,
 *   sharedSecret: "replace-me-with-a-secret",
 * });
 * ```
 *
 * **Example:** Named tunnel with labels
 * ```typescript
 * const tunnel = yield* GCP.Compute.VpnTunnel("Tunnel", {
 *   vpnTunnelName: "app-tunnel",
 *   region: "us-central1",
 *   vpnGateway: "app-vpn",
 *   vpnGatewayInterface: 0,
 *   peerGcpGateway: "peer-vpn",
 *   router: "app-router",
 *   sharedSecret: "replace-me-with-a-secret",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Classic VPN
 * **Example:** Tunnel on a TargetVpnGateway
 * ```typescript
 * const tunnel = yield* GCP.Compute.VpnTunnel("Tunnel", {
 *   targetVpnGateway: gateway.targetVpnGatewayName,
 *   peerIp: "15.0.0.120",
 *   sharedSecret: "replace-me-with-a-secret",
 *   localTrafficSelector: ["10.0.0.0/16"],
 *   remoteTrafficSelector: ["172.16.0.0/16"],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const VpnTunnel = Resource<VpnTunnel>("GCP.Compute.VpnTunnel");

export class VpnTunnelNotResolved extends Data.TaggedError(
  "GCP.Compute.VpnTunnelNotResolved",
)<{
  vpnTunnelName: string;
  region: string;
}> {}

export class VpnTunnelPending extends Data.TaggedError(
  "GCP.Compute.VpnTunnelPending",
)<{
  vpnTunnelName: string;
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

const ikeVersionOf = (value: number | undefined) =>
  value ?? DEFAULT_IKE_VERSION;

const selectorsKey = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .sort()
    .join(",");

const cipherKey = (suite: VpnTunnelCipherSuiteProps | undefined) =>
  JSON.stringify({
    phase1: {
      encryption: [...(suite?.phase1?.encryption ?? [])].sort(),
      integrity: [...(suite?.phase1?.integrity ?? [])].sort(),
      prf: [...(suite?.phase1?.prf ?? [])].sort(),
      dh: [...(suite?.phase1?.dh ?? [])].sort(),
    },
    phase2: {
      encryption: [...(suite?.phase2?.encryption ?? [])].sort(),
      integrity: [...(suite?.phase2?.integrity ?? [])].sort(),
      pfs: [...(suite?.phase2?.pfs ?? [])].sort(),
    },
  });

const toCipherSuite = (
  suite: compute.VpnTunnelCipherSuite | undefined,
): VpnTunnelCipherSuiteProps | undefined => {
  if (suite === undefined) return undefined;
  const phase1 = suite.phase1;
  const phase2 = suite.phase2;
  if (phase1 === undefined && phase2 === undefined) return undefined;
  return {
    phase1: phase1
      ? {
          encryption: phase1.encryption,
          integrity: phase1.integrity,
          prf: phase1.prf,
          dh: phase1.dh,
        }
      : undefined,
    phase2: phase2
      ? {
          encryption: phase2.encryption,
          integrity: phase2.integrity,
          pfs: phase2.pfs,
        }
      : undefined,
  };
};

const regionalUrl = (
  project: string,
  region: string,
  collection: string,
  value: string,
) => {
  if (value.includes("/")) {
    return value.startsWith("projects/") || value.startsWith("http")
      ? value
      : `projects/${project}/${value.replace(/^\//, "")}`;
  }
  return `projects/${project}/regions/${region}/${collection}/${value}`;
};

const globalUrl = (project: string, collection: string, value: string) => {
  if (value.includes("/")) {
    return value.startsWith("projects/") || value.startsWith("http")
      ? value
      : `projects/${project}/${value.replace(/^\//, "")}`;
  }
  return `projects/${project}/global/${collection}/${value}`;
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
    const rfc = generated.replace(/^[^a-z]+/, "t").replace(/-+$/g, "");
    return rfc.slice(0, MAX_NAME_LENGTH);
  });

const toAttrs = (tunnel: compute.VpnTunnel, project: string) => ({
  vpnTunnelName: tunnel.name ?? "",
  project,
  region: lastSegment(tunnel.region ?? "").toLowerCase(),
  description: tunnel.description,
  vpnGateway: tunnel.vpnGateway,
  vpnGatewayInterface: tunnel.vpnGatewayInterface,
  peerGcpGateway: tunnel.peerGcpGateway,
  peerExternalGateway: tunnel.peerExternalGateway,
  peerExternalGatewayInterface: tunnel.peerExternalGatewayInterface,
  targetVpnGateway: tunnel.targetVpnGateway,
  peerIp: tunnel.peerIp,
  router: tunnel.router,
  ikeVersion: tunnel.ikeVersion,
  localTrafficSelector: tunnel.localTrafficSelector ?? [],
  remoteTrafficSelector: tunnel.remoteTrafficSelector ?? [],
  cipherSuite: toCipherSuite(tunnel.cipherSuite),
  sharedSecretHash: tunnel.sharedSecretHash,
  status: tunnel.status,
  detailedStatus: tunnel.detailedStatus,
  vpnTunnelId: tunnel.id,
  selfLink: tunnel.selfLink,
  labels: userLabels(tunnel.labels),
  creationTimestamp: tunnel.creationTimestamp,
});

const toInsertBody = (
  project: string,
  region: string,
  vpnTunnelName: string,
  news: VpnTunnelProps,
): compute.VpnTunnel => {
  const body: compute.VpnTunnel = {
    name: vpnTunnelName,
    sharedSecret: news.sharedSecret,
    ikeVersion: ikeVersionOf(news.ikeVersion),
    description: news.description,
  };
  if (news.vpnGateway !== undefined) {
    body.vpnGateway = regionalUrl(
      project,
      region,
      "vpnGateways",
      news.vpnGateway,
    );
    body.vpnGatewayInterface = news.vpnGatewayInterface ?? 0;
  }
  if (news.targetVpnGateway !== undefined) {
    body.targetVpnGateway = regionalUrl(
      project,
      region,
      "targetVpnGateways",
      news.targetVpnGateway,
    );
  }
  if (news.peerGcpGateway !== undefined) {
    body.peerGcpGateway = regionalUrl(
      project,
      region,
      "vpnGateways",
      news.peerGcpGateway,
    );
  }
  if (news.peerExternalGateway !== undefined) {
    body.peerExternalGateway = globalUrl(
      project,
      "externalVpnGateways",
      news.peerExternalGateway,
    );
    body.peerExternalGatewayInterface = news.peerExternalGatewayInterface ?? 0;
  }
  if (news.peerIp !== undefined) {
    body.peerIp = news.peerIp;
  }
  if (news.router !== undefined) {
    body.router = regionalUrl(project, region, "routers", news.router);
  }
  if (news.localTrafficSelector !== undefined) {
    body.localTrafficSelector = news.localTrafficSelector;
  }
  if (news.remoteTrafficSelector !== undefined) {
    body.remoteTrafficSelector = news.remoteTrafficSelector;
  }
  if (news.cipherSuite !== undefined) {
    body.cipherSuite = news.cipherSuite;
  }
  return body;
};

const getByName = (project: string, region: string, vpnTunnel: string) =>
  compute
    .getVpnTunnels({ project, region, vpnTunnel })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const requireTunnel = (
  project: string,
  region: string,
  vpnTunnelName: string,
) =>
  getByName(project, region, vpnTunnelName).pipe(
    Effect.flatMap((tunnel) =>
      tunnel
        ? Effect.succeed(tunnel)
        : Effect.fail(new VpnTunnelNotResolved({ vpnTunnelName, region })),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.VpnTunnelNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  vpnTunnelName: string,
) =>
  getByName(project, region, vpnTunnelName).pipe(
    Effect.flatMap((tunnel) =>
      tunnel === undefined
        ? Effect.void
        : Effect.fail(
            new VpnTunnelPending({
              vpnTunnelName,
              status: "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.VpnTunnelPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const VpnTunnelProvider = () =>
  Provider.succeed(VpnTunnel, {
    stables: [
      "vpnTunnelName",
      "project",
      "region",
      "vpnGateway",
      "vpnGatewayInterface",
      "peerGcpGateway",
      "peerExternalGateway",
      "peerExternalGatewayInterface",
      "targetVpnGateway",
      "peerIp",
      "router",
      "ikeVersion",
      "vpnTunnelId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName = olds.vpnTunnelName ?? output?.vpnTunnelName;
      const nextName = news.vpnTunnelName ?? previousName;
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

      const previousDescription = olds.description ?? output?.description ?? "";
      const previousVpnGateway = resourceRefOf(
        olds.vpnGateway ?? output?.vpnGateway,
      );
      const previousVpnGatewayInterface =
        olds.vpnGatewayInterface ?? output?.vpnGatewayInterface ?? 0;
      const previousPeerGcp = resourceRefOf(
        olds.peerGcpGateway ?? output?.peerGcpGateway,
      );
      const previousPeerExternal = resourceRefOf(
        olds.peerExternalGateway ?? output?.peerExternalGateway,
      );
      const previousPeerExternalInterface =
        olds.peerExternalGatewayInterface ??
        output?.peerExternalGatewayInterface ??
        0;
      const previousTarget = resourceRefOf(
        olds.targetVpnGateway ?? output?.targetVpnGateway,
      );
      const previousPeerIp = olds.peerIp ?? output?.peerIp ?? "";
      const previousRouter = resourceRefOf(olds.router ?? output?.router);
      const previousIke = ikeVersionOf(olds.ikeVersion ?? output?.ikeVersion);
      const previousLocal = selectorsKey(
        olds.localTrafficSelector ?? output?.localTrafficSelector,
      );
      const previousRemote = selectorsKey(
        olds.remoteTrafficSelector ?? output?.remoteTrafficSelector,
      );
      const previousCipher = cipherKey(olds.cipherSuite ?? output?.cipherSuite);

      const immutableChanged =
        (news.description !== undefined &&
          (news.description ?? "") !== previousDescription) ||
        (news.vpnGateway !== undefined &&
          resourceRefOf(news.vpnGateway) !== previousVpnGateway) ||
        (news.vpnGatewayInterface !== undefined &&
          news.vpnGatewayInterface !== previousVpnGatewayInterface) ||
        (news.peerGcpGateway !== undefined &&
          resourceRefOf(news.peerGcpGateway) !== previousPeerGcp) ||
        (news.peerExternalGateway !== undefined &&
          resourceRefOf(news.peerExternalGateway) !== previousPeerExternal) ||
        (news.peerExternalGatewayInterface !== undefined &&
          news.peerExternalGatewayInterface !==
            previousPeerExternalInterface) ||
        (news.targetVpnGateway !== undefined &&
          resourceRefOf(news.targetVpnGateway) !== previousTarget) ||
        (news.peerIp !== undefined && news.peerIp !== previousPeerIp) ||
        (news.router !== undefined &&
          resourceRefOf(news.router) !== previousRouter) ||
        (news.ikeVersion !== undefined &&
          ikeVersionOf(news.ikeVersion) !== previousIke) ||
        (olds.sharedSecret !== undefined &&
          news.sharedSecret !== olds.sharedSecret) ||
        (news.localTrafficSelector !== undefined &&
          selectorsKey(news.localTrafficSelector) !== previousLocal) ||
        (news.remoteTrafficSelector !== undefined &&
          selectorsKey(news.remoteTrafficSelector) !== previousRemote) ||
        (news.cipherSuite !== undefined &&
          cipherKey(news.cipherSuite) !== previousCipher);

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
      const vpnTunnelName = yield* toName(
        id,
        olds?.vpnTunnelName,
        output?.vpnTunnelName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(env.project, region, vpnTunnelName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListVpnTunnels
          .pages({
            project: env.project,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.vpnTunnels ?? [])
              .filter((tunnel) =>
                Object.keys(tunnel.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((tunnel) => toAttrs(tunnel, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const vpnTunnelName = yield* toName(
        id,
        news.vpnTunnelName,
        output?.vpnTunnelName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, region, vpnTunnelName);

      if (current === undefined) {
        const created = yield* compute
          .insertVpnTunnels({
            project: env.project,
            region,
            body: toInsertBody(env.project, region, vpnTunnelName, news),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }).pipe(
                Effect.flatMap(() =>
                  requireTunnel(env.project, region, vpnTunnelName),
                ),
              ),
            ),
            Effect.catchTag("Conflict", () =>
              getByName(env.project, region, vpnTunnelName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new VpnTunnelNotResolved({ vpnTunnelName, region });
      }

      const resolved = current;
      const observedLabels = tagRecord(resolved.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* Effect.gen(function* () {
          const latest =
            (yield* getByName(env.project, region, vpnTunnelName)) ?? resolved;
          yield* compute
            .setLabelsVpnTunnels({
              project: env.project,
              region,
              resource: vpnTunnelName,
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
          (yield* getByName(env.project, region, vpnTunnelName)) ?? resolved;
      }

      return toAttrs(current ?? resolved, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      if (!output.vpnTunnelName) return;
      yield* compute
        .deleteVpnTunnels({
          project,
          region,
          vpnTunnel: output.vpnTunnelName,
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
      yield* waitUntilGone(project, region, output.vpnTunnelName);
    }),
  });
