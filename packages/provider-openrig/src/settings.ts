/**
 * OpenRig instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-openrig/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const OpenRigSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("rig").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OpenRig `rig` CLI on this environment.",
        providerSettingsForm: { placeholder: "rig", clearWhenEmpty: "omit" },
      }),
    ),
    targetMember: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Target member",
        description:
          "Optional. Passes `--to <member@rig>` to `rig acp serve` so prompts go to one teammate.",
        providerSettingsForm: {
          placeholder: "member@rig",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "targetMember"],
  },
);
export type OpenRigSettings = typeof OpenRigSettings.Type;
