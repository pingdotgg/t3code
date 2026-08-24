import * as AWS from "@/AWS";
import { LoginProfile, User } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.IAM.LoginProfile", () => {
  // Canonical `list()` test: IAM is a global service and there is no
  // list-login-profiles API, so the provider enumerates every user first and
  // then probes `getLoginProfile` per user (skipping users without console
  // access). Deploy a real user + login profile, resolve the provider from
  // context with the typed `findProvider`, call `list()`, and assert the
  // deployed profile appears in the result.
  test.provider("list enumerates the deployed login profile", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const user = yield* User("LoginProfileListOwner", {});
          const profile = yield* LoginProfile("LoginProfileListProfile", {
            userName: user.userName,
            password: Redacted.make("TempPassword123!"),
            passwordResetRequired: true,
          });
          return { user, profile };
        }),
      );

      const provider = yield* Provider.findProvider(LoginProfile);
      const all = yield* provider.list();

      const found = all.find(
        (entry) => entry.userName === deployed.user.userName,
      );
      expect(found).toBeDefined();
      expect(found?.userName).toBe(deployed.user.userName);

      yield* stack.destroy();

      // The user (and with it the login profile) is gone.
      const deletedUser = yield* IAM.getUser({
        UserName: deployed.user.userName,
      }).pipe(Effect.option);
      expect(deletedUser._tag).toBe("None");
    }),
  );
});
