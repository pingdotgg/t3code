import {
  PERMISSION_GROUPS_BY_NAME,
  type PermissionGroupName,
} from "./PermissionGroups.ts";

/**
 * Resource keys recognized by Cloudflare API token policies.
 *
 * Cloudflare requires the account ID to be embedded directly in the resource
 * key (e.g. `com.cloudflare.api.account.<accountId>`); pass the fully-qualified
 * key — no rewriting is performed.
 *
 * @see https://developers.cloudflare.com/fundamentals/api/reference/permissions/
 */
export type ResourceKey =
  | `com.cloudflare.api.account.${string}`
  | `com.cloudflare.api.account.zone.${string}`
  | `com.cloudflare.edge.r2.bucket.${string}`
  | (string & {});

/**
 * A permission group reference: either a typed Cloudflare permission-group
 * name (resolved against the static catalog) or an explicit `{ id }` for
 * names that aren't in the catalog or have multiple scopes.
 */
export type PermissionGroupRef =
  | PermissionGroupName
  | { id: string; meta?: { key?: string; value?: string } };

/**
 * Value of a resource entry in an {@link Policy}. Usually `"*"`, but
 * account-owned tokens must nest zone resources under the account resource —
 * e.g. `{ "com.cloudflare.api.account.<id>": { "com.cloudflare.api.account.zone.*": "*" } }`
 * — so a nested object is also allowed.
 */
export type ResourceScope = string | { [K in ResourceKey]?: string };

export interface Policy {
  effect: "allow" | "deny";
  permissionGroups: PermissionGroupRef[];
  resources: { [K in ResourceKey]?: ResourceScope };
}

export interface Condition {
  requestIp?: {
    in?: string[];
    notIn?: string[];
  };
}

export type Props = {
  /**
   * Token name. Defaults to a generated physical name based on the
   * resource's logical id, app name, and stage.
   */
  name?: string;
  /**
   * The Cloudflare account ID that owns this token. Defaults to the
   * account ID resolved from the ambient {@link CloudflareEnvironment}.
   */
  accountId?: string;
  /**
   * Access policies attached to the token. Cloudflare requires at least one
   * policy on a token; if you omit `policies` here, the policies must instead
   * be contributed by bindings (see {@link ApiTokenBinding}).
   */
  policies?: Policy[];
  /** ISO 8601 expiration timestamp. */
  expiresOn?: string;
  /** ISO 8601 "not before" timestamp. */
  notBefore?: string;
  /** Optional usage conditions (e.g. IP allowlist). */
  condition?: Condition;
};

/**
 * Binding contract for {@link AccountApiToken} / {@link UserApiToken}.
 *
 * A binding contributes additional access policies to the token. This lets a
 * downstream resource (e.g. a runtime capability that needs to call a specific
 * Cloudflare API) create a token and attach exactly the policies it requires,
 * without the token's owner having to enumerate them up front.
 *
 * Binding-contributed policies are merged with any `policies` passed directly
 * as props; the union must contain at least one policy.
 */
export type ApiTokenBinding = {
  /** Access policies to attach to the token. */
  policies?: Policy[];
};

/**
 * Collect the policies a token should be created with: those passed directly
 * as props, plus those contributed by bindings.
 */
export const collectPolicies = (
  props: Policy[] | undefined,
  bindings: { data: ApiTokenBinding }[],
): Policy[] => [
  ...(props ?? []),
  ...bindings.flatMap((binding) => binding.data.policies ?? []),
];

export type ResolvedPolicy = {
  effect: "allow" | "deny";
  permissionGroups: { id: string; meta?: { key?: string; value?: string } }[];
  resources: Record<string, unknown>;
};

export const resolvePermissionGroup = (ref: PermissionGroupRef) => {
  if (typeof ref === "string") {
    const group = PERMISSION_GROUPS_BY_NAME[ref];
    if (!group) {
      // Should be unreachable due to the typed union, but guard anyway in
      // case Cloudflare retires a name we still have in the catalog.
      throw new Error(
        `Unknown Cloudflare permission group: "${ref}". Pass an explicit { id } instead.`,
      );
    }
    return { id: group.id };
  }
  return ref.meta ? { id: ref.id, meta: ref.meta } : { id: ref.id };
};

const resolveResources = (
  resources: Policy["resources"],
): Record<string, ResourceScope> => {
  const out: Record<string, ResourceScope> = {};
  for (const [key, value] of Object.entries(resources)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
};

export const resolvePolicies = (policies: Policy[]): ResolvedPolicy[] =>
  policies.map((policy) => ({
    effect: policy.effect,
    permissionGroups: policy.permissionGroups.map(resolvePermissionGroup),
    resources: resolveResources(policy.resources),
  }));

export const policyFingerprint = (policies: ResolvedPolicy[]): string =>
  JSON.stringify(
    policies.map((p) => ({
      effect: p.effect,
      permissionGroups: [...p.permissionGroups]
        .map((g) => ({ id: g.id, meta: g.meta ?? null }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      resources: Object.keys(p.resources)
        .sort()
        .map((k) => [k, p.resources[k]]),
    })),
  );

export const conditionFingerprint = (
  condition: Condition | undefined,
): string =>
  JSON.stringify({
    in: [...(condition?.requestIp?.in ?? [])].sort(),
    notIn: [...(condition?.requestIp?.notIn ?? [])].sort(),
  });

export const buildConditionPayload = (condition: Condition | undefined) =>
  condition
    ? {
        requestIp: condition.requestIp
          ? {
              in: condition.requestIp.in,
              notIn: condition.requestIp.notIn,
            }
          : undefined,
      }
    : undefined;
