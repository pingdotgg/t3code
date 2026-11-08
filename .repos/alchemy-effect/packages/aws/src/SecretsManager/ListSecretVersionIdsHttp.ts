import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Layer from "effect/Layer";
import { makeSecretHttpBinding } from "./BindingHttp.ts";
import { ListSecretVersionIds } from "./ListSecretVersionIds.ts";

export const ListSecretVersionIdsHttp = Layer.effect(
  ListSecretVersionIds,
  makeSecretHttpBinding({
    tag: "AWS.SecretsManager.ListSecretVersionIds",
    operation: secretsmanager.listSecretVersionIds,
    actions: ["secretsmanager:ListSecretVersionIds"],
  }),
);
