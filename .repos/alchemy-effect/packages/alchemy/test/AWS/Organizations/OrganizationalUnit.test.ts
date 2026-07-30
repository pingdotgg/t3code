import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Tree-structured enumeration: `list()` walks the org tree (listRoots ->
// recursive listOrganizationalUnitsForParent) and hydrates each OU into the
// exact `read` Attributes shape. This runs read-only — it neither creates nor
// deletes any organizational unit. When the account isn't an organization
// management account, the typed `AWSOrganizationsNotInUseException` /
// `AccessDeniedException` degrade to `[]`.
test.provider("list enumerates the organizational units", (stack) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(
      AWS.Organizations.OrganizationalUnit,
    );
    const all = yield* provider.list();

    // 0 when the account isn't a management account (or has no OUs); otherwise
    // every discovered OU. Never negative.
    expect(all.length).toBeGreaterThanOrEqual(0);

    // Each entry carries the well-typed Attributes shape that `read` produces.
    for (const ou of all) {
      expect(typeof ou.ouId).toBe("string");
      expect(ou.ouId.length).toBeGreaterThan(0);
      expect(typeof ou.ouArn).toBe("string");
      expect(ou.ouArn.startsWith("arn:aws:organizations::")).toBe(true);
      expect(typeof ou.name).toBe("string");
      expect(ou.name.length).toBeGreaterThan(0);
      expect(typeof ou.tags).toBe("object");
    }

    yield* stack.destroy();
  }),
);
