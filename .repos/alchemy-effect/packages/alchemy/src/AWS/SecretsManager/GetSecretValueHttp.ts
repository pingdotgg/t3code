import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Layer from "effect/Layer";
import { makeSecretHttpBinding } from "./BindingHttp.ts";
import { GetSecretValue } from "./GetSecretValue.ts";

export const GetSecretValueHttp = Layer.effect(
  GetSecretValue,
  makeSecretHttpBinding({
    tag: "AWS.SecretsManager.GetSecretValue",
    operation: secretsmanager.getSecretValue,
    actions: ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
  }),
);
