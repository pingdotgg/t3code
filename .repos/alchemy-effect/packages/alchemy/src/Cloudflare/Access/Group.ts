import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

/**
 * One arm of a Cloudflare Access group rule discriminated union. A rule is a
 * single-key object whose key selects the rule kind (`email`, `emailDomain`,
 * `everyone`, `ip`, `geo`, `serviceToken`, etc.) and whose value carries the
 * rule's parameters.
 *
 * Re-exported from `@distilled.cloud/cloudflare/zero-trust`'s
 * `CreateAccessGroupForAccountRequest` so the full Cloudflare rule surface is
 * available without re-declaring the union.
 */
export type GroupRule =
  zeroTrust.CreateAccessGroupForAccountRequest["include"][number];

export type GroupProps = {
  /**
   * Display name for the group. Used as a stable identifier so the provider
   * can locate the group by name during adoption / state recovery. If
   * omitted, a unique name is generated from the stack/stage/logical id.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Rules combined with logical OR. A user needs to meet only one of the
   * Include rules to match the group. Required and must be non-empty.
   */
  include: GroupRule[];
  /**
   * Rules combined with logical NOT. A user matching any Exclude rule does
   * not match the group, even if they satisfied an Include rule.
   */
  exclude?: GroupRule[];
  /**
   * Rules combined with logical AND. A user must satisfy every Require rule
   * in addition to an Include rule.
   */
  require?: GroupRule[];
  /**
   * Whether this is the default group for the Zero Trust organization.
   *
   * @default false
   */
  isDefault?: boolean;
};

export type Group = Resource<
  "Cloudflare.Access.Group",
  GroupProps,
  {
    /** UUID of the group assigned by Cloudflare. */
    groupId: string;
    /** Cloudflare account that owns the group. */
    accountId: string;
    /** Display name reported by Cloudflare. */
    name: string;
    /** Whether Cloudflare reports this group as the organization default. */
    isDefault: boolean | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust Access group — a reusable, account-scoped set of
 * Access rule criteria. Groups are referenced from Access policies via a
 * `{ group: { id } }` rule, letting many policies share one membership
 * definition.
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 * @section Creating a Group
 * @example Allow a single email domain
 * ```typescript
 * const group = yield* Cloudflare.Access.Group("ExampleDomain", {
 *   include: [{ emailDomain: { domain: "example.com" } }],
 * });
 * ```
 *
 * @example Combine include, exclude and require rules
 * ```typescript
 * const group = yield* Cloudflare.Access.Group("UsEngineers", {
 *   include: [{ emailDomain: { domain: "example.com" } }],
 *   exclude: [{ email: { email: "intern@example.com" } }],
 *   require: [{ geo: { countryCode: "US" } }],
 * });
 * ```
 *
 * @section Referencing a Group from a Policy
 * @example Allow members of the group
 * ```typescript
 * const group = yield* Cloudflare.Access.Group("Team", {
 *   include: [{ emailDomain: { domain: "example.com" } }],
 * });
 *
 * const policy = yield* Cloudflare.Access.Policy("AllowTeam", {
 *   decision: "allow",
 *   include: [{ group: { id: group.groupId } }],
 * });
 * ```
 */
export const Group = Resource<Group>("Cloudflare.Access.Group");

export const isGroup = (value: unknown): value is Group =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === "Cloudflare.Access.Group";

export const GroupProvider = () =>
  Provider.succeed(Group, {
    stables: ["groupId", "accountId"],
    diff: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // Everything else (name, rules, isDefault) converges via PUT.
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      if (output?.groupId) {
        const direct = yield* zeroTrust
          .getAccessGroupForAccount({
            accountId: acct,
            groupId: output.groupId,
          })
          .pipe(
            Effect.map(toObserved),
            Effect.catchTag("AccessGroupNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
        if (direct && direct.id) {
          return {
            groupId: direct.id,
            accountId: acct,
            name: direct.name ?? output.name,
            isDefault: direct.isDefault ?? output.isDefault,
          };
        }
      }
      const name = yield* createGroupName(id, olds?.name ?? output?.name);
      const existing = yield* findGroupByName(acct, name);
      if (!existing || !existing.id) return undefined;
      return {
        groupId: existing.id,
        accountId: acct,
        name: existing.name ?? name,
        isDefault: existing.isDefault ?? undefined,
      };
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listAccessGroupsForAccount
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? [])
                .filter(
                  (g): g is (typeof page.result)[number] & { id: string } =>
                    g.id != null,
                )
                .map((g) => ({
                  groupId: g.id,
                  accountId,
                  name: g.name ?? "",
                  isDefault: g.isDefault ?? undefined,
                })),
            ),
          ),
        );
    }),
    reconcile: Effect.fn(function* ({ id, news = {} as GroupProps, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createGroupName(id, news.name);
      const acct = output?.accountId ?? accountId;

      // Observe — prefer the cached groupId, fall back to a name lookup so
      // we recover from out-of-band deletes and partial state-persistence
      // failures.
      let observed: ObservedGroup | undefined;
      if (output?.groupId) {
        observed = yield* zeroTrust
          .getAccessGroupForAccount({
            accountId: acct,
            groupId: output.groupId,
          })
          .pipe(
            Effect.map(toObserved),
            Effect.catchTag("AccessGroupNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      }
      if (!observed) {
        observed = yield* findGroupByName(acct, name);
      }

      // Ensure — create the group when missing. Tolerate a race where a
      // parallel actor created the same-named group by re-observing.
      let ensured: ObservedGroup;
      if (!observed || !observed.id) {
        ensured = yield* zeroTrust
          .createAccessGroupForAccount({
            accountId: acct,
            name,
            include: news.include,
            exclude: news.exclude,
            require: news.require,
            isDefault: news.isDefault,
          })
          .pipe(
            Effect.map(toObserved),
            Effect.catch((err) =>
              Effect.gen(function* () {
                const existing = yield* findGroupByName(acct, name);
                if (existing && existing.id) return existing;
                return yield* Effect.fail(err);
              }),
            ),
          );
      } else {
        // Sync — Cloudflare PUTs the group as a whole replacement, so a
        // single update converges every mutable field (name, rule sets,
        // isDefault). The API is idempotent for equal payloads.
        const prior = observed;
        const updated = yield* zeroTrust.updateAccessGroupForAccount({
          accountId: acct,
          groupId: prior.id!,
          name,
          include: news.include,
          exclude: news.exclude,
          require: news.require,
          isDefault: news.isDefault,
        });
        ensured = {
          id: updated.id ?? prior.id,
          name: updated.name ?? prior.name,
          isDefault: updated.isDefault ?? prior.isDefault,
        };
      }

      if (!ensured.id) {
        return yield* Effect.fail(new Error("Group: ensured group missing id"));
      }
      return {
        groupId: ensured.id,
        accountId: acct,
        name: ensured.name ?? name,
        isDefault: ensured.isDefault ?? news.isDefault,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteAccessGroupForAccount({
          accountId: output.accountId,
          groupId: output.groupId,
        })
        .pipe(Effect.catchTag("AccessGroupNotFound", () => Effect.void));
    }),
  });

const createGroupName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id });
  });

const findGroupByName = (acct: string, name: string) =>
  zeroTrust.listAccessGroupsForAccount.items({ accountId: acct }).pipe(
    Stream.filter((g): g is ObservedGroup => g.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.catch(() => Effect.succeed(undefined)),
  );

type ObservedGroup = {
  id?: string | null;
  name?: string | null;
  isDefault?: boolean | null;
};

const toObserved = (g: ObservedGroup): ObservedGroup => ({
  id: g.id,
  name: g.name,
  isDefault: g.isDefault,
});
