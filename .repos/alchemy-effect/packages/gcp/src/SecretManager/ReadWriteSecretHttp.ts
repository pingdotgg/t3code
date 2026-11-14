import * as Layer from "effect/Layer";
import { ReadWriteSecret } from "./ReadWriteSecret.ts";
import { makeSecretAccessBinding, readWriteSecretGrants } from "./SecretHttp.ts";

/**
 * HTTP implementation of {@link ReadWriteSecret} over the Secret Manager REST API.
 *
 * @layer
 * @provides GCP.SecretManager.ReadWriteSecret
 * @category SecretManager
 */
export const ReadWriteSecretHttp = Layer.effect(
  ReadWriteSecret,
  makeSecretAccessBinding({
    tag: "GCP.SecretManager.ReadWriteSecret",
    grants: readWriteSecretGrants,
    makeClient: (helpers, name) => ({
      ...helpers.makeRead(name),
      ...helpers.makeWrite(name),
    }),
  }),
);
