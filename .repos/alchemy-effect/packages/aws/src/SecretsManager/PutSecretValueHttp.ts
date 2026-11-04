import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Layer from "effect/Layer";
import { makeSecretHttpBinding } from "./BindingHttp.ts";
import { PutSecretValue } from "./PutSecretValue.ts";

export const PutSecretValueHttp = Layer.effect(
  PutSecretValue,
  makeSecretHttpBinding({
    tag: "AWS.SecretsManager.PutSecretValue",
    operation: secretsmanager.putSecretValue,
    actions: ["secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"],
  }),
);
