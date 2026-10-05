import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Layer from "effect/Layer";
import {
  AccessSecretVersion,
  type AccessSecretVersionRequest,
} from "./AccessSecretVersion.ts";
import { makeSecretHttpBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link AccessSecretVersion}.
 *
 * @layer
 * @provides GCP.SecretManager.AccessSecretVersion
 */
export const AccessSecretVersionHttp = Layer.effect(
  AccessSecretVersion,
  makeSecretHttpBinding<
    secretmanager.AccessProjectsSecretsVersionsRequest,
    secretmanager.AccessSecretVersionResponse,
    secretmanager.AccessProjectsSecretsVersionsError,
    AccessSecretVersionRequest
  >({
    tag: "GCP.SecretManager.AccessSecretVersion",
    iam: {
      role: "roles/secretmanager.secretAccessor",
      on: "secretmanager.secret",
    },
    operation: secretmanager.accessProjectsSecretsVersions,
    toInput: (secretName, request) => ({
      name: `${secretName}/versions/${request?.version ?? "latest"}`,
    }),
  }),
);
