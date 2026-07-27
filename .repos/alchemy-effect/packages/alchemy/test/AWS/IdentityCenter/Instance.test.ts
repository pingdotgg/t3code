import * as AWS from "@/AWS";
import { Instance } from "@/AWS/IdentityCenter";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// An IAM Identity Center instance is a pre-existing account/organization
// singleton — you generally cannot create one inside a test. `list()`
// enumerates every visible instance via `ListInstances` and returns the
// exact `read` Attributes shape. Accounts without SSO enabled return `[]`
// (not an error), so this test asserts a well-typed `Attributes[]` and
// validates the element shape only when at least one instance exists.
test.provider("list enumerates visible Identity Center instances", () =>
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
);
