/**
 * ZCode instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-zcode/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ZCodeSettings = makeProviderSettingsSchema(
  {
    // Off by default: ZCode runs through a separately installed ACP bridge.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("zcode-acp-server").pipe(
      Schema.annotateKey({
        title: "ACP bridge path",
        description: "Path to the zcode-acp-server bridge that drives the ZCode app-server.",
        providerSettingsForm: { placeholder: "zcode-acp-server", clearWhenEmpty: "omit" },
      }),
    ),
    zcodeBinaryPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "ZCode CLI path",
        description:
          "ZCode CLI binary or its zcode.cjs entry. Leave empty to use `zcode` on PATH or the ZCode desktop app.",
        providerSettingsForm: {
          placeholder: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
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
    order: ["binaryPath", "zcodeBinaryPath"],
  },
);
export type ZCodeSettings = typeof ZCodeSettings.Type;
