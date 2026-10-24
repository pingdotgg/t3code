/**
 * Shared by the server driver and the client settings form, so it holds only
 * browser-safe schema code.
 */
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
          "Declare all T3 tool schemas on OpenAI-compatible chat completion requests, for gateways that drop calls to undeclared tools. Turn off if your gateway runs tools found through tool_search. Requests then declare the orchestration tools, tool_search and the T3 tools tool_search loaded or the conversation already called. Existing threads keep tools they already loaded, including eagerly loaded ones, so the reduction applies to new threads and tools not yet loaded. Needs Pi 0.99 or newer; older Pi always declares every T3 tool.",
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
