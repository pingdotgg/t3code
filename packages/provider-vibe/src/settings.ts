import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const VibeSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("vibe-app-server").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Mistral Vibe app server binary.",
        providerSettingsForm: { placeholder: "vibe-app-server", clearWhenEmpty: "omit" },
      }),
    ),
    trustWorkspace: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({
        title: "Trust workspaces",
        description:
          "Automatically trust projects opened in T3 Code so Vibe can load repository instructions such as AGENTS.md. Trust is persisted by Vibe for each workspace.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    localModelEnabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Use a local model",
        description:
          "Point Vibe's local model option at an OpenAI-compatible server such as vLLM, Ollama, LM Studio, or llama.cpp.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
    localModelBaseUrl: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("http://127.0.0.1:11434/v1")),
      Schema.annotateKey({
        title: "Local API URL",
        description:
          "OpenAI-compatible endpoint. vLLM commonly uses port 8000; Ollama normally uses port 11434.",
        providerSettingsForm: {
          placeholder: "http://127.0.0.1:11434/v1",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    localModelId: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("devstral-small-2")),
      Schema.annotateKey({
        title: "Local model ID",
        description:
          "Model ID exposed by your server, for example mistralai/Devstral-Small-2-24B-Instruct-2512 or an Ollama model name.",
        providerSettingsForm: {
          placeholder: "devstral-small-2",
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
    order: [
      "binaryPath",
      "trustWorkspace",
      "localModelEnabled",
      "localModelBaseUrl",
      "localModelId",
    ],
  },
);
export type VibeSettings = typeof VibeSettings.Type;
