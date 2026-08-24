import * as addressing from "@distilled.cloud/cloudflare/addressing";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Addressing.PrefixDelegation" as const;
type TypeId = typeof TypeId;

export interface PrefixDelegationProps {
  /**
   * Identifier of the parent BYOIP prefix being delegated from. Changing it
   * forces a replacement.
   */
  prefixId: string;
  /**
   * IP Prefix in Classless Inter-Domain Routing format to delegate. Must be
   * contained in the parent prefix. Changing it forces a replacement.
   */
  cidr: string;
  /**
   * Identifier of the Cloudflare account the prefix is delegated to.
   * Changing it forces a replacement.
   */
  delegatedAccountId: string;
}

export interface PrefixDelegationAttributes {
  /** Cloudflare-assigned identifier of the delegation. */
  delegationId: string;
  /** Identifier of the parent BYOIP prefix. */
  prefixId: string;
  /** The Cloudflare account that owns the parent prefix. */
  accountId: string;
  /** Delegated IP Prefix in CIDR format. */
  cidr: string;
  /** The account the prefix portion is delegated to. */
  delegatedAccountId: string;
  /** ISO8601 creation timestamp. */
  createdAt: string | undefined;
}

export type PrefixDelegation = Resource<
  TypeId,
  PrefixDelegationProps,
  PrefixDelegationAttributes,
  never,
  Providers
>;

/**
 * Delegates part of a BYOIP prefix to another Cloudflare account, allowing
 * that account to use the delegated CIDR (e.g. for its own service
 * bindings).
 *
 * Delegations are create/delete only — every prop change forces a
 * replacement.
 * @resource
 * @product Addressing
 * @category Network
 * @section Delegating a Prefix
 * @example Delegate a /26 to another account
 * ```typescript
 * const delegation = yield* Cloudflare.Addressing.PrefixDelegation("share", {
 *   prefixId: prefix.prefixId,
 *   cidr: "192.0.2.0/26",
 *   delegatedAccountId: "023e105f4ecef8ad9ca31a8372d0c353",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/byoip/
 */
export const PrefixDelegation = Resource<PrefixDelegation>(TypeId);

/**
 * Returns true if the given value is an PrefixDelegation resource.
 */
export const isPrefixDelegation = (value: unknown): value is PrefixDelegation =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const PrefixDelegationProvider = () =>
  Provider.succeed(PrefixDelegation, {
    stables: [
      "delegationId",
      "prefixId",
      "accountId",
      "cidr",
      "delegatedAccountId",
      "createdAt",
    ],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (olds === undefined) return undefined;
      if (!isResolved(news) || !isResolved(olds)) return undefined;
      // Create/delete only — any change forces a replacement.
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
      const oldDelegated =
        output?.delegatedAccountId ?? olds.delegatedAccountId;
      if (
        typeof oldDelegated === "string" &&
        typeof news.delegatedAccountId === "string" &&
        news.delegatedAccountId !== oldDelegated
      ) {
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

      // There is no get-by-id op — list and filter. Cold reads match on
      // (cidr, delegatedAccountId), which identify a delegation uniquely.
      const delegations = yield* listDelegations(acct, prefixId);
      const match = output?.delegationId
        ? delegations.find((d) => d.id === output.delegationId)
        : delegations.find(
            (d) =>
              d.cidr === (output?.cidr ?? olds?.cidr) &&
              d.delegatedAccountId ===
                (output?.delegatedAccountId ??
                  (typeof olds?.delegatedAccountId === "string"
                    ? olds.delegatedAccountId
                    : undefined)),
          );
      return match ? toAttributes(match, prefixId, acct) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const prefixId = news.prefixId as string;
      const delegatedAccountId = news.delegatedAccountId as string;

      // 1. Observe — find an existing delegation with the same identity.
      const delegations = yield* listDelegations(acct, prefixId);
      const observed =
        (output?.delegationId
          ? delegations.find((d) => d.id === output.delegationId)
          : undefined) ??
        delegations.find(
          (d) =>
            d.cidr === news.cidr && d.delegatedAccountId === delegatedAccountId,
        );
      if (observed) {
        // Nothing is mutable — converged.
        return toAttributes(observed, prefixId, acct);
      }

      // 2. Ensure — create the delegation.
      const created = yield* addressing.createPrefixDelegation({
        accountId: acct,
        prefixId,
        cidr: news.cidr,
        delegatedAccountId,
      });
      return toAttributes(created, prefixId, acct);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* addressing
        .deletePrefixDelegation({
          accountId: output.accountId,
          prefixId: output.prefixId,
          delegationId: output.delegationId,
        })
        .pipe(Effect.catchTag("DelegationNotFound", () => Effect.void));
    }),

    // Delegations are children of BYOIP prefixes and have no account-wide
    // enumeration API. Fan out: list every account prefix, then list the
    // delegations on each prefix (bounded concurrency). A prefix that has
    // gone away between the two calls reads as an empty list (typed
    // `PrefixNotFound`, handled in `listDelegations`).
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const prefixIds = yield* addressing.listPrefixes
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? [])
                .map((p) => p.id)
                .filter((id): id is string => typeof id === "string"),
            ),
          ),
        );

      const rows = yield* Effect.forEach(
        prefixIds,
        (prefixId) =>
          listDelegations(accountId, prefixId).pipe(
            Effect.map((delegations) =>
              delegations.map((d) => toAttributes(d, prefixId, accountId)),
            ),
          ),
        { concurrency: 10 },
      );

      return rows.flat();
    }),
  });

interface ObservedDelegation {
  readonly id?: string | null;
  readonly cidr?: string | null;
  readonly createdAt?: string | null;
  readonly delegatedAccountId?: string | null;
  readonly parentPrefixId?: string | null;
}

/**
 * List all delegations on a prefix. A missing parent prefix reads as an
 * empty list.
 */
const listDelegations = (accountId: string, prefixId: string) =>
  addressing.listPrefixDelegations.items({ accountId, prefixId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk) as ObservedDelegation[]),
    Effect.catchTag("PrefixNotFound", () =>
      Effect.succeed([] as ObservedDelegation[]),
    ),
  );

const toAttributes = (
  delegation: ObservedDelegation,
  prefixId: string,
  accountId: string,
): PrefixDelegationAttributes => ({
  delegationId: delegation.id ?? "",
  prefixId,
  accountId,
  cidr: delegation.cidr ?? "",
  delegatedAccountId: delegation.delegatedAccountId ?? "",
  createdAt: delegation.createdAt ?? undefined,
});
