import * as AWS from "@/AWS";
import { SigningCertificate, User } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { testCertificateBody } from "./fixtures.ts";
import { withSigningCertificateFixture } from "./SigningCertificateTestLease.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.IAM.SigningCertificate", () => {
  // Canonical `list()` test: IAM is a global service and
  // `listSigningCertificates` requires a `UserName`, so the provider enumerates
  // every user first and then lists certificates per user. Deploy a real user +
  // signing certificate (with a checked-in valid X.509 certificate body),
  // resolve the provider from context with the typed `findProvider`, call
  // `list()`, and assert the deployed certificate appears in the
  // exhaustively-paginated result.
  test.provider("list enumerates the deployed signing certificate", (stack) =>
    withSigningCertificateFixture(
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const user = yield* User("SigningCertListOwner", {});
            const certificate = yield* SigningCertificate(
              "SigningCertListCert",
              {
                userName: user.userName,
                certificateBody: testCertificateBody,
              },
            );
            return { user, certificate };
          }),
        );

        const provider = yield* Provider.findProvider(SigningCertificate);
        const all = yield* provider.list();

        const found = all.find(
          (entry) => entry.certificateId === deployed.certificate.certificateId,
        );
        expect(found).toBeDefined();
        expect(found?.userName).toBe(deployed.user.userName);
        expect(found?.certificateBody).toBeDefined();
        expect(found?.status).toBe("Active");

        yield* stack.destroy();

        // The user (and with it the signing certificate) is gone.
        const deletedUser = yield* IAM.getUser({
          UserName: deployed.user.userName,
        }).pipe(Effect.option);
        expect(deletedUser._tag).toBe("None");
      }),
    ),
  );
});
