// Shared with the client settings form; keep schema code browser-safe.
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PiSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("pi").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Pi coding agent binary.",
        providerSettingsForm: { placeholder: "pi", clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to pi --mode rpc on session start.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    eagerCompletionGatewayTools: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Load every T3 tool on completion gateways",
        description:
          "Send all T3 tool schemas to OpenAI-compatible completion gateways. Turn off if your gateway supports tools loaded through tool_search. Smaller requests require Pi 0.99 or newer and built-in tool_search. Start a new thread to avoid keeping an earlier eager loadout.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "launchArgs", "eagerCompletionGatewayTools"],
  },
);
export type PiSettings = typeof PiSettings.Type;
