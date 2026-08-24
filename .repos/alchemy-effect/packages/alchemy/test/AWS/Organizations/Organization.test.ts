import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Account singleton: an AWS Organization has no list API. `list()` calls
// `describeOrganization` and returns the single org as a one-element array, or
// `[]` when the account isn't a management account (the typed
// `AWSOrganizationsNotInUseException` is caught to `[]`). This runs read-only —
// it neither creates nor deletes an organization.
test.provider("list returns the organization singleton", (stack) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(
      AWS.Organizations.Organization,
    );
    const all = yield* provider.list();

    // 0 (account is not a management account) or 1 (it is) — never more.
    expect(all.length).toBeLessThanOrEqual(1);

    // When the account is an organization management account, the single
    // entry carries a well-typed Attributes shape.
    if (all.length === 1) {
      const org = all[0];
      expect(typeof org.organizationId).toBe("string");
      expect(org.organizationId.length).toBeGreaterThan(0);
      expect(typeof org.organizationArn).toBe("string");
      expect(org.organizationArn.startsWith("arn:aws:organizations::")).toBe(
        true,
      );
      expect(Array.isArray(org.availablePolicyTypes)).toBe(true);
    }

    yield* stack.destroy();
  }),
);
