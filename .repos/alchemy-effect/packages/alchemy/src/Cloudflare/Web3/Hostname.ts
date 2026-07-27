import * as web3 from "@distilled.cloud/cloudflare/web3";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Web3.Hostname" as const;
type TypeId = typeof TypeId;

/**
 * The gateway a Web3 hostname resolves through: an Ethereum gateway, an
 * IPFS gateway pinned to a single DNSLink, or an IPFS universal-path
 * gateway that can serve any CID under `/ipfs/...` / `/ipns/...`.
 */
export type HostnameTarget = "ethereum" | "ipfs" | "ipfs_universal_path";

/**
 * Activation status of a Web3 hostname. Hostnames start `pending` until the
 * CNAME is verified at the edge; deletion is asynchronous (`deleting`).
 */
export type HostnameStatus = "active" | "pending" | "deleting" | "error";

export interface HostnameProps {
  /**
   * The zone the hostname is created in. The hostname must be a subdomain
   * of (or equal to) the zone's name.
   *
   * Stable — moving a hostname to another zone triggers a replacement.
   */
  zoneId: string;
  /**
   * The hostname that points to the target gateway via CNAME, e.g.
   * `gateway.example.com`.
   *
   * Immutable — the hostname is the resource's identity and cannot be
   * renamed, so changing it triggers a replacement.
   */
  name: string;
  /**
   * The target gateway of the hostname.
   *
   * Immutable — the API cannot change a hostname's target after creation,
   * so changing it triggers a replacement.
   */
  target: HostnameTarget;
  /**
   * The DNSLink value used when `target` is `ipfs`, e.g.
   * `/ipns/onboarding.ipfs.cloudflare.com`. Mutable — patched in place.
   */
  dnslink?: string;
  /**
   * An optional description of the hostname. Mutable — patched in place.
   */
  description?: string;
}

export interface HostnameAttributes {
  /** Cloudflare-assigned identifier of the Web3 hostname. */
  hostnameId: string;
  /** The zone the hostname belongs to. */
  zoneId: string;
  /** The hostname that points to the target gateway via CNAME. */
  name: string;
  /** The target gateway of the hostname. */
  target: HostnameTarget;
  /** The DNSLink value, if the target is `ipfs`. */
  dnslink: string | undefined;
  /** The hostname's description, if set. */
  description: string | undefined;
  /** Activation status of the hostname. */
  status: HostnameStatus;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type Hostname = Resource<
  TypeId,
  HostnameProps,
  HostnameAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Web3 gateway hostname — serve Ethereum or IPFS content from
 * a hostname on your zone via Cloudflare's distributed web gateways.
 *
 * A hostname's identity is its `name` within the zone; only `dnslink` and
 * `description` are mutable, so changing `name`, `target`, or `zoneId`
 * triggers a replacement. Hostnames activate asynchronously: they start in
 * `pending` status and flip to `active` once the CNAME is verified.
 *
 * Note: Cloudflare has restricted Web3 gateways for new customers — on
 * accounts without the entitlement, creation fails with the typed
 * `Web3HostnameNotEntitled` error.
 *
 * Safety: Web3 hostnames carry no ownership markers. When there is no prior
 * state, `read` scans the zone for an existing hostname with the same name
 * and reports it as `Unowned`, so the engine refuses to take it over unless
 * `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Web3
 * @category Domains & DNS
 * @section IPFS gateway
 * @example IPFS hostname pinned to a DNSLink
 * ```typescript
 * const gateway = yield* Cloudflare.Web3.Hostname("IpfsGateway", {
 *   zoneId: zone.zoneId,
 *   name: "ipfs.example.com",
 *   target: "ipfs",
 *   dnslink: "/ipns/onboarding.ipfs.cloudflare.com",
 *   description: "IPFS gateway for example.com",
 * });
 * ```
 *
 * @example IPFS universal-path gateway
 * ```typescript
 * // Serves any CID under /ipfs/... and /ipns/... paths.
 * const universal = yield* Cloudflare.Web3.Hostname("UniversalGateway", {
 *   zoneId: zone.zoneId,
 *   name: "gateway.example.com",
 *   target: "ipfs_universal_path",
 * });
 * ```
 *
 * @section Ethereum gateway
 * @example Ethereum RPC hostname
 * ```typescript
 * yield* Cloudflare.Web3.Hostname("EthGateway", {
 *   zoneId: zone.zoneId,
 *   name: "eth.example.com",
 *   target: "ethereum",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/web3/
 */
export const Hostname = Resource<Hostname>(TypeId, {
  aliases: ["Cloudflare.Web3Hostname"],
});

/**
 * Returns true if the given value is a Hostname resource.
 */
export const isHostname = (value: unknown): value is Hostname =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const HostnameProvider = () =>
  Provider.succeed(Hostname, {
    stables: ["hostnameId", "zoneId", "name", "target", "createdOn"],

    // Web3 hostnames live inside a zone (`/zones/{id}/web3/hostnames`) with no
    // account-wide enumeration API, so fan out over every zone via
    // `listAllZones` and exhaustively paginate the per-zone list. Zones without
    // the Web3 entitlement (or where the scoped token lacks access) answer
    // `Forbidden` — skip them rather than failing the whole enumeration.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          web3.listHostnames.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? [])
                  .filter((raw) => raw.status !== "deleting")
                  .map((raw): HostnameAttributes => toAttributes(raw, zone.id)),
              ),
            ),
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const o = olds as Partial<HostnameProps>;
      const n = news as HostnameProps;
      const oldName = output?.name ?? o.name;
      const oldTarget = output?.target ?? o.target;
      if (oldName === undefined && oldTarget === undefined) return undefined;
      // The hostname is the resource's identity — no rename API exists.
      if (oldName !== undefined && oldName !== n.name) {
        return { action: "replace" } as const;
      }
      // The target gateway is immutable after creation.
      if (oldTarget !== undefined && oldTarget !== n.target) {
        return { action: "replace" } as const;
      }
      // zoneId is Input<string>; compare only once both are concrete.
      const oldZone = output?.zoneId ?? o.zoneId;
      if (
        typeof oldZone === "string" &&
        typeof n.zoneId === "string" &&
        oldZone !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (zoneId === undefined) return undefined;

      // Owned path: refresh by our persisted hostname id.
      if (output?.hostnameId) {
        const observed = yield* getHostname(zoneId, output.hostnameId);
        if (observed) return toAttributes(observed, zoneId);
      }

      // Cold lookup: a hostname with this name may already exist in the
      // zone. Web3 hostnames carry no ownership markers, so we cannot
      // prove we created it — brand it `Unowned` so the engine refuses
      // to take over unless `adopt` is set.
      const name = output?.name ?? olds?.name;
      if (name !== undefined) {
        const observed = yield* findByName(zoneId, name);
        if (observed) return Unowned(toAttributes(observed, zoneId));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the hostname id cached on `output` is a hint, not a
      //    guarantee: a missing hostname falls through to the name scan
      //    and then to create.
      let observed = output?.hostnameId
        ? yield* getHostname(zoneId, output.hostnameId)
        : undefined;

      // 2. Fall back to scanning the zone for a name match. Ownership has
      //    already been verified upstream — `read` reports existing
      //    hostnames as `Unowned` and the engine gates takeover behind
      //    the adopt policy before reconcile ever runs.
      if (!observed) {
        observed = yield* findByName(zoneId, news.name);
      }

      // 3. Ensure — create when missing. Hostnames activate
      //    asynchronously; return the `pending` state as-is rather than
      //    polling for `active` (activation depends on CNAME/edge
      //    propagation outside our control).
      if (!observed) {
        const created = yield* web3.createHostname({
          zoneId,
          name: news.name,
          target: news.target,
          dnslink: news.dnslink,
          description: news.description,
        });
        return toAttributes(created, zoneId);
      }

      // 4. Sync — diff observed dnslink/description against desired;
      //    skip the patch call entirely on a no-op.
      const dirty =
        (news.dnslink !== undefined &&
          (observed.dnslink ?? undefined) !== news.dnslink) ||
        (news.description !== undefined &&
          (observed.description ?? undefined) !== news.description);
      if (dirty) {
        observed = yield* web3.patchHostname({
          zoneId,
          identifier: observed.id ?? "",
          dnslink: news.dnslink,
          description: news.description,
        });
      }

      return toAttributes(observed, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Deletion is asynchronous (the hostname lingers in `deleting`
      // status); a hostname that is already gone answers 404 with the
      // typed Web3HostnameNotFound tag — treat it as done.
      yield* web3
        .deleteHostname({
          zoneId: output.zoneId,
          identifier: output.hostnameId,
        })
        .pipe(Effect.catchTag("Web3HostnameNotFound", () => Effect.void));
    }),
  });

type ObservedHostname = web3.GetHostnameResponse;

/**
 * Read a hostname by id, mapping "gone" (`Web3HostnameNotFound`, Cloudflare
 * error code 1002 "Hostname does not exist.") to `undefined`. A hostname in
 * `deleting` status is treated as already gone — it cannot be converged.
 */
const getHostname = (zoneId: string, hostnameId: string) =>
  web3.getHostname({ zoneId, identifier: hostnameId }).pipe(
    Effect.map((hostname): ObservedHostname | undefined =>
      hostname.status === "deleting" ? undefined : hostname,
    ),
    Effect.catchTag("Web3HostnameNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a hostname by exact name within the zone. The name is a hostname's
 * identity — Cloudflare rejects duplicates — so at most one (non-deleting)
 * hostname can match.
 */
const findByName = (zoneId: string, name: string) =>
  web3.listHostnames.items({ zoneId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).find(
        (hostname): hostname is ObservedHostname =>
          hostname.name === name && hostname.status !== "deleting",
      ),
    ),
  );

const toAttributes = (
  hostname: ObservedHostname,
  zoneId: string,
): HostnameAttributes => ({
  // Cloudflare always echoes id/name/target/status for a persisted
  // hostname — distilled just types every response field as optional.
  hostnameId: hostname.id ?? "",
  zoneId,
  name: hostname.name ?? "",
  target: (hostname.target ?? "ipfs") as HostnameTarget,
  dnslink: hostname.dnslink ?? undefined,
  description: hostname.description ?? undefined,
  status: (hostname.status ?? "pending") as HostnameStatus,
  createdOn: hostname.createdOn ?? undefined,
  modifiedOn: hostname.modifiedOn ?? undefined,
});
