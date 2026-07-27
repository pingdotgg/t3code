import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { arrayEqualsUnordered } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Gateway.List" as const;
type TypeId = typeof TypeId;

/**
 * The kind of values a Gateway list holds. Immutable — changing the type
 * triggers a replacement.
 */
export type ListType =
  | "SERIAL"
  | "URL"
  | "DOMAIN"
  | "EMAIL"
  | "IP"
  | "CATEGORY"
  | "LOCATION"
  | "DEVICE"
  | "AAGUID";

/**
 * A single entry in a Gateway list.
 */
export interface ListItem {
  /**
   * The item's value — a domain, URL, IP, email, serial number, etc.
   * depending on the list's `type`.
   */
  value: string;
  /**
   * Optional free-form description of the item.
   */
  description?: string;
}

export interface ListProps {
  /**
   * Display name for the list. Used as a stable identifier so the provider
   * can locate the list by name during adoption / state recovery. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The kind of values the list holds (DOMAIN, IP, URL, EMAIL, SERIAL,
   * CATEGORY, LOCATION, DEVICE, AAGUID). Immutable — changing the type
   * triggers a replacement.
   */
  type: ListType;
  /**
   * Free-form description of the list. Mutable.
   *
   * @default ""
   */
  description?: string;
  /**
   * Entries in the list. Reconciled as a full set via PUT — items present
   * here and missing in the cloud are added; extra cloud items are removed.
   *
   * @default []
   */
  items?: ListItem[];
}

export interface ListAttributes {
  /** UUID of the list, assigned by Cloudflare. */
  listId: string;
  /** Cloudflare account that owns the list. */
  accountId: string;
  /** Display name of the list. */
  name: string;
  /** The kind of values the list holds. */
  type: ListType;
  /** Description of the list. */
  description: string;
  /** Current entries in the list. */
  items: ListItem[];
  /** Number of entries in the list. */
  count: number;
  /** ISO8601 creation timestamp. */
  createdAt: string | undefined;
  /** ISO8601 last-update timestamp. */
  updatedAt: string | undefined;
}

export type List = Resource<
  TypeId,
  ListProps,
  ListAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust Gateway list — a named set of domains, IPs,
 * URLs, emails, serial numbers, or device IDs referenced from Gateway
 * rule wirefilter expressions by UUID (`$<listId>`).
 *
 * The list's `type` is immutable (changing it replaces the list); name,
 * description, and items all converge in place. Items are managed as a
 * full set — the provider PUTs the complete desired item set and removes
 * anything not declared.
 * @resource
 * @product Gateway
 * @category Cloudflare One (Zero Trust)
 * @section Creating a List
 * @example Domain list
 * ```typescript
 * const blocked = yield* Cloudflare.Gateway.List("BlockedDomains", {
 *   type: "DOMAIN",
 *   description: "domains blocked org-wide",
 *   items: [
 *     { value: "badsite.example.com" },
 *     { value: "malware.example.net", description: "known C2" },
 *   ],
 * });
 * ```
 *
 * @example IP list
 * ```typescript
 * const egress = yield* Cloudflare.Gateway.List("OfficeEgress", {
 *   type: "IP",
 *   items: [{ value: "203.0.113.0/24" }],
 * });
 * ```
 *
 * @section Referencing from a Gateway Rule
 * @example Block DNS lookups for every domain in the list
 * ```typescript
 * yield* Cloudflare.Gateway.Rule("BlockListedDomains", {
 *   action: "block",
 *   filters: ["dns"],
 *   traffic: `any(dns.domains[*] in $${blocked.listId})`,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/policies/gateway/lists/
 */
export const List = Resource<List>(TypeId);

/**
 * Returns true if the given value is a List resource.
 */
export const isList = (value: unknown): value is List =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ListProvider = () =>
  Provider.succeed(List, {
    stables: ["listId", "accountId", "type", "createdAt"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const lists = yield* zeroTrust.listGatewayLists.items({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
      return lists.map((list) => toAttributes(list, accountId));
    }),

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The list type is immutable on Cloudflare's side.
      const oldType = output?.type ?? (olds as ListProps).type;
      if (oldType !== undefined && oldType !== news.type) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path — refresh by the cached list id.
      if (output?.listId) {
        const observed = yield* getList(acct, output.listId);
        if (observed) return toAttributes(observed, acct);
      }

      // Cold read — locate by deterministic name. Gateway lists carry no
      // ownership markers, so report the match as Unowned to gate adoption.
      const name = yield* resolveName(id, olds?.name ?? output?.name);
      const match = yield* findByName(acct, name);
      if (match?.id) {
        const observed = yield* getList(acct, match.id);
        if (observed) return Unowned(toAttributes(observed, acct));
      }
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* resolveName(id, news.name);
      const desiredItems = news.items ?? [];

      // 1. Observe — the cached id is a hint, not a guarantee; fall back
      //    to a name scan so out-of-band deletes / lost state converge.
      let observed = output?.listId
        ? yield* getList(accountId, output.listId)
        : undefined;
      if (!observed) {
        const match = yield* findByName(accountId, name);
        if (match?.id) observed = yield* getList(accountId, match.id);
      }

      // 2. Ensure — create with the full desired body when missing. Names
      //    are not unique on Cloudflare's side, so there is no
      //    AlreadyExists race to tolerate.
      if (!observed) {
        const created = yield* zeroTrust.createGatewayList({
          accountId,
          name,
          type: news.type,
          description: news.description,
          items: desiredItems,
        });
        if (!created.id) {
          return yield* Effect.fail(
            new Error("Cloudflare did not return an id for the Gateway list"),
          );
        }
        // Create echoes items without count — re-read for a full shape.
        const fresh = yield* getList(accountId, created.id);
        return toAttributes(
          fresh ?? { ...created, count: desiredItems.length },
          accountId,
        );
      }

      // 3. Sync — diff observed name/description/items against desired;
      //    the update API is a PUT of the full mutable state, so skip the
      //    call entirely on a no-op. Items compare as an unordered set of
      //    values (the API may reorder).
      const observedItems = (observed.items ?? []).map((i) => ({
        value: i.value ?? "",
        ...(i.description != null ? { description: i.description } : {}),
      }));
      const dirty =
        observed.name !== name ||
        (news.description !== undefined &&
          (observed.description ?? "") !== news.description) ||
        !sameItems(observedItems, desiredItems);
      if (dirty) {
        yield* zeroTrust.updateGatewayList({
          accountId,
          listId: observed.id!,
          name,
          description: news.description ?? observed.description ?? undefined,
          items: desiredItems,
        });
        // PUT echoes count but not items — re-read for the full shape.
        const fresh = yield* getList(accountId, observed.id!);
        if (fresh) return toAttributes(fresh, accountId);
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Lists still referenced by Gateway rules can fail deletion — rules
      // that reference the list id as an Input get correct destroy
      // ordering. A missing list (GatewayListNotFound, code 2218) means
      // we're done.
      yield* zeroTrust
        .deleteGatewayList({
          accountId: output.accountId,
          listId: output.listId,
        })
        .pipe(Effect.catchTag("GatewayListNotFound", () => Effect.void));
    }),
  });

type ObservedList = zeroTrust.GetGatewayListResponse;

/**
 * Read a list by id, mapping "gone" (`GatewayListNotFound`, Cloudflare
 * error code 2218) to `undefined`.
 */
const getList = (accountId: string, listId: string) =>
  zeroTrust.getGatewayList({ accountId, listId }).pipe(
    Effect.map((l): ObservedList | undefined => l),
    Effect.catchTag("GatewayListNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a list by exact name. Names are not unique on Cloudflare's side;
 * pick the oldest match for determinism.
 */
const findByName = (accountId: string, name: string) =>
  zeroTrust.listGatewayLists.items({ accountId }).pipe(
    Stream.filter((l) => l.name === name),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
        .at(0),
    ),
  );

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id, lowercase: true });
  });

const sameItems = (
  observed: ReadonlyArray<ListItem>,
  desired: ReadonlyArray<ListItem>,
): boolean =>
  arrayEqualsUnordered(
    observed.map((i) => `${i.value} ${i.description ?? ""}`),
    desired.map((i) => `${i.value} ${i.description ?? ""}`),
  );

const toAttributes = (
  list: ObservedList & { count?: number | null },
  accountId: string,
): ListAttributes => ({
  listId: list.id ?? "",
  accountId,
  name: list.name ?? "",
  type: (list.type ?? "DOMAIN") as ListType,
  description: list.description ?? "",
  items: (list.items ?? []).map((i) => ({
    value: i.value ?? "",
    ...(i.description != null ? { description: i.description } : {}),
  })),
  count: list.count ?? (list.items ?? []).length,
  createdAt: list.createdAt ?? undefined,
  updatedAt: list.updatedAt ?? undefined,
});
