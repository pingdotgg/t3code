import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Layer from "effect/Layer";
import {
  AddSecretVersion,
  type AddSecretVersionRequest,
} from "./AddSecretVersion.ts";
import { makeSecretHttpBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link AddSecretVersion}.
 *
 * @layer
 * @provides GCP.SecretManager.AddSecretVersion
 */
export const AddSecretVersionHttp = Layer.effect(
  AddSecretVersion,
  makeSecretHttpBinding<
    secretmanager.AddVersionProjectsSecretsRequest,
    secretmanager.SecretVersion,
    secretmanager.AddVersionProjectsSecretsError,
    AddSecretVersionRequest
  >({
    tag: "GCP.SecretManager.AddSecretVersion",
    iam: {
      role: "roles/secretmanager.secretVersionAdder",
      on: "secretmanager.secret",
    },
    operation: secretmanager.addVersionProjectsSecrets,
    toInput: (secretName, request) => ({
      parent: secretName,
      body: { payload: request?.payload },
    }),
  }),
);
