import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteRadarValueListItem,
  GetRadarValueListItems,
  GetRadarValueListItem,
  GetRadarValueLists,
  CreateRadarValueListItem,
  type RadarValueList as StripeRadarValueList,
  type RadarValueListItem as StripeRadarValueListItem,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { alchemyMetadataKeys } from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;
const LIST_CONCURRENCY = 10;

export interface RadarValueListItemProps {
  /**
   * Id of the parent Radar value list (`rsl_…`). Changing it replaces
   * the item.
   */
  valueList: string;
  /**
   * Value stored on the list. Its type must match the parent list's
   * `item_type` (e.g. an email, IP, country code, or fingerprint).
   * Changing it replaces the item.
   */
  value: string;
}

export type RadarValueListItem = Resource<
  "Stripe.RadarValueListItem",
  RadarValueListItemProps,
  {
    /** Stripe value list item id (`rsli_…`). */
    id: string;
    /** Id of the parent value list (`rsl_…`). */
    valueList: string;
    /** Value stored on the list. */
    value: string;
    /** Unix timestamp when the item was created. */
    created: number;
    /** Name or email of the user who added the item. */
    createdBy: string;
    /** Whether the item exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Radar Value List Item — one entry on a Radar value list used
 * in Radar rules. Existence-only: there is nothing to update in place;
 * changing `valueList` or `value` replaces the item. Destroy deletes it.
 *
 * Value list items have no metadata of their own. Ownership for
 * account-wide `list()` (nuke) is inferred from the parent value list's
 * Alchemy metadata.
 *
 * @see https://docs.stripe.com/api/radar/value_list_items
 *
 * ### Adding an Item
 * **Example:** Add an email to a value list
 * ```typescript
 * const blocked = yield* Stripe.RadarValueList("blocked-emails", {
 *   alias: "blocked_emails",
 *   name: "Blocked emails",
 *   itemType: "email",
 * });
 * const item = yield* Stripe.RadarValueListItem("spammer", {
 *   valueList: blocked.id,
 *   value: "spammer@example.com",
 * });
 * ```
 *
 * ### Replacing an Item
 * **Example:** Point the item at a different value
 * ```typescript
 * const item = yield* Stripe.RadarValueListItem("spammer", {
 *   valueList: blocked.id,
 *   value: "other@example.com",
 * });
 * ```
 *
 * @resource
 */
export const RadarValueListItem = Resource<RadarValueListItem>(
  "Stripe.RadarValueListItem",
);

type RadarValueListItemAttributes = RadarValueListItem["Attributes"];

const toAttrs = (
  item: StripeRadarValueListItem,
): RadarValueListItemAttributes => ({
  id: item.id,
  valueList: item.value_list,
  value: item.value,
  created: item.created,
  createdBy: item.created_by,
  livemode: item.livemode,
});

const isMissing = isMissingStripeResource;

const getById = (item: string) =>
  GetRadarValueListItem({ item }).pipe(
    Effect.catchIf(isMissing, () => Effect.succeed(undefined)),
  );

const listItems = Effect.fn(function* (valueList: string) {
  const items: StripeRadarValueListItem[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetRadarValueListItems({
      value_list: valueList,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    }).pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));
    if (response === undefined) {
      break;
    }
    items.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return items;
});

const findByValue = Effect.fn(function* (valueList: string, value: string) {
  const matches: StripeRadarValueListItem[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetRadarValueListItems({
      value_list: valueList,
      value,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    }).pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));
    if (response === undefined) {
      break;
    }
    for (const item of response.data) {
      if (item.value === value) {
        matches.push(item);
      }
    }
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const listValueLists = Effect.fn(function* () {
  const lists: StripeRadarValueList[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetRadarValueLists({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    lists.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return lists;
});

const listAlchemyValueLists = Effect.fn(function* () {
  const lists = yield* listValueLists();
  return lists.filter(
    (list) => tagRecord(list.metadata)[alchemyMetadataKeys.stack] !== undefined,
  );
});

const observe = Effect.fn(function* (input: {
  id?: string;
  valueList?: string;
  value?: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.valueList !== undefined && input.value !== undefined) {
    return yield* findByValue(input.valueList, input.value);
  }
  return undefined;
});

const shouldReplace = (
  news: RadarValueListItemProps,
  output: RadarValueListItemAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.valueList !== output.valueList) return true;
  if (news.value !== output.value) return true;
  return false;
};

export const RadarValueListItemProvider = () =>
  Provider.succeed(RadarValueListItem, {
    stables: ["id", "valueList", "value", "created", "createdBy", "livemode"],
    nuke: { dependsOn: ["Stripe.RadarValueList"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const valueList =
        output?.valueList ??
        (typeof olds?.valueList === "string" ? olds.valueList : undefined);
      const value =
        output?.value ??
        (typeof olds?.value === "string" ? olds.value : undefined);
      const existing = yield* observe({
        id: output?.id,
        valueList,
        value,
      });
      if (existing === undefined) return undefined;
      return toAttrs(existing);
    }),

    list: Effect.fn(function* () {
      // Value list items have no metadata. Fan out from alchemy-owned
      // value lists so nuke only tears down items on lists we created.
      const lists = yield* listAlchemyValueLists();
      const rows = yield* Effect.forEach(
        lists,
        (list) =>
          listItems(list.id).pipe(Effect.map((items) => items.map(toAttrs))),
        { concurrency: LIST_CONCURRENCY },
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ news, output, instanceId }) {
      let current = yield* observe({
        id: output?.id,
        valueList: news.valueList,
        value: news.value,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateRadarValueListItem({
          value_list: news.valueList,
          value: news.value,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-radar-value-list-item-${instanceId}`,
          }),
          Effect.catchIf(
            (e) => e._tag === "InvalidRequestError" || e._tag === "Conflict",
            (e) =>
              observe({
                valueList: news.valueList,
                value: news.value,
              }).pipe(
                Effect.flatMap((found) =>
                  found !== undefined ? Effect.succeed(found) : Effect.fail(e),
                ),
              ),
          ),
        );
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteRadarValueListItem({ item: output.id }).pipe(
        Effect.catchIf(isMissing, () => Effect.void),
      );
    }),
  });
