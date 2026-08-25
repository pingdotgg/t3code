import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.DNS.ZoneTransferAcl" as const;
type TypeId = typeof TypeId;

export interface ZoneTransferAclProps {
  /**
   * Human-readable name of the ACL. If omitted, a unique name is
   * generated from the app, stage, and logical ID.
   *
   * Mutable — updated in place (PUT).
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Allowed IPv4/IPv6 address range of primary or secondary
   * nameservers, applied account-wide. Used to allow additional NOTIFY
   * IPs for secondary zones and IPs Cloudflare allows AXFR/IXFR
   * requests from for outgoing transfers. CIDRs are limited to a
   * maximum of /24 for IPv4 and /64 for IPv6. Note that Cloudflare
   * normalizes the range to its network address (e.g. `192.0.2.53/28`
   * becomes `192.0.2.48/28`).
   *
   * Mutable — updated in place (PUT).
   */
  ipRange: string;
}

export interface ZoneTransferAclAttributes {
  /** Identifier of the ACL. */
  aclId: string;
  /** The Cloudflare account the ACL belongs to. */
  accountId: string;
  /** Human-readable name of the ACL. */
  name: string;
  /** Allowed IP range, as normalized by Cloudflare. */
  ipRange: string;
}

export type ZoneTransferAcl = Resource<
  TypeId,
  ZoneTransferAclProps,
  ZoneTransferAclAttributes,
  never,
  Providers
>;

/**
 * A Secondary DNS zone-transfer ACL
 * (`/accounts/{account_id}/secondary_dns/acls`) — an account-wide
 * IPv4/IPv6 range that may receive NOTIFYs for secondary zones and from
 * which Cloudflare accepts AXFR/IXFR requests for outgoing transfers.
 *
 * Requires the Secondary DNS (zone transfer) entitlement on the
 * account. Both `name` and `ipRange` are mutable in place.
 * @resource
 * @product DNS
 * @category Domains & DNS
 * @section Creating an ACL
 * @example Allow a primary nameserver range
 * ```typescript
 * const acl = yield* Cloudflare.DNS.ZoneTransferAcl("PrimaryNs", {
 *   ipRange: "192.0.2.48/28",
 * });
 * ```
 *
 * @example ACL with an explicit name
 * ```typescript
 * const acl = yield* Cloudflare.DNS.ZoneTransferAcl("PrimaryNs", {
 *   name: "primary-nameservers",
 *   ipRange: "2001:db8::/64",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/dns/zone-setups/zone-transfers/
 */
export const ZoneTransferAcl = Resource<ZoneTransferAcl>(TypeId, {
  aliases: ["Cloudflare.Dns.ZoneTransferAcl"],
});

/**
 * Returns true if the given value is a ZoneTransferAcl resource.
 */
export const isZoneTransferAcl = (value: unknown): value is ZoneTransferAcl =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ZoneTransferAclProvider = () =>
  Provider.succeed(ZoneTransferAcl, {
    stables: ["aclId", "accountId"],

    // Account-scoped collection: enumerate every ACL in the ambient
    // account, paginating exhaustively, and hydrate into the exact `read`
    // Attributes shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* dns.listZoneTransferAcls.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map(
              (acl): ZoneTransferAclAttributes => ({
                aclId: acl.id,
                accountId,
                name: acl.name,
                ipRange: acl.ipRange,
              }),
            ),
          ),
        ),
      );
    }),

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output !== undefined && output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.aclId) {
        const observed = yield* getAcl(acct, output.aclId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the
      // deterministic physical name. ACLs carry no ownership markers,
      // so gate takeover behind adoption.
      const name = yield* createAclName(id, olds?.name);
      const match = yield* findByName(acct, name);
      return match ? Unowned(toAttributes(match, acct)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createAclName(id, news.name);
      // Inputs are resolved to concrete values by Plan.
      const ipRange = news.ipRange as string;

      // Observe — the id cached on `output` is a hint, not a guarantee.
      const observed = output?.aclId
        ? yield* getAcl(output.accountId ?? accountId, output.aclId)
        : undefined;

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete). Names are not
        // unique on Cloudflare's side, so there is no AlreadyExists
        // race to tolerate.
        const created = yield* dns.createZoneTransferAcl({
          accountId,
          name,
          ipRange,
        });
        return toAttributes(created, accountId);
      }

      // Sync — the update API is a PUT with the full body; skip the
      // call entirely when nothing differs. Cloudflare normalizes
      // `ipRange` to the network address, so compare against the
      // observed (normalized) value.
      if (observed.name === name && observed.ipRange === ipRange) {
        return toAttributes(observed, output?.accountId ?? accountId);
      }
      const updated = yield* dns.updateZoneTransferAcl({
        accountId: output?.accountId ?? accountId,
        aclId: observed.id,
        name,
        ipRange,
      });
      return toAttributes(updated, output?.accountId ?? accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dns
        .deleteZoneTransferAcl({
          accountId: output.accountId,
          aclId: output.aclId,
        })
        .pipe(Effect.catchTag("AclNotFound", () => Effect.void));
    }),
  });

type ObservedAcl =
  | dns.GetZoneTransferAclResponse
  | dns.CreateZoneTransferAclResponse
  | dns.UpdateZoneTransferAclResponse;

/** Read an ACL by id, mapping "gone" (404) to `undefined`. */
const getAcl = (accountId: string, aclId: string) =>
  dns
    .getZoneTransferAcl({ accountId, aclId })
    .pipe(Effect.catchTag("AclNotFound", () => Effect.succeed(undefined)));

/**
 * Find an ACL by exact name. Names are not unique on Cloudflare's side;
 * pick the lexicographically-first id for determinism.
 */
const findByName = (accountId: string, name: string) =>
  dns.listZoneTransferAcls.items({ accountId }).pipe(
    Stream.filter((a) => a.name === name),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => a.id.localeCompare(b.id))
        .at(0),
    ),
  );

const createAclName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  acl: ObservedAcl,
  accountId: string,
): ZoneTransferAclAttributes => ({
  aclId: acl.id,
  accountId,
  name: acl.name,
  ipRange: acl.ipRange,
});
