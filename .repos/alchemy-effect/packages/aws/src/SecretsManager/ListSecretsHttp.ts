import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Layer from "effect/Layer";
import { makeSecretsManagerAccountHttpBinding } from "./BindingHttp.ts";
import { ListSecrets } from "./ListSecrets.ts";

export const ListSecretsHttp = Layer.effect(
  ListSecrets,
  makeSecretsManagerAccountHttpBinding({
    tag: "AWS.SecretsManager.ListSecrets",
    operation: secretsmanager.listSecrets,
    actions: ["secretsmanager:ListSecrets"],
  }),
);
