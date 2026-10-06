import * as Layer from "effect/Layer";
import { WriteSecret } from "./WriteSecret.ts";
import { makeSecretAccessBinding, writeSecretGrants } from "./SecretHttp.ts";

/**
 * HTTP implementation of {@link WriteSecret} over the Secret Manager REST API.
 *
 * @layer
 * @provides GCP.SecretManager.WriteSecret
 * @category SecretManager
 */
export const WriteSecretHttp = Layer.effect(
  WriteSecret,
  makeSecretAccessBinding({
    tag: "GCP.SecretManager.WriteSecret",
    grants: writeSecretGrants,
    makeClient: (helpers, name) => helpers.makeWrite(name),
  }),
);
