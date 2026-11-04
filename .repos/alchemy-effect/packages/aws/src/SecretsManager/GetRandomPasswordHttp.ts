import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Layer from "effect/Layer";
import { makeSecretsManagerAccountHttpBinding } from "./BindingHttp.ts";
import { GetRandomPassword } from "./GetRandomPassword.ts";

export const GetRandomPasswordHttp = Layer.effect(
  GetRandomPassword,
  makeSecretsManagerAccountHttpBinding({
    tag: "AWS.SecretsManager.GetRandomPassword",
    operation: secretsmanager.getRandomPassword,
    actions: ["secretsmanager:GetRandomPassword"],
  }),
);
