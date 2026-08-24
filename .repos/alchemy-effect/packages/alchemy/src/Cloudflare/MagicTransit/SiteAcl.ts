import * as magicTransit from "@distilled.cloud/cloudflare/magic-transit";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.MagicTransit.SiteAcl" as const;
type TypeId = typeof TypeId;

/**
 * Protocols a Magic WAN site ACL can match.
 */
export type MagicSiteAclProtocol = "tcp" | "udp" | "icmp";

/**
 * One side of a Magic WAN site ACL — selects a LAN and optionally narrows
 * the match to specific ports, port ranges, and subnets.
 */
export interface MagicSiteAclLan {
  /** The LAN identifier this side of the ACL applies to. */
  lanId: string;
  /** Display name of the LAN (informational). */
  lanName?: string;
  /** Specific ports to match. */
  ports?: number[];
  /** Port ranges to match, e.g. `"8080-8090"`. */
  portRanges?: string[];
  /** Subnets to match (IPv4 CIDR or address). */
  subnets?: string[];
}

export interface MagicSiteAclProps {
  /**
   * The site this ACL belongs to. Changing it triggers a replacement.
   */
  siteId: string;
  /**
   * The name of the ACL.
   */
  name: string;
  /**
   * The first LAN of the ACL pair.
   */
  lan1: MagicSiteAclLan;
  /**
   * The second LAN of the ACL pair.
   */
  lan2: MagicSiteAclLan;
  /**
   * Description for the ACL.
   */
  description?: string;
  /**
   * If `true`, traffic is forwarded locally on the Magic Connector; if
   * `false`, traffic is forwarded to Cloudflare.
   * @default false
   */
  forwardLocally?: boolean;
  /**
   * Protocols the ACL matches. Omit to match all protocols.
   */
  protocols?: MagicSiteAclProtocol[];
  /**
   * If `true`, the policy allows traffic in one direction only
   * (lan1 → lan2); if `false`, traffic is bidirectional.
   * @default false
   */
  unidirectional?: boolean;
}

export interface MagicSiteAclAttributes {
  /** Cloudflare-assigned identifier of the ACL. */
  aclId: string;
  /** The site the ACL belongs to. */
  siteId: string;
  /** The Cloudflare account the ACL belongs to. */
  accountId: string;
  /** The name of the ACL. */
  name: string;
  /** The ACL description, if set. */
  description: string | undefined;
  /** Whether traffic is forwarded locally on the connector. */
  forwardLocally: boolean | undefined;
  /** Protocols the ACL matches, if narrowed. */
  protocols: MagicSiteAclProtocol[] | undefined;
  /** Whether the ACL is unidirectional. */
  unidirectional: boolean | undefined;
}

export type MagicSiteAcl = Resource<
  TypeId,
  MagicSiteAclProps,
  MagicSiteAclAttributes,
  never,
  Providers
>;

/**
 * An ACL between two LANs of a Magic WAN site — allows traffic between
 * LAN segments behind a Magic WAN Connector (all inter-LAN traffic is
 * denied by default).
 *
 * Requires a Magic WAN subscription — accounts without it receive a typed
 * `MagicWanUnauthorized` error (Cloudflare code 1025).
 *
 * `siteId` is create-only — changing it triggers a replacement. Everything
 * else is updated in place.
 * @resource
 * @product Magic Transit
 * @category Network
 * @section Creating an ACL
 * @example Allow TCP between two LANs
 * ```typescript
 * yield* Cloudflare.MagicTransit.MagicSiteAcl("lan-to-lan", {
 *   siteId: site.siteId,
 *   name: "office-to-lab",
 *   lan1: { lanId: officeLan.lanId, ports: [443] },
 *   lan2: { lanId: labLan.lanId },
 *   protocols: ["tcp"],
 * });
 * ```
 *
 * @example Unidirectional ACL forwarded locally
 * ```typescript
 * yield* Cloudflare.MagicTransit.MagicSiteAcl("one-way", {
 *   siteId: site.siteId,
 *   name: "sensors-to-collector",
 *   lan1: { lanId: sensorsLan.lanId },
 *   lan2: { lanId: collectorLan.lanId, ports: [9000] },
 *   unidirectional: true,
 *   forwardLocally: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/magic-wan/configuration/connector/network-options/site-acls/
 */
export const MagicSiteAcl = Resource<MagicSiteAcl>(TypeId);

/**
 * Returns true if the given value is a MagicSiteAcl resource.
 */
export const isMagicSiteAcl = (value: unknown): value is MagicSiteAcl =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const MagicSiteAclProvider = () =>
  Provider.succeed(MagicSiteAcl, {
    stables: ["aclId", "siteId", "accountId"],

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds === undefined) return undefined;
      // ACLs cannot move between sites.
      if (
        typeof olds.siteId === "string" &&
        typeof news.siteId === "string" &&
        olds.siteId !== news.siteId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const siteId =
        output?.siteId ??
        (typeof olds?.siteId === "string" ? olds.siteId : undefined);
      if (!siteId) return undefined;

      if (output?.aclId) {
        const observed = yield* getAcl(acct, siteId, output.aclId);
        if (observed) return toAttributes(observed, siteId, acct);
      }
      // Cold read — match by name within the site. ACLs carry no
      // ownership markers; report as Unowned so takeover is gated behind
      // the adopt policy.
      const name = output?.name ?? olds?.name;
      if (name) {
        const observed = yield* findByName(acct, siteId, name);
        if (observed) return Unowned(toAttributes(observed, siteId, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete strings by Plan.
      const siteId = news.siteId as string;
      const lan1 = toLanRequest(news.lan1);
      const lan2 = toLanRequest(news.lan2);

      // Observe — the id on `output` is a hint; fall back to a name scan.
      let observed = output?.aclId
        ? yield* getAcl(accountId, siteId, output.aclId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, siteId, news.name);
      }

      // Ensure — create when missing.
      if (!observed) {
        const created = yield* magicTransit.createSiteAcl({
          accountId,
          siteId,
          name: news.name,
          lan_1: lan1,
          lan_2: lan2,
          description: news.description,
          forwardLocally: news.forwardLocally,
          protocols: news.protocols,
          unidirectional: news.unidirectional,
        });
        return toAttributes(created, siteId, accountId);
      }

      // Sync — the update API is a PUT; send the full desired state, but
      // skip the call entirely on a no-op.
      const dirty =
        (observed.name ?? undefined) !== news.name ||
        (news.description !== undefined &&
          (observed.description ?? undefined) !== news.description) ||
        (news.forwardLocally !== undefined &&
          (observed.forwardLocally ?? false) !== news.forwardLocally) ||
        (news.unidirectional !== undefined &&
          (observed.unidirectional ?? false) !== news.unidirectional) ||
        (news.protocols !== undefined &&
          !sameList(observed.protocols, news.protocols)) ||
        lanDirty(observed.lan_1, lan1) ||
        lanDirty(observed.lan_2, lan2);
      if (dirty) {
        const updated = yield* magicTransit.updateSiteAcl({
          accountId,
          siteId,
          aclId: observed.id!,
          name: news.name,
          lan_1: lan1,
          lan_2: lan2,
          description: news.description,
          forwardLocally: news.forwardLocally,
          protocols: news.protocols,
          unidirectional: news.unidirectional,
        });
        observed = { ...updated, id: updated.id ?? observed.id };
      }

      return toAttributes(observed, siteId, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* magicTransit
        .deleteSiteAcl({
          accountId: output.accountId,
          siteId: output.siteId,
          aclId: output.aclId,
        })
        .pipe(Effect.catchTag("SiteAclNotFound", () => Effect.void));
    }),

    // Parent fan-out: ACLs are sub-resources keyed by site, and there is no
    // account-wide ACL enumeration API. Enumerate every Magic site (account
    // scope), then list ACLs per site with bounded concurrency, paginating
    // each list exhaustively. Magic WAN-gated accounts (and partial-scope
    // tokens) reject these routes with the typed `MagicWanUnauthorized`
    // (code 1025) / `Forbidden` tags — treat those as "nothing to list".
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const siteIds = yield* magicTransit.listSites.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).flatMap((site) => (site.id ? [site.id] : [])),
          ),
        ),
        Effect.catchTag(["MagicWanUnauthorized", "Forbidden"], () =>
          Effect.succeed([] as string[]),
        ),
      );

      const rows = yield* Effect.forEach(
        siteIds,
        (siteId) =>
          magicTransit.listSiteAcls.pages({ accountId, siteId }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((acl) =>
                  toAttributes(acl, siteId, accountId),
                ),
              ),
            ),
            // Site vanished or became inaccessible mid-enumeration — skip it.
            Effect.catchTag(["MagicWanUnauthorized", "Forbidden"], () =>
              Effect.succeed([] as MagicSiteAclAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );

      return rows.flat();
    }),
  });

interface ObservedAclLan {
  lanId: string;
  lanName?: string | null;
  ports?: number[] | null;
  portRanges?: string[] | null;
  subnets?: string[] | null;
}

interface ObservedAcl {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  forwardLocally?: boolean | null;
  protocols?: string[] | null;
  unidirectional?: boolean | null;
  lan_1?: ObservedAclLan | null;
  lan_2?: ObservedAclLan | null;
}

interface AclLanRequest {
  lanId: string;
  lanName?: string;
  ports?: number[];
  portRanges?: string[];
  subnets?: string[];
}

/**
 * Read an ACL by id, mapping "gone" (`SiteAclNotFound`, HTTP 404) to
 * `undefined`.
 */
const getAcl = (accountId: string, siteId: string, aclId: string) =>
  magicTransit.getSiteAcl({ accountId, siteId, aclId }).pipe(
    Effect.map((acl): ObservedAcl | undefined => acl),
    Effect.catchTag("SiteAclNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find an ACL by exact name within a site. Names are not enforced unique;
 * pick the first match deterministically by id.
 */
const findByName = (accountId: string, siteId: string, name: string) =>
  magicTransit.listSiteAcls({ accountId, siteId }).pipe(
    Effect.map((r): ObservedAcl | undefined =>
      r.result
        .filter((acl) => acl.name === name)
        .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))
        .at(0),
    ),
  );

const toLanRequest = (lan: MagicSiteAclLan): AclLanRequest => ({
  // Inputs have been resolved to concrete strings by Plan.
  lanId: lan.lanId as string,
  lanName: lan.lanName,
  ports: lan.ports,
  portRanges: lan.portRanges,
  subnets: lan.subnets,
});

const sameList = (
  a: readonly (string | number)[] | null | undefined,
  b: readonly (string | number)[] | undefined,
): boolean =>
  [...(a ?? [])].sort().join(",") === [...(b ?? [])].sort().join(",");

const lanDirty = (
  observed: ObservedAclLan | null | undefined,
  desired: AclLanRequest,
): boolean =>
  (observed?.lanId ?? undefined) !== desired.lanId ||
  (desired.ports !== undefined && !sameList(observed?.ports, desired.ports)) ||
  (desired.portRanges !== undefined &&
    !sameList(observed?.portRanges, desired.portRanges)) ||
  (desired.subnets !== undefined &&
    !sameList(observed?.subnets, desired.subnets));

const toAttributes = (
  acl: ObservedAcl,
  siteId: string,
  accountId: string,
): MagicSiteAclAttributes => ({
  aclId: acl.id ?? "",
  siteId,
  accountId,
  name: acl.name ?? "",
  description: acl.description ?? undefined,
  forwardLocally: acl.forwardLocally ?? undefined,
  protocols: acl.protocols
    ? acl.protocols.map((p) => p as MagicSiteAclProtocol)
    : undefined,
  unidirectional: acl.unidirectional ?? undefined,
});
