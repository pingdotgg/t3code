import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Layer from "effect/Layer";
import { makeSecretHttpBinding } from "./BindingHttp.ts";
import { DescribeSecret } from "./DescribeSecret.ts";

export const DescribeSecretHttp = Layer.effect(
  DescribeSecret,
  makeSecretHttpBinding({
    tag: "AWS.SecretsManager.DescribeSecret",
    operation: secretsmanager.describeSecret,
    actions: ["secretsmanager:DescribeSecret"],
  }),
);
