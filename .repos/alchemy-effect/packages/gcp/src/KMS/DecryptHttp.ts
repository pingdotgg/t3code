import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as Layer from "effect/Layer";
import { makeCryptoKeyHttpBinding } from "./BindingHttp.ts";
import { Decrypt } from "./Decrypt.ts";

/**
 * HTTP implementation of {@link Decrypt}.
 *
 * @layer
 * @provides GCP.KMS.Decrypt
 */
export const DecryptHttp = Layer.effect(
  Decrypt,
  makeCryptoKeyHttpBinding({
    tag: "GCP.KMS.Decrypt",
    iam: { role: "roles/cloudkms.cryptoKeyDecrypter", on: "kms.cryptoKey" },
    operation: kms.decryptProjectsLocationsKeyRingsCryptoKeys,
  }),
);
