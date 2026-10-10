import * as ses from "@distilled.cloud/aws/ses";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * Whether the filter permits (`Allow`) or blocks (`Block`) mail from the
 * matching IP range.
 */
export type ReceiptFilterPolicy = ses.ReceiptFilterPolicy;

export interface ReceiptIpFilter {
  /**
   * Whether to allow or block mail from the CIDR range.
   */
  policy: ReceiptFilterPolicy;
  /**
   * A single IPv4 address (e.g. `1.2.3.4`) or CIDR range (e.g. `1.2.3.0/24`)
   * the filter applies to.
   */
  cidr: string;
}

export interface ReceiptFilterProps {
  /**
   * Name of the IP address filter. May contain letters, numbers, dashes and
   * underscores, up to 64 characters, and must start and end with a letter or
   * number. If omitted, a deterministic physical name is generated from the
   * app, stage, and logical ID. Changing the name replaces the filter.
   */
  filterName?: string;
  /**
   * The IP filtering rule — an allow or block decision for a CIDR range.
   * Changing it replaces the filter (SES has no update operation for filters).
   */
  ipFilter: ReceiptIpFilter;
}

export interface ReceiptFilter extends Resource<
  "AWS.SES.ReceiptFilter",
  ReceiptFilterProps,
  {
    /** Name of the IP address filter. */
    filterName: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES receipt IP address filter — an account-level allow/block rule
 * for the source IP of inbound mail. Block filters take precedence over allow
 * filters.
 *
 * Filters are immutable: there is no update API, so any change to the name or
 * the IP rule replaces the filter.
 * ### Creating Filters
 * **Example:** Block a CIDR Range
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const filter = yield* SES.ReceiptFilter("BlockBadActors", {
 *   ipFilter: { policy: "Block", cidr: "10.0.0.0/24" },
 * });
 * ```
 *
 * **Example:** Allow a Single Address
 * ```typescript
 * const filter = yield* SES.ReceiptFilter("AllowPartner", {
 *   ipFilter: { policy: "Allow", cidr: "192.0.2.10" },
 * });
 * ```
 *
 * @resource
 */
export const ReceiptFilter = Resource<ReceiptFilter>("AWS.SES.ReceiptFilter");

export const ReceiptFilterProvider = () =>
  Provider.effect(
    ReceiptFilter,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<ReceiptFilterProps, "filterName">,
      ) {
        return (
          props.filterName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const findFilter = Effect.fn(function* (name: string) {
        const filters = yield* ses
          .listReceiptFilters({})
          .pipe(Effect.map((response) => response.Filters ?? []));
        return filters.find((filter) => filter.Name === name);
      });

      return ReceiptFilter.Provider.of({
        stables: ["filterName"],

        // Account/region-scoped: enumerate every filter so leaked test
        // resources are cleaned by nuke. Receipt filters carry no tags.
        list: () =>
          ses
            .listReceiptFilters({})
            .pipe(
              Effect.map((response) =>
                (response.Filters ?? []).flatMap((filter) =>
                  filter.Name ? [{ filterName: filter.Name }] : [],
                ),
              ),
            ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.filterName ?? (yield* createName(id, olds));
          const found = yield* findFilter(name);
          return found ? { filterName: name } : undefined;
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            olds.ipFilter.policy !== news.ipFilter.policy ||
            olds.ipFilter.cidr !== news.ipFilter.cidr
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = output?.filterName ?? (yield* createName(id, news));

          // OBSERVE — filters have no update API, so reconcile is create-only.
          const observed = yield* findFilter(name);

          // ENSURE — create if missing; AlreadyExists is a race, not a failure.
          if (observed === undefined) {
            yield* ses
              .createReceiptFilter({
                Filter: {
                  Name: name,
                  IpFilter: {
                    Policy: news.ipFilter.policy,
                    Cidr: news.ipFilter.cidr,
                  },
                },
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  Effect.succeed({}),
                ),
              );
          }

          return { filterName: name };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteReceiptFilter is idempotent for a missing filter.
          yield* ses.deleteReceiptFilter({ FilterName: output.filterName });
        }),
      });
    }),
  );
