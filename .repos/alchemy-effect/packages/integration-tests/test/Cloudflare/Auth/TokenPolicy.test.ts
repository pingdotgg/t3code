import {
  MAX_POLICY_PERMISSION_GROUPS,
  tokenPolicies,
  type PermissionGroup,
} from "@alchemy.run/cloudflare/Auth/TokenPolicy";
import { describe, expect, it } from "@alchemy.run/test";

const group = (id: string, scope: string): PermissionGroup => ({
  id,
  name: id,
  scopes: [scope],
  selectable: true,
});

const accountGroups = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    group(`account-${index}`, "com.cloudflare.api.account"),
  );

describe(
  "Cloudflare token policies",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:auth", "local"] },
  () => {
    it("buckets permission groups by resource scope", () => {
      const policies = tokenPolicies(["acct"], "user", [
        group("a", "com.cloudflare.api.account"),
        group("z", "com.cloudflare.api.account.zone"),
        group("u", "com.cloudflare.api.user"),
        group("dropped", "com.cloudflare.edge.worker.script"),
      ]);

      expect(policies).toEqual([
        {
          effect: "allow",
          permissionGroups: [{ id: "a" }],
          resources: { "com.cloudflare.api.account.acct": "*" },
        },
        {
          effect: "allow",
          permissionGroups: [{ id: "z" }],
          resources: { "com.cloudflare.api.account.zone.*": "*" },
        },
        {
          effect: "allow",
          permissionGroups: [{ id: "u" }],
          resources: { "com.cloudflare.api.user.user": "*" },
        },
      ]);
    });

    it("splits a scope with more than 300 groups across policies on the same resources", () => {
      // The live account catalog has 303 account-scoped groups, which
      // Cloudflare rejects in a single policy.
      const policies = tokenPolicies(["acct"], "user", accountGroups(303));

      expect(policies.map((policy) => policy.permissionGroups.length)).toEqual([
        MAX_POLICY_PERMISSION_GROUPS,
        3,
      ]);
      expect(policies.every((policy) => policy.resources["com.cloudflare.api.account.acct"])).toBe(
        true,
      );
      expect(
        new Set(policies.flatMap((policy) => policy.permissionGroups.map(({ id }) => id))).size,
      ).toBe(303);
    });

    it("keeps exactly 300 groups in one policy", () => {
      expect(tokenPolicies(["acct"], "user", accountGroups(300))).toHaveLength(1);
    });
  },
);
