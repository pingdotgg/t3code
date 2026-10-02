import { withRequestOptions } from "@distilled.cloud/stripe";
import {
  DeleteRadarValueList,
  GetRadarValueLists,
  GetRadarValueList,
  CreateRadarValueList,
  UpdateRadarValueList,
  type RadarValueList as StripeRadarValueList,
} from "@distilled.cloud/stripe/stripe";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const NAME_MAX_LENGTH = 250;
const ALIAS_MAX_LENGTH = 100;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;

/**
 * Type of items stored in a Radar value list. Create-only — changing it
 * replaces the list.
 */
export type RadarValueListItemType =
  | "account"
  | "card_bin"
  | "card_fingerprint"
  | "case_sensitive_string"
  | "country"
  | "crypto_fingerprint"
  | "customer_id"
  | "email"
  | "ip_address"
  | "sepa_debit_fingerprint"
  | "string"
  | "us_bank_account_fingerprint";

export interface RadarValueListProps {
  /**
   * Alias used to reference this list in Radar rules. Unique per account;
   * alphanumeric characters and underscores only, max 100 characters. If
   * omitted, a unique alias is generated from the stack, stage, and
   * logical id. Create-only — changing it replaces the list.
   */
  alias?: string;
  /**
   * Human-readable name shown in the Stripe Dashboard. If omitted, a unique
   * name is generated from the stack, stage, and logical id. Mutable.
   */
  name?: string;
  /**
   * Type of items stored in this list. Immutable after create.
   * @default "string"
   */
  itemType?: RadarValueListItemType;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`. Mutable.
   */
  metadata?: Record<string, string>;
}

export type RadarValueList = Resource<
  "Stripe.RadarValueList",
  RadarValueListProps,
  {
    /** Stripe Radar value list id (`rsl_…`). */
    id: string;
    /** Alias used to reference this list in Radar rules. */
    alias: string;
    /** Human-readable name shown in the Stripe Dashboard. */
    name: string;
    /** Type of items stored in this list. */
    itemType: RadarValueListItemType;
    /** Name or email of the user who created this list. */
    createdBy: string;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the list was created. */
    created: number;
    /** Whether the list exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

/**
 * A Stripe Radar Value List — a named collection of values (emails, IPs,
 * card fingerprints, …) referenced from Radar rules. `alias` and
 * `itemType` are immutable and changing them replaces the list. Name and
 * metadata update in place. Destroy deletes the list and its items; a
 * list referenced by a Radar rule cannot be deleted.
 *
 * Radar custom lists may require Radar for Fraud Teams.
 *
 * @see https://docs.stripe.com/api/radar/value_lists
 *
 * ### Creating a Value List
 * **Example:** Generated alias
 * ```typescript
 * const blocked = yield* Stripe.RadarValueList("blocked-emails", {
 *   itemType: "email",
 * });
 * ```
 *
 * **Example:** Named list with alias
 * ```typescript
 * const blocked = yield* Stripe.RadarValueList("blocked-emails", {
 *   alias: "custom_email_blocklist",
 *   name: "Blocked emails",
 *   itemType: "email",
 * });
 * ```
 *
 * ### Updating a Value List
 * **Example:** Rename and retag
 * ```typescript
 * const blocked = yield* Stripe.RadarValueList("blocked-emails", {
 *   alias: "custom_email_blocklist",
 *   name: "Blocked emails (updated)",
 *   itemType: "email",
 *   metadata: { team: "fraud" },
 * });
 * ```
 *
 * ### Replacing a Value List
 * **Example:** Changing item type replaces the list
 * ```typescript
 * const blocked = yield* Stripe.RadarValueList("blocked", {
 *   alias: "custom_blocklist",
 *   itemType: "ip_address",
 * });
 * ```
 *
 * @resource
 */
export const RadarValueList = Resource<RadarValueList>("Stripe.RadarValueList");

export class RadarValueListNotResolved extends Data.TaggedError(
  "Stripe.RadarValueListNotResolved",
)<{
  alias: string;
}> {}

type RadarValueListAttributes = RadarValueList["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }))
    );
  });

const toAlias = (id: string, alias: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (alias !== undefined) return alias;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: ALIAS_MAX_LENGTH,
      lowercase: true,
      delimiter: "_",
    });
    // Stripe aliases allow only [A-Za-z0-9_]; physical names may still
    // contain hyphens from the stack/stage prefix.
    return generated.replaceAll("-", "_");
  });

const toAttrs = (list: StripeRadarValueList): RadarValueListAttributes => ({
  id: list.id,
  alias: list.alias,
  name: list.name,
  itemType: list.item_type,
  createdBy: list.created_by,
  metadata: userMetadata(list.metadata),
  created: list.created,
  livemode: list.livemode,
});

const isMissingValueList = isMissingStripeResource;

const getById = (valueList: string) =>
  GetRadarValueList({ value_list: valueList }).pipe(
    Effect.catchIf(isMissingValueList, () => Effect.succeed(undefined)),
  );

const findByAlias = (alias: string) =>
  Effect.gen(function* () {
    const response = yield* GetRadarValueLists({
      alias,
      limit: 1,
    });
    return response.data[0];
  });

const listAllValueLists = Effect.fn(function* () {
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

const findByAlchemyId = Effect.fn(function* (id: string) {
  const lists = yield* listAllValueLists();
  const matches: StripeRadarValueList[] = [];
  for (const list of lists) {
    if (yield* hasAlchemyMetadata(id, tagRecord(list.metadata))) {
      matches.push(list);
    }
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const observe = Effect.fn(function* (input: {
  id?: string;
  logicalId: string;
  alias?: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.alias !== undefined) {
    const byAlias = yield* findByAlias(input.alias);
    if (
      byAlias !== undefined &&
      (yield* hasAlchemyMetadata(input.logicalId, tagRecord(byAlias.metadata)))
    ) {
      return byAlias;
    }
  }
  return yield* findByAlchemyId(input.logicalId);
});

const desiredMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, string> | undefined,
) {
  return {
    ...toMetadata(metadata),
    ...(yield* createInternalMetadata(id)),
  };
});

const shouldReplace = (
  news: RadarValueListProps,
  output: RadarValueListAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (news.alias !== undefined && news.alias !== output.alias) {
    return true;
  }
  if (news.itemType !== undefined && news.itemType !== output.itemType) {
    return true;
  }
  return false;
};

export const RadarValueListProvider = () =>
  Provider.succeed(RadarValueList, {
    stables: ["id", "alias", "itemType", "created", "createdBy", "livemode"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        const previousAlias = output?.alias ?? olds?.alias;
        return {
          action: "replace" as const,
          deleteFirst: news.alias !== undefined && news.alias === previousAlias,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      const existing = yield* observe({
        id: output?.id,
        logicalId: id,
        alias: output?.alias,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const lists = yield* listAllValueLists();
      return lists
        .filter((list) => {
          const metadata = tagRecord(list.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map(toAttrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const alias = yield* toAlias(id, news.alias, output?.alias);
      const name = yield* toName(id, news.name, output?.name);
      const metadata = yield* desiredMetadata(id, news.metadata);
      const itemType = news.itemType ?? output?.itemType ?? "string";

      let current: StripeRadarValueList | undefined = yield* observe({
        id: output?.id,
        logicalId: id,
        alias,
      });
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateRadarValueList({
          alias,
          name,
          item_type: itemType,
          metadata,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-radar-value-list-${instanceId}`,
          }),
        );
      }

      if (current === undefined) {
        return yield* new RadarValueListNotResolved({ alias });
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const nameChanged = current.name !== name;

      if (!nameChanged && !metadataChanged) {
        return toAttrs(current);
      }

      const updated = yield* UpdateRadarValueList({
        value_list: current.id,
        ...(nameChanged ? { name } : {}),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(
                  upsert.map((tag) => [tag.Key, tag.Value]),
                ),
                ...Object.fromEntries(removed.map((key) => [key, ""])),
              },
            }
          : {}),
      });
      return toAttrs(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteRadarValueList({ value_list: output.id }).pipe(
        Effect.catchIf(isMissingValueList, () => Effect.void),
      );
    }),
  });
