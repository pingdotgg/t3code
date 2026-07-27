import * as AWS from "@/AWS";
import { SSHPublicKey, User } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { testSshPublicKey } from "./fixtures.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.IAM.SSHPublicKey", () => {
  // Canonical `list()` test: IAM is a global service and `listSSHPublicKeys`
  // requires a `UserName`, so the provider enumerates every user first and then
  // lists keys per user, hydrating each via `getSSHPublicKey`. Deploy a real
  // user + SSH key (with a checked-in valid RSA public key), resolve the
  // provider from context with the typed `findProvider`, call `list()`, and
  // assert the deployed key appears in the exhaustively-paginated result.
  test.provider("list enumerates the deployed SSH public key", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const user = yield* User("SSHKeyListOwner", {});
          const key = yield* SSHPublicKey("SSHKeyListKey", {
            userName: user.userName,
            sshPublicKeyBody: testSshPublicKey,
          });
          return { user, key };
        }),
      );

      const provider = yield* Provider.findProvider(SSHPublicKey);
      const all = yield* provider.list();

      const found = all.find(
        (entry) => entry.sshPublicKeyId === deployed.key.sshPublicKeyId,
      );
      expect(found).toBeDefined();
      expect(found?.userName).toBe(deployed.user.userName);
      expect(found?.sshPublicKeyBody).toBeDefined();
      expect(found?.fingerprint).toBeDefined();

      yield* stack.destroy();

      // The user (and with it the SSH public key) is gone.
      const deletedUser = yield* IAM.getUser({
        UserName: deployed.user.userName,
      }).pipe(Effect.option);
      expect(deletedUser._tag).toBe("None");
    }),
  );
});
