import * as iam from "@distilled.cloud/cloudflare/iam";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Iam.ResourceGroup" as const;
type TypeId = typeof TypeId;

/**
 * The scope of a resource group — a scope key (e.g.
 * `com.cloudflare.api.account.{accountId}`) plus the objects it contains
 * (e.g. `com.cloudflare.api.account.zone.{zoneId}` or `*` for everything
 * in the scope).
 */
export interface ResourceGroupScopeInput {
  /**
   * The scope key, e.g. `com.cloudflare.api.account.{accountId}`.
   */
  key: string;
  /**
   * The objects within the scope this resource group spans, e.g.
   * `com.cloudflare.api.account.zone.{zoneId}` or `*`.
   */
  objects: { key: string }[];
}

/**
 * A fully-resolved resource group scope as observed on Cloudflare.
 */
export interface ResourceGroupScope {
  /** The scope key, e.g. `com.cloudflare.api.account.{accountId}`. */
  key: string;
  /** The objects within the scope this resource group spans. */
  objects: { key: string }[];
}

export interface ResourceGroupProps {
  /**
   * Name of the resource group. If omitted, a unique name is generated
   * from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The scope of the resource group: a scope key (typically
   * `com.cloudflare.api.account.{accountId}`) and the objects it
   * contains (zones, or `*` for the whole account). Mutable in place.
   */
  scope: ResourceGroupScopeInput;
}

export interface ResourceGroupAttributes {
  /** Cloudflare-assigned identifier of the resource group. */
  resourceGroupId: string;
  /** The Cloudflare account the resource group belongs to. */
  accountId: string;
  /** Name of the resource group. */
  name: string;
  /** The scope of the resource group as observed on Cloudflare. */
  scope: ResourceGroupScope;
}

export type ResourceGroup = Resource<
  TypeId,
  ResourceGroupProps,
  ResourceGroupAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare IAM resource group — a named set of account resources
 * (zones, or the whole account) that fine-grained policies attach to.
 *
 * Resource groups pair with permission groups inside a user group policy:
 * the permission group says *what* actions are allowed, the resource group
 * says *which* resources they apply to. Both `name` and `scope` are mutable
 * in place.
 *
 * Account-scoped IAM (resource groups, user groups) is an Enterprise
 * feature.
 * @resource
 * @product IAM
 * @category Account & Identity
 * @section Creating a Resource Group
 * @example Scope a group to the whole account
 * ```typescript
 * const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
 * const group = yield* Cloudflare.Iam.ResourceGroup("AllResources", {
 *   scope: {
 *     key: `com.cloudflare.api.account.${accountId}`,
 *     objects: [{ key: "*" }],
 *   },
 * });
 * ```
 *
 * @example Scope a group to a single zone
 * ```typescript
 * const group = yield* Cloudflare.Iam.ResourceGroup("ZoneOnly", {
 *   name: "my-zone-resources",
 *   scope: {
 *     key: `com.cloudflare.api.account.${accountId}`,
 *     objects: [
 *       { key: `com.cloudflare.api.account.zone.${zone.zoneId}` },
 *     ],
 *   },
 * });
 * ```
 *
 * @section Using with User Groups
 * @example Attach to a user group policy
 * ```typescript
 * yield* Cloudflare.Iam.UserGroup("Readers", {
 *   policies: [
 *     {
 *       access: "allow",
 *       permissionGroups: [readOnlyPermissionGroupId],
 *       resourceGroups: [group.resourceGroupId],
 *     },
 *   ],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/fundamentals/manage-members/scoped-roles/
 */
export const ResourceGroup = Resource<ResourceGroup>(TypeId);

/**
 * Returns true if the given value is an ResourceGroup resource.
 */
export const isResourceGroup = (value: unknown): value is ResourceGroup =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ResourceGroupProvider = () =>
  Provider.succeed(ResourceGroup, {
    stables: ["resourceGroupId", "accountId"],

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.resourceGroupId) {
        const observed = yield* getResourceGroup(acct, output.resourceGroupId);
        if (observed) return toAttributes(observed, acct);
        return undefined;
      }

      // Cold read — recover from lost state by matching the deterministic
      // physical name. Names are not unique on Cloudflare's side; an exact
      // match on our generated/explicit name is the best identity we have.
      const name = yield* createGroupName(id, olds?.name);
      const match = yield* findByName(acct, name);
      return match ? toAttributes(match, acct) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createGroupName(id, news.name);
      // Inputs have been resolved to concrete strings by Plan.
      const desiredScope = resolveScope(news.scope);

      // 1. Observe — the id cached on `output` is a hint, not a guarantee:
      //    a missing group falls through to the name scan and then create.
      let observed = output?.resourceGroupId
        ? yield* getResourceGroup(accountId, output.resourceGroupId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, name);
      }

      // 2. Ensure — create when missing. Names are not unique on
      //    Cloudflare's side, so there is no AlreadyExists race to tolerate.
      if (!observed) {
        const created = yield* iam.createResourceGroup({
          accountId,
          name,
          scope: desiredScope,
        });
        return toAttributes(created, accountId);
      }

      // 3. Sync — diff observed name/scope against desired; the update is
      //    a PUT, so send the full body, but skip the call on a no-op.
      const observedScope = parseScope(observed.scope);
      const dirty =
        (observed.name ?? "") !== name ||
        !sameScope(observedScope, desiredScope);
      if (!dirty) {
        return toAttributes(observed, accountId);
      }

      const updated = yield* iam.updateResourceGroup({
        accountId,
        resourceGroupId: observed.id,
        name,
        scope: desiredScope,
      });
      return toAttributes(updated, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteResourceGroup({
          accountId: output.accountId,
          resourceGroupId: output.resourceGroupId,
        })
        .pipe(Effect.catchTag("ResourceGroupNotFound", () => Effect.void));
    }),

    // Account collection — the list op returns the full group record (id,
    // name, scope) per page, so each item maps straight to the `read`
    // Attributes shape without a per-item GET. Predefined/system resource
    // groups are returned alongside ours, so a read-only list is often
    // non-empty. Cloudflare paginates a single page set; exhaust it.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* iam.listResourceGroups.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              // Cloudflare seeds every account with predefined, non-editable
              // system resource groups named `com.cloudflare.api.account.*`.
              // They can't be deleted (`UnprocessableEntity: non-editable`),
              // so exclude them from enumeration.
              .filter((group) => !isSystemGroupName(group.name))
              .map((group) => toAttributes(group, accountId)),
          ),
        ),
      );
    }),
  });

type ObservedResourceGroup = {
  id: string;
  name?: string | null;
  scope: unknown;
};

/**
 * Cloudflare's predefined, non-editable account resource groups use the
 * reserved `com.cloudflare.api.account.*` name. They are seeded on every
 * account and cannot be deleted, so they must be excluded from enumeration.
 */
const isSystemGroupName = (name: string | null | undefined): boolean =>
  (name ?? "").startsWith("com.cloudflare.api.");

/**
 * Read a resource group by id, mapping "gone" (`ResourceGroupNotFound`,
 * HTTP 404 / Cloudflare error code 404) to `undefined`.
 */
const getResourceGroup = (accountId: string, resourceGroupId: string) =>
  iam.getResourceGroup({ accountId, resourceGroupId }).pipe(
    Effect.map((g): ObservedResourceGroup | undefined => g),
    Effect.catchTag("ResourceGroupNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a resource group by exact name. Names are not unique on
 * Cloudflare's side; pick the lexicographically-first id for determinism.
 */
const findByName = (accountId: string, name: string) =>
  iam.listResourceGroups.items({ accountId, name }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .filter(
          (g): g is ObservedResourceGroup & { name: string } => g.name === name,
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .at(0),
    ),
  );

const createGroupName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

/** Resolve `Input<string>` scope fields to concrete strings (post-Plan). */
const resolveScope = (scope: ResourceGroupScopeInput): ResourceGroupScope => ({
  key: scope.key as string,
  objects: scope.objects.map((o) => ({ key: o.key as string })),
});

/**
 * Decode the `unknown`-typed observed scope into our structured shape.
 * Cloudflare always returns `{ key, objects: [{ key }] }` for a persisted
 * resource group.
 */
const parseScope = (scope: unknown): ResourceGroupScope => {
  const key =
    Predicate.hasProperty(scope, "key") && typeof scope.key === "string"
      ? scope.key
      : "";
  const objects =
    Predicate.hasProperty(scope, "objects") && Array.isArray(scope.objects)
      ? scope.objects.flatMap((o: unknown) =>
          Predicate.hasProperty(o, "key") && typeof o.key === "string"
            ? [{ key: o.key }]
            : [],
        )
      : [];
  return { key, objects };
};

const sameScope = (a: ResourceGroupScope, b: ResourceGroupScope) =>
  a.key === b.key &&
  a.objects.length === b.objects.length &&
  a.objects
    .map((o) => o.key)
    .sort()
    .join(",") ===
    b.objects
      .map((o) => o.key)
      .sort()
      .join(",");

const toAttributes = (
  group: ObservedResourceGroup,
  accountId: string,
): ResourceGroupAttributes => ({
  resourceGroupId: group.id,
  accountId,
  name: group.name ?? "",
  scope: parseScope(group.scope),
});
