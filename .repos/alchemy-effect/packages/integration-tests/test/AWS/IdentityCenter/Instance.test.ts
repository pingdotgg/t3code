import * as AWS from "@alchemy.run/aws";
import { Instance } from "@alchemy.run/aws/IdentityCenter";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// An IAM Identity Center instance is a pre-existing account/organization
// singleton — you generally cannot create one inside a test. `list()`
// enumerates every visible instance via `ListInstances` and returns the
// exact `read` Attributes shape. Accounts without SSO enabled return `[]`
// (not an error), so this test asserts a well-typed `Attributes[]` and
// validates the element shape only when at least one instance exists.
test.provider(
  "list enumerates visible Identity Center instances",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Instance);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);

      for (const instance of all) {
        expect(typeof instance.instanceArn).toBe("string");
        expect(instance.instanceArn.length).toBeGreaterThan(0);
        expect(typeof instance.identityStoreId).toBe("string");
        expect(instance.identityStoreId.length).toBeGreaterThan(0);
        expect(instance.mode).toBe("existing");
      }
    }),
  { tags: ["provider:aws", "provider:aws:identitycenter", "live"] },
);

// `instanceArn` and `name` only select which instance to adopt, so adding,
// removing, or pinning one that matches the adopted instance plans an update. A
// replace in `account` mode would delete the instance it just re-adopted.
// Needs an enabled instance, so it is gated like the rest of this service.
test.provider.skipIf(!process.env.ALCHEMY_TEST_IDENTITY_CENTER)(
  "pinning or dropping the lookup arn of the adopted instance updates in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const instance = yield* stack.deploy(Instance("IdentityCenter", { mode: "existing" }));

      const pinned = yield* stack.plan(
        Instance("IdentityCenter", { instanceArn: instance.instanceArn }),
      );
      expect(pinned.resources.IdentityCenter?.action).toBe("update");

      yield* stack.deploy(
        Instance("IdentityCenter", { instanceArn: instance.instanceArn, mode: "existing" }),
      );

      const dropped = yield* stack.plan(Instance("IdentityCenter", {}));
      expect(dropped.resources.IdentityCenter?.action).toBe("update");

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:identitycenter", "live"] },
);
