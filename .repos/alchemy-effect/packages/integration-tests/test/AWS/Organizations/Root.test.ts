import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as OrganizationLease from "./OrganizationLease.ts";

const { test } = OrganizationLease.make({ providers: AWS.providers() }, "shared");

// `Root` is import-only and there is exactly one organization root per
// management account. `list()` enumerates roots via `listRoots` (paginated) and
// hydrates each into the full Attributes shape, or returns `[]` when the account
// isn't an organization management account (the typed
// `AWSOrganizationsNotInUseException` / `AccessDeniedException` are caught to
// `[]`). This runs read-only — it neither creates nor deletes anything.
test.provider(
  "list enumerates the organization root",
  (stack) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(AWS.Organizations.Root);
      const all = yield* provider.list();

      // 0 (account is not a management account) or 1 (it is) — never more.
      expect(all.length).toBeLessThanOrEqual(1);

      // When the account is an organization management account, the single entry
      // carries a well-typed Attributes shape.
      if (all.length === 1) {
        const root = all[0];
        expect(typeof root.rootId).toBe("string");
        expect(root.rootId.length).toBeGreaterThan(0);
        expect(typeof root.rootArn).toBe("string");
        expect(root.rootArn.startsWith("arn:aws:organizations::")).toBe(true);
        expect(typeof root.rootName).toBe("string");
        expect(Array.isArray(root.policyTypes)).toBe(true);
        expect(typeof root.tags).toBe("object");
      }

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:organizations", "live"] },
);

// `rootId` and `name` only select which root to adopt, so adding, removing, or
// pinning one that matches the adopted root plans an update, never a replace.
test.provider(
  "pinning or dropping the lookup id of the adopted root updates in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const root = yield* stack.deploy(AWS.Organizations.Root("Root", {}));

      const pinned = yield* stack.plan(
        AWS.Organizations.Root("Root", { rootId: root.rootId, name: root.rootName }),
      );
      expect(pinned.resources.Root?.action).toBe("update");

      yield* stack.deploy(AWS.Organizations.Root("Root", { rootId: root.rootId }));

      const dropped = yield* stack.plan(AWS.Organizations.Root("Root", {}));
      expect(dropped.resources.Root?.action).toBe("update");

      const other = yield* stack.plan(AWS.Organizations.Root("Root", { rootId: "r-zzzz" }));
      expect(other.resources.Root?.action).toBe("replace");

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:organizations", "live"] },
);
