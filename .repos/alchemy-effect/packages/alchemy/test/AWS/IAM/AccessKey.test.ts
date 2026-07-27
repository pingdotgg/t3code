import * as AWS from "@/AWS";
import { AccessKey, User } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.IAM.AccessKey", () => {
  // Canonical `list()` test: IAM is a global service and `listAccessKeys`
  // requires a `UserName`, so the provider enumerates every user first and then
  // lists keys per user. Deploy a real user + access key, resolve the provider
  // from context with the typed `findProvider`, call `list()`, and assert the
  // deployed key appears in the exhaustively-paginated result.
  test.provider("list enumerates the deployed access key", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const user = yield* User("AccessKeyListOwner", {});
          const key = yield* AccessKey("AccessKeyListKey", {
            userName: user.userName,
            status: "Active",
          });
          return { user, key };
        }),
      );

      const provider = yield* Provider.findProvider(AccessKey);
      const all = yield* provider.list();

      const found = all.find(
        (entry) => entry.accessKeyId === deployed.key.accessKeyId,
      );
      expect(found).toBeDefined();
      expect(found?.userName).toBe(deployed.user.userName);
      expect(found?.secretAccessKey).toBeUndefined();

      yield* stack.destroy();

      // The user (and with it every access key it owned) is gone.
      const deletedUser = yield* IAM.getUser({
        UserName: deployed.user.userName,
      }).pipe(Effect.option);
      expect(deletedUser._tag).toBe("None");
    }),
  );
});
