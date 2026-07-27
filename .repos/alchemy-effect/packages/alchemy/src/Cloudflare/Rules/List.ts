import * as rules from "@distilled.cloud/cloudflare/rules";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Rules.List" as const;
type TypeId = typeof TypeId;

/**
 * The type of a list. Each kind supports specific list items: IP addresses,
 * ASNs, hostnames, or URL redirects. Cannot be changed after creation.
 */
export type ListKind = "ip" | "asn" | "hostname" | "redirect";

/**
 * An item in an `ip` list — an IPv4/IPv6 address or CIDR range
 * (IPv4 prefixes /8–/32, IPv6 prefixes /4–/64).
 */
export type ListIpItem = {
  /**
   * An IPv4 address, IPv4 CIDR, IPv6 address, or IPv6 CIDR.
   */
  ip: string;
  /**
   * An informative summary of the item.
   */
  comment?: string;
};

/**
 * An item in an `asn` list — an autonomous system number.
 */
export type ListAsnItem = {
  /**
   * A non-negative 32 bit integer.
   */
  asn: number;
  /**
   * An informative summary of the item.
   */
  comment?: string;
};

/**
 * An item in a `hostname` list.
 */
export type ListHostnameItem = {
  /**
   * Valid characters for hostnames are ASCII(7) letters from a to z, the
   * digits from 0 to 9, wildcards (*), and the hyphen (-).
   */
  hostname: {
    /**
     * The hostname to match, e.g. `example.com` or `*.example.com`.
     */
    urlHostname: string;
    /**
     * Only applies to wildcard hostnames (e.g., *.example.com). When `true`,
     * only subdomains are blocked. When `false`, both the root domain and
     * subdomains are blocked.
     * @default false
     */
    excludeExactHostname?: boolean;
  };
  /**
   * An informative summary of the item.
   */
  comment?: string;
};

/**
 * An item in a `redirect` list — a source/target URL pair used by Bulk
 * Redirect rules.
 */
export type ListRedirectItem = {
  /**
   * The definition of the redirect.
   */
  redirect: {
    /**
     * The source URL to match, e.g. `example.com/old-path`.
     */
    sourceUrl: string;
    /**
     * The URL to redirect to.
     */
    targetUrl: string;
    /**
     * Whether the redirect also matches subdomains of the source URL.
     * @default false
     */
    includeSubdomains?: boolean;
    /**
     * Whether the redirect target URL keeps the path suffix of the request.
     * @default false
     */
    preservePathSuffix?: boolean;
    /**
     * Whether the redirect target URL keeps the query string of the request.
     * @default false
     */
    preserveQueryString?: boolean;
    /**
     * The HTTP status code used for the redirect.
     * @default "301"
     */
    statusCode?: "301" | "302" | "307" | "308";
    /**
     * Whether the redirect also matches subpaths of the source URL.
     * @default false
     */
    subpathMatching?: boolean;
  };
  /**
   * An informative summary of the item.
   */
  comment?: string;
};

/**
 * An item in an account list. The shape must match the list `kind`:
 * `{ ip }` for `ip` lists, `{ asn }` for `asn` lists, `{ hostname }` for
 * `hostname` lists, and `{ redirect }` for `redirect` lists.
 */
export type ListItem =
  | ListIpItem
  | ListAsnItem
  | ListHostnameItem
  | ListRedirectItem;

export type ListProps = {
  /**
   * An informative name for the list, used in filter and rule expressions
   * (e.g. `ip.src in $my_list`). Must contain only letters, numbers, and
   * underscores (max 50 characters). If omitted, a unique name is generated
   * from the app, stage, and logical ID. Cannot be changed after creation —
   * updating this property triggers a replacement.
   * @default ${app}_${stage}_${id}
   */
  name?: string;
  /**
   * The type of the list. Each kind supports specific list items
   * (IP addresses, ASNs, hostnames, or redirects). Cannot be changed after
   * creation — updating this property triggers a replacement.
   */
  kind: ListKind;
  /**
   * An informative summary of the list.
   */
  description?: string;
  /**
   * The full contents of the list. Items are replaced idempotently via the
   * bulk items operation: the provider diffs the observed items against this
   * desired set and, on any delta, replaces the entire list contents and
   * polls the asynchronous bulk operation to completion.
   * @default []
   */
  items?: ListItem[];
};

export type ListAttributes = {
  /**
   * The unique ID of the list.
   */
  listId: string;
  /**
   * The Cloudflare account the list belongs to.
   */
  accountId: string;
  /**
   * The name of the list, usable in rule expressions as `$name`.
   */
  name: string;
  /**
   * The type of the list.
   */
  kind: ListKind;
  /**
   * An informative summary of the list.
   */
  description: string | undefined;
  /**
   * The number of items in the list.
   */
  numItems: number;
  /**
   * The number of filters referencing the list.
   */
  numReferencingFilters: number;
  /**
   * The RFC 3339 timestamp of when the list was created.
   */
  createdOn: string;
  /**
   * The RFC 3339 timestamp of when the list was last modified.
   */
  modifiedOn: string;
};

export type List = Resource<
  TypeId,
  ListProps,
  ListAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare account-level List (Lists API) — a named collection of IP
 * addresses, ASNs, hostnames, or URL redirects referenced from ruleset
 * expressions (`ip.src in $my_list`) and Bulk Redirect rules.
 *
 * `name` and `kind` are immutable and changing either triggers a
 * replacement. The list's items are managed as part of the resource: on any
 * change the full contents are replaced via the asynchronous bulk items
 * operation, which the provider polls to completion.
 * @resource
 * @product Rules
 * @category Rules & Configuration
 * @section Creating a List
 * @example IP list with items
 * ```typescript
 * const blocklist = yield* Cloudflare.Rules.List("blocklist", {
 *   kind: "ip",
 *   description: "Known bad actors",
 *   items: [
 *     { ip: "203.0.113.7", comment: "scanner" },
 *     { ip: "198.51.100.0/24" },
 *   ],
 * });
 * ```
 *
 * @example ASN list with an explicit name
 * ```typescript
 * const asns = yield* Cloudflare.Rules.List("bad-asns", {
 *   name: "bad_asns",
 *   kind: "asn",
 *   items: [{ asn: 64496 }, { asn: 64511, comment: "spam network" }],
 * });
 * ```
 *
 * @example Redirect list for Bulk Redirects
 * ```typescript
 * const redirects = yield* Cloudflare.Rules.List("redirects", {
 *   kind: "redirect",
 *   items: [
 *     {
 *       redirect: {
 *         sourceUrl: "example.com/old",
 *         targetUrl: "https://example.com/new",
 *         statusCode: "301",
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @section Referencing a List from rules
 * @example Use the list name in a Ruleset expression
 * ```typescript
 * const list = yield* Cloudflare.Rules.List("blocklist", { kind: "ip" });
 *
 * // The stable `name` attribute interpolates into rule expressions:
 * // `ip.src in $<name>`
 * const expression = list.name.apply((name) => `ip.src in $${name}`);
 * ```
 *
 * @see https://developers.cloudflare.com/waf/tools/lists/
 */
export const List = Resource<List>(TypeId);

/**
 * Returns true if the given value is a List resource.
 */
export const isList = (value: unknown): value is List =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * The asynchronous bulk items operation finished in a non-`completed`
 * state (or never completed within the polling budget).
 */
export class ListBulkOperationError extends Data.TaggedError(
  "ListBulkOperationError",
)<{
  readonly operationId: string;
  readonly status: string;
  readonly message?: string;
}> {}

export const ListProvider = () =>
  Provider.succeed(List, {
    stables: ["listId", "accountId", "name", "kind", "createdOn"],
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* rules.listLists.items({ accountId }).pipe(
        Stream.map((list) => toAttributes(list, accountId)),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
    }),
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // Lists cannot be renamed and the kind is immutable.
      const oldName = output?.name ?? olds?.name;
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const desiredName = news.name ?? oldName;
      if (oldName !== undefined && desiredName !== oldName) {
        return { action: "replace" } as const;
      }
      const oldKind = output?.kind ?? olds?.kind;
      if (oldKind !== undefined && news.kind !== oldKind) {
        // List names are unique per account. When the name is unchanged the
        // replacement cannot be create-first (the create would collide with
        // the old list), so delete the old list before creating the new one.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.listId) {
        const observed = yield* getListById(acct, output.listId);
        return observed ? toAttributes(observed, acct) : undefined;
      }
      // Cold read — recover from lost state by matching the deterministic
      // physical name. List names are unique per account, so an exact match
      // is authoritative.
      const name = yield* createListName(id, olds?.name);
      const match = yield* findByName(acct, name);
      return match ? toAttributes(match, acct) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Prefer the deployed name: regenerating would target a different
      // resource if the generator's output for this id ever drifts.
      const name = yield* createListName(id, news.name ?? output?.name);

      // Observe — the listId cached on `output` is a hint, not a guarantee:
      // a missing list falls through to "missing" and ensure recreates.
      let observed = output?.listId
        ? yield* getListById(output.accountId ?? accountId, output.listId)
        : undefined;
      const acct = observed ? (output?.accountId ?? accountId) : accountId;

      // Ensure — create when missing. A duplicate-name conflict is a race
      // (or an out-of-band create): adopt the existing list with that name
      // when its kind matches. When the kind differs the list cannot be
      // converged in place (kind is immutable and names are unique), so the
      // stale list is deleted and recreated — this is how a replacement of
      // an explicitly-named list lands, since a create-first replacement
      // would always collide on the name.
      if (!observed) {
        const create = rules.createList({
          accountId: acct,
          name,
          kind: news.kind,
          description: news.description,
        });
        observed = yield* create.pipe(
          Effect.catchTag("ListAlreadyExists", (error) =>
            findByName(acct, name).pipe(
              Effect.flatMap((match) => {
                if (!match) return Effect.fail(error);
                if (match.kind === news.kind) return Effect.succeed(match);
                return rules
                  .deleteList({ accountId: acct, listId: match.id })
                  .pipe(
                    Effect.catchTag("ListNotFound", () => Effect.void),
                    Effect.flatMap(() => create),
                  );
              }),
            ),
          ),
        );
      }

      // Sync description — diff observed cloud state against desired and
      // skip the API call entirely on a no-op.
      if ((observed.description ?? undefined) !== news.description) {
        observed = yield* rules.updateList({
          accountId: acct,
          listId: observed.id,
          description: news.description,
        });
      }

      // Sync items — read the observed items fresh from the cloud, compare
      // against the desired set (keyed on value fields + comment, ignoring
      // server-assigned ids/timestamps), and on any delta replace the full
      // contents via the asynchronous bulk PUT, polling it to completion.
      const desiredItems = news.items ?? [];
      const observedItems = yield* listAllItems(acct, observed.id);
      if (!sameItems(observedItems, desiredItems)) {
        const { operationId } = yield* rules.updateListItem({
          accountId: acct,
          listId: observed.id,
          body: desiredItems,
        });
        yield* awaitBulkOperation(acct, operationId);
      }

      // Return — re-read so eventually-consistent counters (numItems) and
      // timestamps are as fresh as possible.
      const final = yield* getListById(acct, observed.id);
      return toAttributes(final ?? observed, acct);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Cloudflare's delete is itself idempotent (deleting a missing list
      // succeeds), but tolerate a typed not-found anyway.
      yield* rules
        .deleteList({
          accountId: output.accountId,
          listId: output.listId,
        })
        .pipe(Effect.catchTag("ListNotFound", () => Effect.void));
    }),
  });

type ObservedList = rules.GetListResponse;

/**
 * List names only allow letters, numbers, and underscores (max 50 chars), so
 * the generated physical name swaps the default hyphen delimiter for an
 * underscore.
 */
const createListName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    const generated = yield* createPhysicalName({
      id,
      lowercase: true,
      delimiter: "_",
      maxLength: 50,
    });
    return generated.replaceAll("-", "_");
  });

/**
 * Read a list by id, mapping "gone" (`ListNotFound`, Cloudflare error code
 * 10001) to `undefined`.
 */
const getListById = (accountId: string, listId: string) =>
  rules
    .getList({ accountId, listId })
    .pipe(Effect.catchTag("ListNotFound", () => Effect.succeed(undefined)));

/**
 * Find a list by exact name. List names are unique per account.
 */
const findByName = (accountId: string, name: string) =>
  rules.listLists.items({ accountId }).pipe(
    Stream.filter((list) => list.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

/**
 * Read the full observed contents of a list (all pages).
 */
const listAllItems = (accountId: string, listId: string) =>
  rules.listListItems.items({ accountId, listId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

type ComparableItem = ListItem | rules.GetListItemResponse;

/**
 * Canonicalize an item (desired prop or observed response) into a stable
 * string key: server-assigned ids/timestamps are ignored and optional fields
 * are normalized to their API defaults so omitted props compare equal to the
 * defaults the API materializes.
 */
const canonicalItem = (item: ComparableItem): string => {
  const comment =
    "comment" in item && item.comment != null && item.comment !== ""
      ? item.comment
      : undefined;
  if ("ip" in item) {
    return JSON.stringify({ ip: item.ip, comment });
  }
  if ("asn" in item) {
    return JSON.stringify({ asn: item.asn, comment });
  }
  if ("hostname" in item) {
    return JSON.stringify({
      hostname: {
        urlHostname: item.hostname.urlHostname,
        excludeExactHostname: item.hostname.excludeExactHostname ?? false,
      },
      comment,
    });
  }
  return JSON.stringify({
    redirect: {
      sourceUrl: item.redirect.sourceUrl,
      targetUrl: item.redirect.targetUrl,
      includeSubdomains: item.redirect.includeSubdomains ?? false,
      preservePathSuffix: item.redirect.preservePathSuffix ?? false,
      preserveQueryString: item.redirect.preserveQueryString ?? false,
      statusCode: item.redirect.statusCode ?? "301",
      subpathMatching: item.redirect.subpathMatching ?? false,
    },
    comment,
  });
};

/**
 * Compare observed and desired items as multisets of canonical keys.
 */
const sameItems = (
  observed: readonly ComparableItem[],
  desired: readonly ComparableItem[],
) => {
  if (observed.length !== desired.length) return false;
  const a = observed.map(canonicalItem).sort();
  const b = desired.map(canonicalItem).sort();
  return a.every((key, i) => key === b[i]);
};

/**
 * Poll an asynchronous bulk items operation until it reaches a terminal
 * state, failing with a typed error when it does not complete successfully.
 */
const awaitBulkOperation = (accountId: string, operationId: string) =>
  Effect.gen(function* () {
    const operation = yield* rules
      .getListBulkOperation({ accountId, operationId })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (op) => op.status === "completed" || op.status === "failed",
          times: 90,
        }),
      );
    if (operation.status !== "completed") {
      return yield* Effect.fail(
        new ListBulkOperationError({
          operationId,
          status: operation.status,
          message: "error" in operation ? operation.error : undefined,
        }),
      );
    }
  });

const toAttributes = (
  list: ObservedList,
  accountId: string,
): ListAttributes => ({
  listId: list.id,
  accountId,
  name: list.name,
  // Distilled widens generated string enums to open unions (`string & {}`).
  kind: list.kind as ListKind,
  description: list.description ?? undefined,
  numItems: list.numItems,
  numReferencingFilters: list.numReferencingFilters,
  createdOn: list.createdOn,
  modifiedOn: list.modifiedOn,
});
