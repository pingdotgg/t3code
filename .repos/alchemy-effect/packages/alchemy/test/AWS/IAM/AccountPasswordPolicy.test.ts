import * as AWS from "@/AWS";
import { AccountPasswordPolicy } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// The IAM account password policy is an account-wide singleton. Mutating it is
// disruptive (it changes the real password requirements for every console
// user), so this ungated probe never deploys/destroys the resource. It only
// exercises `list()` and asserts the result is well-formed: the singleton get
// returns either the one configured policy or `[]` (typed `NoSuchEntityException`
// when no policy is set on the account).
test.provider("list returns the account password policy singleton", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(AccountPasswordPolicy);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    // Account singleton: 0 (no policy set) or 1 (policy configured).
    expect(all.length).toBeLessThanOrEqual(1);
    for (const policy of all) {
      expect(typeof policy).toBe("object");
      expect(policy).not.toBeNull();
    }
  }),
);

// Full lifecycle against the dedicated testing account. The policy values are
// permissive (min length 8, no forced expiry behavior beyond MaxPasswordAge)
// so concurrently-running IAM login-profile tests using strong passwords are
// unaffected, and `stack.destroy()` deletes the policy (resetting the account
// to AWS defaults) at the end.
test.provider(
  "deploys MaxPasswordAge as whole wire days and deletes the policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AccountPasswordPolicy("PasswordPolicy", {
            MinimumPasswordLength: 8,
            AllowUsersToChangePassword: true,
            // Duration.Input prop — converted to whole wire days.
            MaxPasswordAge: "90 days",
          });
        }),
      );

      // Out-of-band read: the Duration prop landed as 90 wire days.
      const live = yield* IAM.getAccountPasswordPolicy({});
      expect(live.PasswordPolicy.MaxPasswordAge).toBe(90);
      expect(live.PasswordPolicy.MinimumPasswordLength).toBe(8);

      yield* stack.destroy();

      const afterDestroy = yield* IAM.getAccountPasswordPolicy({}).pipe(
        Effect.option,
      );
      expect(afterDestroy._tag).toBe("None");
    }),
);
