import * as addressing from "@distilled.cloud/cloudflare/addressing";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Addressing.Prefix" as const;
type TypeId = typeof TypeId;

export interface PrefixProps {
  /**
   * IP Prefix in Classless Inter-Domain Routing format (e.g.
   * `192.0.2.0/24`). Immutable — changing it forces a replacement.
   */
  cidr: string;
  /**
   * Autonomous System Number (ASN) the prefix will be advertised under.
   * Immutable — changing it forces a replacement.
   */
  asn: number;
  /**
   * Description of the prefix. The only mutable field — patched in place
   * via `patchPrefix`.
   */
  description?: string;
  /**
   * Identifier for an uploaded LOA (Letter of Authorization) document.
   * Create-only — changing it forces a replacement.
   */
  loaDocumentId?: string;
  /**
   * Whether Cloudflare is allowed to generate the LOA document on behalf of
   * the prefix owner. Create-only — changing it forces a replacement.
   * @default false
   */
  delegateLoaCreation?: boolean;
}

export interface PrefixAttributes {
  /** Cloudflare-assigned identifier of the IP Prefix. */
  prefixId: string;
  /** The Cloudflare account the prefix belongs to. */
  accountId: string;
  /** IP Prefix in CIDR format. */
  cidr: string;
  /** ASN the prefix is advertised under. */
  asn: number;
  /** Approval state of the prefix (`P` = pending, `V` = active). */
  approved: string | undefined;
  /** State of the ownership validation for the prefix. */
  ownershipValidationState: string | undefined;
  /** Token provided to demonstrate ownership of the prefix. */
  ownershipValidationToken: string | undefined;
  /** State of the IRR validation for the prefix. */
  irrValidationState: string | undefined;
  /** State of the RPKI validation for the prefix. */
  rpkiValidationState: string | undefined;
  /** Identifier of the uploaded LOA document, if any. */
  loaDocumentId: string | undefined;
  /** The prefix description, if set. */
  description: string | undefined;
  /** ISO8601 creation timestamp. */
  createdAt: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedAt: string | undefined;
}

export type Prefix = Resource<
  TypeId,
  PrefixProps,
  PrefixAttributes,
  never,
  Providers
>;

/**
 * A BYOIP (Bring Your Own IP) prefix onboarded to Cloudflare's network.
 *
 * Requires the BYOIP enterprise add-on; onboarding a prefix is a contract
 * process (LOA, IRR/RPKI validation, manual approval) — `approved` flips
 * from `"P"` (pending) to `"V"` (active) on Cloudflare's side and is never
 * waited on by this resource.
 *
 * Only `description` is mutable; `cidr`, `asn`, and the LOA settings force
 * a replacement.
 * @resource
 * @product Addressing
 * @category Network
 * @section Creating a Prefix
 * @example Onboard a prefix with a pre-uploaded LOA
 * ```typescript
 * const prefix = yield* Cloudflare.Addressing.Prefix("byoip", {
 *   cidr: "192.0.2.0/24",
 *   asn: 64496,
 *   description: "production ingress",
 *   loaDocumentId: loa.id,
 * });
 * ```
 *
 * @example Delegate LOA creation to Cloudflare
 * ```typescript
 * const prefix = yield* Cloudflare.Addressing.Prefix("byoip", {
 *   cidr: "192.0.2.0/24",
 *   asn: 64496,
 *   delegateLoaCreation: true,
 * });
 * ```
 *
 * @section Advertising the Prefix
 * @example Advertise via a BGP prefix
 * ```typescript
 * const bgp = yield* Cloudflare.Addressing.BgpPrefix("advertise", {
 *   prefixId: prefix.prefixId,
 *   cidr: prefix.cidr,
 *   advertised: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/byoip/
 */
export const Prefix = Resource<Prefix>(TypeId);

/**
 * Returns true if the given value is an Prefix resource.
 */
export const isPrefix = (value: unknown): value is Prefix =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const PrefixProvider = () =>
  Provider.succeed(Prefix, {
    stables: [
      "prefixId",
      "accountId",
      "cidr",
      "asn",
      "ownershipValidationToken",
      "createdAt",
    ],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (olds === undefined) return undefined;
      if (!isResolved(news) || !isResolved(olds)) return undefined;
      // cidr / asn / LOA settings are create-only.
      if (news.cidr !== (output?.cidr ?? olds.cidr)) {
        return { action: "replace" } as const;
      }
      if (news.asn !== (output?.asn ?? olds.asn)) {
        return { action: "replace" } as const;
      }
      if (
        typeof news.loaDocumentId === "string" &&
        typeof olds.loaDocumentId === "string" &&
        news.loaDocumentId !== olds.loaDocumentId
      ) {
        return { action: "replace" } as const;
      }
      if (
        (news.delegateLoaCreation ?? false) !==
        (olds.delegateLoaCreation ?? false)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // BYOIP prefixes are account-scoped; the catalog list endpoint returns
    // the full prefix object per item, so each row hydrates directly into the
    // same `Attributes` shape `read` produces — no per-item fetch needed.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* addressing.listPrefixes.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((p) => toAttributes(p, accountId)),
          ),
        ),
      );
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.prefixId) {
        const observed = yield* getPrefix(acct, output.prefixId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — a CIDR is unique per account, so match on it.
      const cidr = output?.cidr ?? olds?.cidr;
      if (typeof cidr !== "string") return undefined;
      const match = yield* findByCidr(acct, cidr);
      return match ? toAttributes(match, acct) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // 1. Observe — the prefix id on `output` is a hint; a missing prefix
      //    falls through to the by-CIDR lookup and then to create.
      let observed = output?.prefixId
        ? yield* getPrefix(acct, output.prefixId)
        : undefined;
      if (!observed) {
        observed = yield* findByCidr(acct, news.cidr);
      }

      // 2. Ensure — create the prefix if it is missing.
      if (!observed) {
        const created = yield* addressing.createPrefix({
          accountId: acct,
          cidr: news.cidr,
          asn: news.asn,
          description: news.description,
          loaDocumentId: news.loaDocumentId as string | undefined,
          delegateLoaCreation: news.delegateLoaCreation,
        });
        return toAttributes(created, acct);
      }

      // 3. Sync — `description` is the only mutable field; skip the PATCH
      //    entirely on a no-op.
      const desiredDescription = news.description ?? "";
      if ((observed.description ?? "") !== desiredDescription) {
        const patched = yield* addressing.patchPrefix({
          accountId: acct,
          prefixId: observed.id ?? "",
          description: desiredDescription,
        });
        return toAttributes(patched, acct);
      }

      return toAttributes(observed, acct);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Deleting an onboarded prefix can be rejected while service bindings
      // or BGP advertisements still exist — children delete first; the
      // engine orders dependencies, so a hard failure here is genuine.
      yield* addressing
        .deletePrefix({
          accountId: output.accountId,
          prefixId: output.prefixId,
        })
        .pipe(Effect.catchTag("PrefixNotFound", () => Effect.void));
    }),
  });

/**
 * Read a prefix by id, mapping "gone" (`PrefixNotFound`, Cloudflare error
 * code 1000 `not_found`) to `undefined`.
 */
const getPrefix = (accountId: string, prefixId: string) =>
  addressing
    .getPrefix({ accountId, prefixId })
    .pipe(Effect.catchTag("PrefixNotFound", () => Effect.succeed(undefined)));

/**
 * Find a prefix by exact CIDR — unique per account.
 */
const findByCidr = (accountId: string, cidr: string) =>
  addressing.listPrefixes.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).find((p) => p.cidr === cidr)),
  );

const toAttributes = (
  prefix: addressing.GetPrefixResponse,
  accountId: string,
): PrefixAttributes => ({
  prefixId: prefix.id ?? "",
  accountId,
  cidr: prefix.cidr ?? "",
  asn: prefix.asn ?? 0,
  approved: prefix.approved ?? undefined,
  ownershipValidationState: prefix.ownershipValidationState ?? undefined,
  ownershipValidationToken: prefix.ownershipValidationToken ?? undefined,
  irrValidationState: prefix.irrValidationState ?? undefined,
  rpkiValidationState: prefix.rpkiValidationState ?? undefined,
  loaDocumentId: prefix.loaDocumentId ?? undefined,
  description: prefix.description ?? undefined,
  createdAt: prefix.createdAt ?? undefined,
  modifiedAt: prefix.modifiedAt ?? undefined,
});
