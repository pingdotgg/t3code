/**
 * Cloudflare expresses an API token's grants as *policies*: one entry per
 * resource scope, each listing the permission groups allowed on it. The
 * catalog hands back a flat list of permission groups, so minting a token
 * means bucketing those groups by the scope they belong to.
 */

/**
 * One `{effect, permissionGroups, resources}` entry in a token's policy list.
 * Mutable to match the shape Cloudflare's create-token request expects.
 */
export interface TokenPolicy {
  effect: "allow";
  permissionGroups: Array<{ id: string }>;
  resources: Record<string, string>;
}

/** A permission group as returned by Cloudflare's token-permissions catalog. */
export interface PermissionGroup {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly scopes: ReadonlyArray<string>;
  /** Whether this group's scope maps onto a policy we know how to express. */
  readonly selectable: boolean;
}

/** Scopes we know how to turn into a policy; anything else is not offerable. */
export const selectableScopes: ReadonlySet<string> = new Set([
  "com.cloudflare.api.account",
  "com.cloudflare.api.account.zone",
  "com.cloudflare.api.user",
  "com.cloudflare.edge.r2.bucket",
]);

/**
 * Bucket permission groups by resource scope into Cloudflare's policy shape.
 * Groups whose scope has no known bucket are dropped — they cannot be granted.
 */
export const tokenPolicies = (
  accountIds: ReadonlyArray<string>,
  userId: string,
  groups: ReadonlyArray<PermissionGroup>,
): TokenPolicy[] => {
  const buckets: Record<string, TokenPolicy> = {
    "com.cloudflare.api.account": {
      effect: "allow",
      permissionGroups: [],
      resources: Object.fromEntries(
        accountIds.map((id) => [`com.cloudflare.api.account.${id}`, "*"]),
      ),
    },
    "com.cloudflare.api.account.zone": {
      effect: "allow",
      permissionGroups: [],
      resources: { "com.cloudflare.api.account.zone.*": "*" },
    },
    "com.cloudflare.api.user": {
      effect: "allow",
      permissionGroups: [],
      resources: { [`com.cloudflare.api.user.${userId}`]: "*" },
    },
    "com.cloudflare.edge.r2.bucket": {
      effect: "allow",
      permissionGroups: [],
      resources: { "com.cloudflare.edge.r2.bucket.*": "*" },
    },
  };
  const seen = new Set<string>();
  for (const group of groups) {
    const bucket = buckets[group.scopes[0]!];
    if (bucket === undefined || seen.has(group.id)) continue;
    seen.add(group.id);
    bucket.permissionGroups.push({ id: group.id });
  }
  return Object.values(buckets).filter(
    (policy) => policy.permissionGroups.length > 0,
  );
};
