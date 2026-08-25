import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// `Root` is import-only and there is exactly one organization root per
// management account. `list()` enumerates roots via `listRoots` (paginated) and
// hydrates each into the full Attributes shape, or returns `[]` when the account
// isn't an organization management account (the typed
// `AWSOrganizationsNotInUseException` / `AccessDeniedException` are caught to
// `[]`). This runs read-only — it neither creates nor deletes anything.
test.provider("list enumerates the organization root", (stack) =>
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
);
