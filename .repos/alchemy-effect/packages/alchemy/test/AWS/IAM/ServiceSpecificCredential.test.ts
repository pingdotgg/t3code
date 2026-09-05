import * as AWS from "@/AWS";
import { ServiceSpecificCredential, User } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.IAM.ServiceSpecificCredential", () => {
  // Canonical `list()` test: IAM is a global service and service-specific
  // credentials are owned per IAM user, so the provider enumerates every user
  // first and then lists credentials per user. Deploy a real user + credential,
  // resolve the provider from context with the typed `findProvider`, call
  // `list()`, and assert the deployed credential appears in the result.
  test.provider(
    "list enumerates the deployed service-specific credential",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const user = yield* User("SsCredListOwner", {});
            const credential = yield* ServiceSpecificCredential(
              "SsCredListCred",
              {
                userName: user.userName,
                serviceName: "codecommit.amazonaws.com",
                // Duration.Input prop — converted to whole wire days.
                credentialAge: "30 days",
              },
            );
            return { user, credential };
          }),
        );

        // The Duration prop round-trips as an expiration ~30 days out, and
        // the creation-only secret is captured as a Redacted output.
        expect(deployed.credential.expirationDate).toBeDefined();
        expect(deployed.credential.servicePassword).toBeDefined();

        const provider = yield* Provider.findProvider(
          ServiceSpecificCredential,
        );
        const all = yield* provider.list();

        const found = all.find(
          (entry) =>
            entry.serviceSpecificCredentialId ===
            deployed.credential.serviceSpecificCredentialId,
        );
        expect(found).toBeDefined();
        expect(found?.userName).toBe(deployed.user.userName);
        expect(found?.serviceName).toBe("codecommit.amazonaws.com");
        expect(found?.servicePassword).toBeUndefined();
        expect(found?.serviceCredentialSecret).toBeUndefined();

        yield* stack.destroy();

        // The user (and with it the service-specific credential) is gone.
        const deletedUser = yield* IAM.getUser({
          UserName: deployed.user.userName,
        }).pipe(Effect.option);
        expect(deletedUser._tag).toBe("None");
      }),
  );
});
