import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const KiroSettings = makeProviderSettingsSchema(
  {
    // Off by default like Grok: users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("kiro-cli").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Kiro CLI binary.",
        providerSettingsForm: { placeholder: "kiro-cli", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    // Kiro does not report the overage cap over ACP, so the bar needs it from the user.
    overageCreditLimit: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Monthly overage limit",
        description: "Credits you can use past your plan each month, such as 10000.",
        providerSettingsForm: { placeholder: "10000", clearWhenEmpty: "omit" },
      }),
    ),
  },
  {
    order: ["binaryPath", "overageCreditLimit"],
  },
);
export type KiroSettings = typeof KiroSettings.Type;
