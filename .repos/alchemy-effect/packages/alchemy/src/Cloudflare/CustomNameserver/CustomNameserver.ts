import * as customNameservers from "@distilled.cloud/cloudflare/custom-nameservers";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.CustomNameserver.CustomNameserver" as const;
type TypeId = typeof TypeId;

/**
 * Verification status of an account custom nameserver. Deprecated by
 * Cloudflare but still returned by the API.
 */
export type Status = "moved" | "pending" | "verified";

/**
 * A glue record (A/AAAA) that must be registered at the domain registrar
 * for the custom nameserver to resolve.
 */
export interface Record {
  /**
   * The record type of the glue record.
   */
  type: "A" | "AAAA" | undefined;
  /**
   * The IP address of the glue record.
   */
  value: string | undefined;
}

export interface Props {
  /**
   * The FQDN of the nameserver (e.g. `ns1.yourbrand.com`). Must be a
   * subdomain of a zone active on the same account.
   *
   * Immutable — this is the nameserver's identity; changing it triggers a
   * replacement.
   */
  nsName: string;
  /**
   * The number of the nameserver set this nameserver belongs to (1–5).
   *
   * Immutable — there is no update API; changing it triggers a replacement.
   * @default 1
   */
  nsSet?: number;
}

export interface Attributes {
  /**
   * The FQDN of the nameserver. Also the identifier used to delete it.
   */
  nsName: string;
  /**
   * The Cloudflare account the nameserver belongs to.
   */
  accountId: string;
  /**
   * The number of the nameserver set this nameserver belongs to.
   */
  nsSet: number | undefined;
  /**
   * Verification status of the nameserver (deprecated by Cloudflare but
   * still returned).
   */
  status: Status;
  /**
   * A/AAAA glue records to register at the domain registrar so the
   * nameserver resolves.
   */
  dnsRecords: Record[];
  /**
   * The zone (on this account) that `nsName` belongs to.
   */
  zoneTag: string;
}

export type CustomNameserver = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * An account-level custom (vanity) nameserver — e.g. `ns1.yourbrand.com` —
 * that zones on the account can use instead of their assigned
 * `*.ns.cloudflare.com` names.
 *
 * The nameserver's identity is its `nsName` (FQDN) within the account.
 * There is no update API: both `nsName` and `nsSet` are immutable, so
 * changing either triggers a replacement. After creation, Cloudflare
 * returns the A/AAAA glue records (`dnsRecords`) that must be registered
 * at the domain registrar.
 *
 * Requires the account custom nameservers entitlement (Business/Enterprise
 * or a paid add-on); on unentitled accounts every API call fails with the
 * typed `CustomNameserversNotEnabled` error.
 *
 * Safety: custom nameservers carry no ownership markers. When there is no
 * prior state, `read` scans the account for an existing nameserver with
 * the same `nsName` and reports it as `Unowned`, so the engine refuses to
 * take it over unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Custom Nameservers
 * @category Domains & DNS
 * @section Creating a custom nameserver
 * @example Vanity nameserver on the default set
 * ```typescript
 * const ns1 = yield* Cloudflare.CustomNameserver.CustomNameserver("Ns1", {
 *   nsName: "ns1.yourbrand.com",
 * });
 *
 * // Glue records to register at your registrar:
 * const glue = ns1.dnsRecords; // [{ type: "A", value: "..." }, ...]
 * ```
 *
 * @example Nameserver on a specific set
 * ```typescript
 * yield* Cloudflare.CustomNameserver.CustomNameserver("Ns2", {
 *   nsName: "ns2.yourbrand.com",
 *   nsSet: 2,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/dns/nameservers/custom-nameservers/account-custom-nameservers/
 */
export const CustomNameserver = Resource<CustomNameserver>(TypeId, {
  aliases: ["Cloudflare.CustomNameserver"],
});

/**
 * Returns true if the given value is a CustomNameserver resource.
 */
export const isCustomNameserver = (value: unknown): value is CustomNameserver =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const CustomNameserverProvider = () =>
  Provider.succeed(CustomNameserver, {
    stables: ["nsName", "accountId", "nsSet", "zoneTag"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Account collection: `getCustomNameserver` is a paginated list
      // endpoint despite its name. Enumerate every page and hydrate each
      // nameserver into the exact `read` Attributes shape.
      return yield* customNameservers.getCustomNameserver
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              page.result.map((ns) => toAttributes(ns, accountId)),
            ),
          ),
          // Unentitled accounts have no custom nameservers at all — the
          // collection endpoint rejects with a typed entitlement error.
          // Treat that as an empty collection rather than failing `list`.
          Effect.catchTag("CustomNameserversNotEnabled", () =>
            Effect.succeed([] as Attributes[]),
          ),
        );
    }),

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      // No prior props to compare against — let the engine decide.
      if (olds?.nsName === undefined) return undefined;
      // There is no update API: both the FQDN and the set number are
      // immutable, so any change is a replacement.
      if (olds.nsName !== news.nsName) {
        return { action: "replace" } as const;
      }
      if ((olds.nsSet ?? 1) !== (news.nsSet ?? 1)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const nsName = output?.nsName ?? olds?.nsName;
      if (nsName === undefined) return undefined;

      const observed = yield* findByName(acct, nsName);
      if (!observed) return undefined;

      // Owned path: we created this nameserver — refresh its attributes.
      if (output?.nsName) return toAttributes(observed, acct);

      // Adoption path: a nameserver with this FQDN already exists on the
      // account. Custom nameservers carry no ownership markers, so brand
      // it `Unowned` — the engine refuses to take over unless `adopt` is
      // set.
      return Unowned(toAttributes(observed, acct));
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — `nsName` is the nameserver's identity within the
      //    account; the cached `output` is at most a hint. The list is
      //    authoritative: a missing nameserver falls through to create.
      const observed = yield* findByName(
        output?.accountId ?? accountId,
        news.nsName,
      );
      if (observed) {
        // 2. Sync — nothing is mutable (no update API); `diff` already
        //    replaces on nsName/nsSet changes, so observed state is final.
        return toAttributes(observed, output?.accountId ?? accountId);
      }

      // 3. Ensure — create when missing. A concurrent create surfaces as
      //    `CustomNameserverAlreadyExists`: converge by re-listing for
      //    the nameserver that won the race.
      const created = yield* customNameservers
        .createCustomNameserver({
          accountId,
          nsName: news.nsName,
          nsSet: news.nsSet,
        })
        .pipe(
          Effect.catchTag("CustomNameserverAlreadyExists", (error) =>
            findByName(accountId, news.nsName).pipe(
              Effect.flatMap((existing) =>
                existing ? Effect.succeed(existing) : Effect.fail(error),
              ),
            ),
          ),
        );
      return toAttributes(created, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Observe first — DELETE for an already-gone nameserver may not
      // return a decodable envelope, and a second destroy must be a
      // no-op either way.
      const observed = yield* findByName(output.accountId, output.nsName);
      if (!observed) return;
      yield* customNameservers
        .deleteCustomNameserver({
          accountId: output.accountId,
          customNSId: output.nsName,
        })
        .pipe(Effect.catchTag("CustomNameserverNotFound", () => Effect.void));
    }),
  });

type ObservedNameserver =
  customNameservers.GetCustomNameserverResponse["result"][number];

/**
 * Find a custom nameserver by exact FQDN on the account. The FQDN is the
 * nameserver's identity — Cloudflare rejects duplicates — so at most one
 * can match. `getCustomNameserver` is a list endpoint despite its name.
 */
const findByName = (accountId: string, nsName: string) =>
  customNameservers
    .getCustomNameserver({ accountId })
    .pipe(
      Effect.map((page) =>
        page.result.find(
          (ns): ns is ObservedNameserver => ns.nsName === nsName,
        ),
      ),
    );

const toAttributes = (
  ns: ObservedNameserver | customNameservers.CreateCustomNameserverResponse,
  accountId: string,
): Attributes => ({
  nsName: ns.nsName,
  accountId,
  nsSet: ns.nsSet ?? undefined,
  // Distilled widens generated string enums to open unions (`string & {}`).
  status: ns.status as Status,
  dnsRecords: ns.dnsRecords.map((record) => ({
    type: (record.type ?? undefined) as "A" | "AAAA" | undefined,
    value: record.value ?? undefined,
  })),
  zoneTag: ns.zoneTag,
});
