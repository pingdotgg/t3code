import * as Layer from "effect/Layer";
import { ReadSecret } from "./ReadSecret.ts";
import { makeSecretAccessBinding, readSecretGrants } from "./SecretHttp.ts";

/**
 * HTTP implementation of {@link ReadSecret} over the Secret Manager REST API.
 *
 * @layer
 * @provides GCP.SecretManager.ReadSecret
 * @category SecretManager
 */
export const ReadSecretHttp = Layer.effect(
  ReadSecret,
  makeSecretAccessBinding({
    tag: "GCP.SecretManager.ReadSecret",
    grants: readSecretGrants,
    makeClient: (helpers, name) => helpers.makeRead(name),
  }),
);
