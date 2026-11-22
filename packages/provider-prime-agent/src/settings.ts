import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PRIME_AGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const PrimeAgentThinkingLevel = Schema.Literals(PRIME_AGENT_THINKING_LEVELS);
export type PrimeAgentThinkingLevel = typeof PrimeAgentThinkingLevel.Type;

export const PRIME_AGENT_RLM_DEPTHS = ["0", "1", "2", "3", "4"] as const;
export const PrimeAgentRlmDepth = Schema.Literals(PRIME_AGENT_RLM_DEPTHS);
export type PrimeAgentRlmDepth = typeof PrimeAgentRlmDepth.Type;

const THINKING_FORM_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
] as const;

const RLM_DEPTH_FORM_OPTIONS = [
  { value: "0", label: "0 (Disable rlm.spawn)" },
  { value: "1", label: "1" },
  { value: "2", label: "2 (Default)" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
] as const;

export const PrimeAgentSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("prime-agent").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Prime Agent CLI binary.",
        providerSettingsForm: { placeholder: "prime-agent", clearWhenEmpty: "omit" },
      }),
    ),
    defaultProvider: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Default model provider",
        description: "Passed as --provider at launch. Leave blank for CLI default.",
        providerSettingsForm: {
          placeholder: "anthropic, openai, prime-inference...",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    defaultThinking: PrimeAgentThinkingLevel.pipe(
      Schema.withDecodingDefault(Effect.succeed("medium" as const)),
      Schema.annotateKey({
        title: "Default thinking level",
        description: "Passed as --thinking when starting Prime Agent.",
        providerSettingsForm: {
          control: "select",
          options: THINKING_FORM_OPTIONS,
          clearWhenEmpty: "omit",
        },
      }),
    ),
    rlmMaxDepth: PrimeAgentRlmDepth.pipe(
      Schema.withDecodingDefault(Effect.succeed("2" as const)),
      Schema.annotateKey({
        title: "RLM max depth",
        description: "Sets RLM_MAX_DEPTH for recursive rlm.spawn calls. Set 0 to disable.",
        providerSettingsForm: {
          control: "select",
          options: RLM_DEPTH_FORM_OPTIONS,
          clearWhenEmpty: "omit",
        },
      }),
    ),
    autonomousMaxTurns: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Autonomous max turns",
        description: "Optional default turn cap passed via --autonomous-max-turns.",
        providerSettingsForm: { placeholder: "25", clearWhenEmpty: "omit" },
      }),
    ),
    autonomousMaxTokens: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Autonomous max tokens",
        description: "Optional default token cap passed via --autonomous-max-tokens.",
        providerSettingsForm: { placeholder: "200000", clearWhenEmpty: "omit" },
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
      "defaultProvider",
      "defaultThinking",
      "rlmMaxDepth",
      "autonomousMaxTurns",
      "autonomousMaxTokens",
    ],
  },
);
export type PrimeAgentSettings = typeof PrimeAgentSettings.Type;
