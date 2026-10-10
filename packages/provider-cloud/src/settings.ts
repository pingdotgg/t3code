/**
 * Codex Cloud and Claude Code Cloud instance settings. Shared by the server
 * drivers and the client settings form, so it holds only browser-safe schema
 * code.
 *
 * @module provider-cloud/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const enabled = Schema.Boolean.pipe(
  Schema.withDecodingDefault(Effect.succeed(false)),
  Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
);
const customModels = Schema.Array(CustomModelSetting).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
  Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
);

export const CodexCloudSettings = makeProviderSettingsSchema(
  {
    enabled,
    binaryPath: makeBinaryPathSetting("codex").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description:
          "Path to the Codex CLI on this environment. Sign in with ChatGPT using codex login on that host.",
        providerSettingsForm: { placeholder: "codex", clearWhenEmpty: "omit" },
      }),
    ),
    environment: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Cloud environment",
        description:
          "The Codex Cloud environment ID or label tasks run in. Run codex cloud to list yours.",
        providerSettingsForm: { placeholder: "my-org/my-repo", clearWhenEmpty: "omit" },
      }),
    ),
    customModels,
  },
  { order: ["environment", "binaryPath"] },
);
export type CodexCloudSettings = typeof CodexCloudSettings.Type;

export const ClaudeCloudSettings = makeProviderSettingsSchema(
  {
    enabled,
    binaryPath: makeBinaryPathSetting("claude").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description:
          "Path to the Claude Code CLI on this environment. Sign in with a claude.ai account using claude auth login on that host.",
        providerSettingsForm: { placeholder: "claude", clearWhenEmpty: "omit" },
      }),
    ),
    customModels,
  },
  { order: ["binaryPath"] },
);
export type ClaudeCloudSettings = typeof ClaudeCloudSettings.Type;
