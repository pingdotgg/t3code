import * as ddos from "@distilled.cloud/cloudflare/ddos-protection";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.DdosProtection.SynProtectionFilter" as const;
type TypeId = typeof TypeId;

/**
 * Operating mode of an Advanced TCP Protection filter: the filter applies
 * to mitigation (`enabled`), is observe-only (`monitoring`), or excluded
 * (`disabled`).
 */
export type SynProtectionFilterMode = "enabled" | "disabled" | "monitoring";

export interface SynProtectionFilterProps {
  /**
   * The filter expression selecting which traffic SYN Protection sees
   * (e.g. `tcp.dstport in {443}`). Mutable — patched in place.
   */
  expression: string;
  /**
   * The mode the filter applies to: `enabled`, `disabled`, or
   * `monitoring`. Mutable — patched in place.
   */
  mode: SynProtectionFilterMode;
}

export interface SynProtectionFilterAttributes {
  /** Cloudflare-assigned identifier of the filter. */
  filterId: string;
  /** The Cloudflare account the filter belongs to. */
  accountId: string;
  /** The filter expression. */
  expression: string;
  /** The mode the filter applies to. */
  mode: SynProtectionFilterMode;
  /** ISO8601 creation timestamp. */
  createdOn: string;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string;
}

export type SynProtectionFilter = Resource<
  TypeId,
  SynProtectionFilterProps,
  SynProtectionFilterAttributes,
  never,
  Providers
>;

/**
 * An Advanced TCP Protection SYN Protection filter (Magic Transit).
 *
 * Filters gate which traffic the SYN Protection rules see, per mode: an
 * `enabled` filter scopes mitigation, a `monitoring` filter scopes
 * observe-only analysis, and a `disabled` filter excludes traffic. Both
 * `expression` and `mode` are mutable in place.
 *
 * Requires the **Magic Transit / Advanced TCP Protection** entitlement; on
 * accounts without it every API call fails with the typed
 * `AdvancedTcpProtectionNotEntitled` error.
 *
 * Safety: filters carry no ownership markers. When there is no prior
 * state, `read` scans for an existing filter with the same expression and
 * reports it as `Unowned`, so the engine refuses to take it over unless
 * `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product DDoS Protection
 * @category Network
 * @section Creating a filter
 * @example Scope SYN mitigation to HTTPS traffic
 * ```typescript
 * const filter = yield* Cloudflare.DdosProtection.SynProtectionFilter("HttpsOnly", {
 *   expression: "tcp.dstport in {443}",
 *   mode: "enabled",
 * });
 * ```
 *
 * @example Monitor a port range without mitigating
 * ```typescript
 * yield* Cloudflare.DdosProtection.SynProtectionFilter("WatchHighPorts", {
 *   expression: "tcp.dstport in {8000..8999}",
 *   mode: "monitoring",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ddos-protection/advanced-ddos-systems/overview/advanced-tcp-protection/
 */
export const SynProtectionFilter = Resource<SynProtectionFilter>(TypeId);

/**
 * Returns true if the given value is a SynProtectionFilter resource.
 */
export const isSynProtectionFilter = (
  value: unknown,
): value is SynProtectionFilter =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SynProtectionFilterProvider = () =>
  Provider.succeed(SynProtectionFilter, {
    stables: ["filterId", "accountId", "createdOn"],

    // Account-scoped collection: paginate every filter in the ambient
    // account. Accounts without the Advanced TCP Protection entitlement (or
    // lacking read permission) yield no filters — treat the typed rejection
    // as an empty enumeration rather than an error.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* ddos.listAdvancedTcpProtectionSynProtectionFilters
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((filter) =>
                toAttributes(filter, accountId),
              ),
            ),
          ),
          Effect.catchTags({
            AdvancedTcpProtectionNotEntitled: () => Effect.succeed([]),
            Forbidden: () => Effect.succeed([]),
          }),
        );
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by our persisted filter id.
      if (output?.filterId) {
        const observed = yield* getFilter(acct, output.filterId);
        if (observed) return toAttributes(observed, acct);
      }

      // Adoption path: a filter with this expression may already exist.
      // Filters carry no ownership markers, so brand the match `Unowned` —
      // the engine refuses to take over unless `adopt` is set.
      const expression = output?.expression ?? olds?.expression;
      if (expression) {
        const observed = yield* findByExpression(acct, expression);
        if (observed) return Unowned(toAttributes(observed, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — the filter id cached on `output` is a hint, not a
      //    guarantee: a missing filter falls through to create.
      let observed = output?.filterId
        ? yield* getFilter(accountId, output.filterId)
        : undefined;

      // 2. Ensure — create when missing. Expressions are not unique on
      //    Cloudflare's side, so there is no AlreadyExists race to
      //    tolerate.
      if (!observed) {
        observed = yield* ddos.createAdvancedTcpProtectionSynProtectionFilter({
          accountId,
          expression: news.expression,
          mode: news.mode,
        });
      }

      // 3. Sync — diff observed expression/mode against desired; skip the
      //    patch entirely on a no-op.
      const dirty =
        observed.expression !== news.expression || observed.mode !== news.mode;
      if (dirty) {
        observed =
          yield* ddos.patchAdvancedTcpProtectionSynProtectionFilterItem({
            accountId,
            filterId: observed.id,
            expression: news.expression,
            mode: news.mode,
          });
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ddos
        .deleteAdvancedTcpProtectionSynProtectionFilterItem({
          accountId: output.accountId,
          filterId: output.filterId,
        })
        .pipe(
          Effect.catchTag("SynProtectionFilterNotFound", () => Effect.void),
        );
    }),
  });

type ObservedFilter =
  ddos.GetAdvancedTcpProtectionSynProtectionFilterItemResponse;

/**
 * Read a filter by id, mapping "gone" (`SynProtectionFilterNotFound`,
 * HTTP 404) to `undefined`.
 */
const getFilter = (accountId: string, filterId: string) =>
  ddos
    .getAdvancedTcpProtectionSynProtectionFilterItem({ accountId, filterId })
    .pipe(
      Effect.map((filter): ObservedFilter | undefined => filter),
      Effect.catchTag("SynProtectionFilterNotFound", () =>
        Effect.succeed(undefined),
      ),
    );

/**
 * Find a filter by exact expression. Expressions are not unique on
 * Cloudflare's side; if several filters carry the same expression, pick
 * the oldest for determinism.
 */
const findByExpression = (accountId: string, expression: string) =>
  ddos.listAdvancedTcpProtectionSynProtectionFilters.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .filter((filter) => filter.expression === expression)
        .sort((a, b) => a.createdOn.localeCompare(b.createdOn))
        .at(0),
    ),
  );

const toAttributes = (
  filter: ObservedFilter,
  accountId: string,
): SynProtectionFilterAttributes => ({
  filterId: filter.id,
  accountId,
  expression: filter.expression,
  // Distilled widens generated string enums to plain strings.
  mode: filter.mode as SynProtectionFilterMode,
  createdOn: filter.createdOn,
  modifiedOn: filter.modifiedOn,
});
