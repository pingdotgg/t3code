import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Layer from "effect/Layer";
import { makeSecretHttpBinding } from "./BindingHttp.ts";
import { RotateSecret } from "./RotateSecret.ts";

export const RotateSecretHttp = Layer.effect(
  RotateSecret,
  makeSecretHttpBinding({
    tag: "AWS.SecretsManager.RotateSecret",
    operation: secretsmanager.rotateSecret,
    actions: ["secretsmanager:RotateSecret", "secretsmanager:DescribeSecret"],
  }),
);
