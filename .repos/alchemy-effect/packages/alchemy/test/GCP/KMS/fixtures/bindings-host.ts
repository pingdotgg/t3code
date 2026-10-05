import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import { KEY_RING_ID, kmsTestId } from "../common.ts";

/** Key the bindings are granted on (roles/cloudkms.cryptoKey{En,De}crypter). */
export const Cipher = Effect.gen(function* () {
  const ring = yield* GCP.KMS.KeyRing("Keys", {
    keyRingId: KEY_RING_ID,
    location: "us-central1",
  });
  return yield* GCP.KMS.CryptoKey("Cipher", {
    keyRing: ring.name,
    cryptoKeyId: kmsTestId("binding"),
  });
});

/**
 * Effect-native Cloud Run service exercising every KMS binding as its own
 * runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class KmsBindingsHost extends GCP.Function<KmsBindingsHost>()(
  "KmsBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const encrypt = yield* GCP.KMS.Encrypt(Cipher);
    const decrypt = yield* GCP.KMS.Decrypt(Cipher);
    const plaintext = btoa("alchemy-kms-binding");

    return {
      fetch: serveProbes({
        roundTrip: Effect.gen(function* () {
          const encrypted = yield* encrypt({ body: { plaintext } });
          const decrypted = yield* decrypt({
            body: { ciphertext: encrypted.ciphertext },
          });
          return {
            plaintext,
            ciphertext: encrypted.ciphertext,
            decrypted: decrypted.plaintext,
          };
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.KMS.EncryptHttp),
    Effect.provide(GCP.KMS.DecryptHttp),
  ),
) {}
