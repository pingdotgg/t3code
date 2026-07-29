import * as addressing from "@distilled.cloud/cloudflare/addressing";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Addressing.BgpPrefix" as const;
type TypeId = typeof TypeId;

export interface BgpPrefixProps {
  /**
   * Identifier of the parent BYOIP prefix the BGP prefix belongs to.
   * Changing it forces a replacement.
   */
  prefixId: string;
  /**
   * IP Prefix in Classless Inter-Domain Routing format. Must be contained
   * in the parent prefix. Changing it forces a replacement.
   */
  cidr: string;
  /**
   * Whether the BGP prefix is advertised to the internet (maps to
   * `on_demand.advertised`). Mutable — patched in place; BGP propagation
   * is eventually consistent (minutes).
   * @default false
   */
  advertised?: boolean;
  /**
   * Number of times to prepend the Cloudflare ASN to the BGP AS-Path
   * attribute. Mutable.
   */
  asnPrependCount?: number;
  /**
   * If `true`, Cloudflare advertises the prefix only while a matching BGP
   * prefix exists in the Magic routing table, automatically withdrawing it
   * otherwise. Mutable.
   */
  autoAdvertiseWithdraw?: boolean;
}

export interface BgpPrefixAttributes {
  /** Cloudflare-assigned identifier of the BGP prefix. */
  bgpPrefixId: string;
  /** Identifier of the parent BYOIP prefix. */
  prefixId: string;
  /** The Cloudflare account the prefix belongs to. */
  accountId: string;
  /** IP Prefix in CIDR format. */
  cidr: string;
  /** ASN the prefix is advertised under. */
  asn: number | undefined;
  /** Number of Cloudflare ASN prepends on the AS-Path attribute. */
  asnPrependCount: number | undefined;
  /** Whether Cloudflare auto-withdraws the prefix without a Magic route. */
  autoAdvertiseWithdraw: boolean | undefined;
  /** On-demand advertisement state for the BGP prefix. */
  onDemand: {
    /** Whether the prefix is currently advertised. */
    advertised: boolean;
    /** When the advertisement state last changed. */
    advertisedModifiedAt: string | undefined;
    /** Whether on-demand advertisement is enabled for the prefix. */
    onDemandEnabled: boolean;
    /** `true` while an advertisement change is propagating. */
    onDemandLocked: boolean;
  };
  /** ISO8601 creation timestamp. */
  createdAt: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedAt: string | undefined;
}

export type BgpPrefix = Resource<
  TypeId,
  BgpPrefixProps,
  BgpPrefixAttributes,
  never,
  Providers
>;

/**
 * A BGP prefix controlling on-demand advertisement of a BYOIP prefix (or a
 * subnet of it) to the internet.
 *
 * Cloudflare automatically creates BGP prefixes during BYOIP onboarding, so
 * reconcile adopts an existing BGP prefix matching the CIDR before creating
 * a new one. There is **no delete API** — destroying this resource only
 * withdraws the advertisement (`advertised: false`) and drops the state.
 * @resource
 * @product Addressing
 * @category Network
 * @section Advertising a Prefix
 * @example Advertise the whole BYOIP prefix
 * ```typescript
 * const bgp = yield* Cloudflare.Addressing.BgpPrefix("advertise", {
 *   prefixId: prefix.prefixId,
 *   cidr: prefix.cidr,
 *   advertised: true,
 * });
 * ```
 *
 * @example Withdraw with AS-Path prepending configured
 * ```typescript
 * const bgp = yield* Cloudflare.Addressing.BgpPrefix("advertise", {
 *   prefixId: prefix.prefixId,
 *   cidr: prefix.cidr,
 *   advertised: false,
 *   asnPrependCount: 2,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/byoip/concepts/bgp-prefixes/
 */
export const BgpPrefix = Resource<BgpPrefix>(TypeId);

/**
 * Returns true if the given value is an BgpPrefix resource.
 */
export const isBgpPrefix = (value: unknown): value is BgpPrefix =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const BgpPrefixProvider = () =>
  Provider.succeed(BgpPrefix, {
    stables: ["bgpPrefixId", "prefixId", "accountId", "cidr", "createdAt"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (olds === undefined) return undefined;
      if (!isResolved(news) || !isResolved(olds)) return undefined;
      // prefixId is Input<string>; by diff time both sides are concrete.
      const oldPrefixId = output?.prefixId ?? olds.prefixId;
      if (
        typeof oldPrefixId === "string" &&
        typeof news.prefixId === "string" &&
        news.prefixId !== oldPrefixId
      ) {
        return { action: "replace" } as const;
      }
      if (news.cidr !== (output?.cidr ?? olds.cidr)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const prefixId =
        output?.prefixId ??
        (typeof olds?.prefixId === "string" ? olds.prefixId : undefined);
      if (!prefixId) return undefined;

      if (output?.bgpPrefixId) {
        const observed = yield* getBgpPrefix(
          acct,
          prefixId,
          output.bgpPrefixId,
        );
        return observed ? toAttributes(observed, prefixId, acct) : undefined;
      }
      // Cold read — match on CIDR, which is unique within the parent prefix.
      const cidr = output?.cidr ?? olds?.cidr;
      if (typeof cidr !== "string") return undefined;
      const match = yield* findByCidr(acct, prefixId, cidr);
      return match ? toAttributes(match, prefixId, acct) : undefined;
    }),

    // BGP prefixes are children of BYOIP IP prefixes, which have no single
    // account-wide enumeration endpoint. Fan out: list every account IP
    // prefix, then exhaustively page the BGP prefixes under each. Accounts
    // without BYOIP simply have no parent prefixes, so the result is
    // naturally empty.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const prefixIds = yield* addressing.listPrefixes
        .items({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .map((p) => p.id)
              .filter((id): id is string => typeof id === "string"),
          ),
        );

      const rows = yield* Effect.forEach(
        prefixIds,
        (prefixId) =>
          addressing.listPrefixBgpPrefixes.items({ accountId, prefixId }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).map((bgp) =>
                toAttributes(bgp, prefixId, accountId),
              ),
            ),
            // Parent prefix removed mid-enumeration — skip it.
            Effect.catchTag("PrefixNotFound", () =>
              Effect.succeed([] as BgpPrefixAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const prefixId = news.prefixId as string;

      // 1. Observe — by cached id first, then by CIDR: Cloudflare creates
      //    BGP prefixes itself during onboarding, so an existing one with
      //    our CIDR is adopted rather than duplicated.
      let observed = output?.bgpPrefixId
        ? yield* getBgpPrefix(acct, prefixId, output.bgpPrefixId)
        : undefined;
      if (!observed) {
        observed = yield* findByCidr(acct, prefixId, news.cidr);
      }

      // 2. Ensure — create if genuinely missing.
      if (!observed) {
        observed = yield* addressing.createPrefixBgpPrefix({
          accountId: acct,
          prefixId,
          cidr: news.cidr,
        });
      }
      const bgpPrefixId = observed.id ?? "";

      // 3. Sync — diff observed advertisement settings against desired and
      //    patch only the delta. `onDemandLocked` means a change is already
      //    propagating; retry (bounded) while locked.
      const desiredAdvertised = news.advertised ?? false;
      const dirty =
        (news.advertised !== undefined &&
          (observed.onDemand?.advertised ?? false) !== desiredAdvertised) ||
        (news.asnPrependCount !== undefined &&
          (observed.asnPrependCount ?? 0) !== news.asnPrependCount) ||
        (news.autoAdvertiseWithdraw !== undefined &&
          (observed.autoAdvertiseWithdraw ?? false) !==
            news.autoAdvertiseWithdraw);
      if (dirty) {
        const patched = yield* addressing
          .patchPrefixBgpPrefix({
            accountId: acct,
            prefixId,
            bgpPrefixId,
            asnPrependCount: news.asnPrependCount,
            autoAdvertiseWithdraw: news.autoAdvertiseWithdraw,
            onDemand:
              news.advertised !== undefined
                ? { advertised: news.advertised }
                : undefined,
          })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "BgpPrefixNotFound",
              schedule: Schedule.exponential("2 seconds"),
              times: 5,
            }),
          );
        return toAttributes(patched, prefixId, acct);
      }

      return toAttributes(observed, prefixId, acct);
    }),

    delete: Effect.fn(function* ({ output }) {
      // No delete API exists — BGP prefixes live as long as the parent
      // BYOIP prefix. Withdraw the advertisement (best effort) and drop
      // the state.
      if (output.onDemand.advertised) {
        yield* addressing
          .patchPrefixBgpPrefix({
            accountId: output.accountId,
            prefixId: output.prefixId,
            bgpPrefixId: output.bgpPrefixId,
            onDemand: { advertised: false },
          })
          .pipe(
            Effect.catchTag(
              ["BgpPrefixNotFound", "PrefixNotFound"],
              () => Effect.void,
            ),
          );
      }
    }),
  });

type ObservedBgpPrefix = addressing.GetPrefixBgpPrefixResponse;

/**
 * Read a BGP prefix by id, mapping "gone" (`BgpPrefixNotFound` /
 * `PrefixNotFound`) to `undefined`.
 */
const getBgpPrefix = (
  accountId: string,
  prefixId: string,
  bgpPrefixId: string,
) =>
  addressing
    .getPrefixBgpPrefix({ accountId, prefixId, bgpPrefixId })
    .pipe(
      Effect.catchTag(["BgpPrefixNotFound", "PrefixNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

/**
 * Find a BGP prefix by exact CIDR — unique within a parent prefix. The
 * parent prefix being gone reads as "no match".
 */
const findByCidr = (accountId: string, prefixId: string, cidr: string) =>
  addressing.listPrefixBgpPrefixes.items({ accountId, prefixId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).find((p) => p.cidr === cidr)),
    Effect.catchTag("PrefixNotFound", () => Effect.succeed(undefined)),
  );

const toAttributes = (
  bgp: ObservedBgpPrefix,
  prefixId: string,
  accountId: string,
): BgpPrefixAttributes => ({
  bgpPrefixId: bgp.id ?? "",
  prefixId,
  accountId,
  cidr: bgp.cidr ?? "",
  asn: bgp.asn ?? undefined,
  asnPrependCount: bgp.asnPrependCount ?? undefined,
  autoAdvertiseWithdraw: bgp.autoAdvertiseWithdraw ?? undefined,
  onDemand: {
    advertised: bgp.onDemand?.advertised ?? false,
    advertisedModifiedAt: bgp.onDemand?.advertisedModifiedAt ?? undefined,
    onDemandEnabled: bgp.onDemand?.onDemandEnabled ?? false,
    onDemandLocked: bgp.onDemand?.onDemandLocked ?? false,
  },
  createdAt: bgp.createdAt ?? undefined,
  modifiedAt: bgp.modifiedAt ?? undefined,
});
