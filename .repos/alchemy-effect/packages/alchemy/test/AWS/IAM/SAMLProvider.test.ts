import * as AWS from "@/AWS";
import { SAMLProvider } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  testPrivateKey,
  testSamlMetadataDocument,
  testSamlProviderName,
} from "./fixtures.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.IAM.SAMLProvider", () => {
  test.provider("list enumerates the deployed SAML provider", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SAMLProvider("ListResource", {
            name: testSamlProviderName,
            samlMetadataDocument: testSamlMetadataDocument,
            // Redacted prop — unwrapped to the wire private key at create.
            assertionEncryptionMode: "Allowed",
            addPrivateKey: Redacted.make(testPrivateKey),
          });
        }),
      );

      expect(deployed.assertionEncryptionMode).toBe("Allowed");

      const provider = yield* Provider.findProvider(SAMLProvider);
      const all = yield* provider.list();

      expect(
        all.some((x) => x.samlProviderArn === deployed.samlProviderArn),
      ).toBe(true);

      yield* stack.destroy();

      const deleted = yield* IAM.getSAMLProvider({
        SAMLProviderArn: deployed.samlProviderArn,
      }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }),
  );
});
