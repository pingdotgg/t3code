import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import KmsBindingsHost, { Cipher } from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "KmsBindings");

let baseUrl: string;
let keyName: string;
let hostAccount: string;

describe.skipIf(!dockerAvailable)(
  "KMS Bindings",
  { tags: ["provider:gcp", "provider:gcp:kms", "provider:gcp:run", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* KmsBindingsHost;
            const key = yield* Cipher;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              key: key.name,
            };
          }),
        );
        baseUrl = out.uri!;
        keyName = out.key;
        hostAccount = out.serviceAccount!;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("Encrypt / Decrypt", () => {
      test.provider(
        "round-trip as the host's service account, granted on the key only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              plaintext: string;
              ciphertext: string;
              decrypted: string;
            }>(baseUrl, "roundTrip");
            expect(out.ciphertext).not.toEqual(out.plaintext);
            expect(out.decrypted).toEqual(out.plaintext);

            const policy =
              yield* kms.getIamPolicyProjectsLocationsKeyRingsCryptoKeys({
                resource: keyName,
              });
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(
                  `serviceAccount:${hostAccount}`,
                ),
              )
              .map((binding) => binding.role)
              .sort();
            expect(roles).toEqual([
              "roles/cloudkms.cryptoKeyDecrypter",
              "roles/cloudkms.cryptoKeyEncrypter",
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:kms", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
