// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import type {
  Options as ClaudeQueryOptions,
  Settings as ClaudeSdkSettings,
} from "@anthropic-ai/claude-agent-sdk";

import { parseCliArgs } from "@t3tools/shared/cliArgs";

import { fromLenientJson } from "@t3tools/shared/schemaJson";

import { ClaudeSettings } from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";

import { ClaudeAppendSystemPromptFileError } from "./ClaudeQueryRunnerTypes.ts";
import { ClaudeAppendSystemPromptMissingValueError } from "./ClaudeQueryRunnerTypes.ts";
import { ClaudeSettingsLaunchArgError } from "./ClaudeQueryRunnerTypes.ts";
import { makeClaudeQueryOptions } from "./ClaudeQueryOptions.ts";

export const readClaudeAppendSystemPromptFile = Effect.fnUntraced(function* (input: {
  readonly settings: ClaudeSettings | undefined;
  readonly cwd: string | null;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  if (input.settings === undefined) return undefined;
  const flags = parseCliArgs(input.settings.launchArgs).flags;
  // parseCliArgs gives null for a flag with no following value. An explicit
  // `--append-system-prompt ""` is a value the CLI accepts, so it stays.
  if (flags["append-system-prompt"] === null) {
    return yield* new ClaudeAppendSystemPromptMissingValueError({
      flag: "--append-system-prompt",
    });
  }
  const file = flags["append-system-prompt-file"];
  if (file === undefined) return undefined;
  // `--append-system-prompt-file=` is "" and names no file either.
  if (file === null || file === "") {
    return yield* new ClaudeAppendSystemPromptMissingValueError({
      flag: "--append-system-prompt-file",
    });
  }
  const filePath = input.path.resolve(input.cwd ?? ".", file);
  return yield* input.fileSystem
    .readFileString(filePath)
    .pipe(
      Effect.mapError((cause) => new ClaudeAppendSystemPromptFileError({ path: filePath, cause })),
    );
});

export const decodeClaudeLaunchArgSettings = Schema.decodeUnknownEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Reads the --settings launch argument: a value starting with a brace is inline
 * JSON, anything else is a file path relative to the cwd. makeClaudeQueryOptions
 * merges the result beneath T3's own settings.
 */
export const readClaudeLaunchArgSettings = Effect.fn("ClaudeAdapterV2.readLaunchArgSettings")(
  function* (input: {
    readonly settings: ClaudeSettings | undefined;
    readonly cwd: string | null;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) {
    if (input.settings === undefined) return undefined;
    const value = parseCliArgs(input.settings.launchArgs).flags.settings;
    if (value === undefined) return undefined;
    const trimmed = value?.trim() ?? "";
    if (trimmed.length === 0) return yield* new ClaudeSettingsLaunchArgError({});
    // The CLI also wants a closing brace, but then malformed JSON, secrets included, would
    // become the file path in the error message.
    if (trimmed.startsWith("{")) {
      return (yield* decodeClaudeLaunchArgSettings(trimmed).pipe(
        Effect.mapError((cause) => new ClaudeSettingsLaunchArgError({ cause })),
      )) as ClaudeSdkSettings;
    }
    const filePath = input.path.resolve(input.cwd ?? ".", trimmed);
    return (yield* input.fileSystem.readFileString(filePath).pipe(
      Effect.flatMap(decodeClaudeLaunchArgSettings),
      Effect.mapError((cause) => new ClaudeSettingsLaunchArgError({ path: filePath, cause })),
    )) as ClaudeSdkSettings;
  },
);

export const CLAUDE_T3_MCP_TOOL_WILDCARD = "mcp__t3-code__*";

// Keep in sync with OrchestratorToolkit Tool.Readonly annotations; ClaudeAdapterV2.test.ts checks this.
export const CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS: ReadonlyArray<string> = [
  "mcp__t3-code__orchestrator_capabilities",
  "mcp__t3-code__list_scheduled_tasks",
  "mcp__t3-code__t3_thread_list",
  "mcp__t3-code__t3_thread_wait",
  "mcp__t3-code__t3_worktree_status",
  "mcp__t3-code__t3_worktree_list",
  "mcp__t3-code__t3_project_list",
  "mcp__t3-code__t3_project_read",
  "mcp__t3-code__t3_thread_search",
  "mcp__t3-code__t3_preview_list",
  "mcp__t3-code__t3_environment_read",
  "mcp__t3-code__t3_environment_links",
  "mcp__t3-code__html_preview",
  "mcp__t3-code__html_render",
];

// T3 waits can block for an hour; exceed Claude's default 60 s timeout.
export const CLAUDE_T3_MCP_TOOL_TIMEOUT_MS = 65 * 60 * 1_000;

// allowedTools pre-approves calls; tools controls availability. Pre-approve T3 tools for headless modes,
// limited to annotated read-only tools in read-only sandboxes.

export function claudeMcpQueryOverrides(input: {
  readonly mcpSession: McpProviderSession.McpProviderSessionConfig | undefined;
  readonly readOnlySandbox: boolean;
  readonly allowedTools?: ReadonlyArray<string>;
}): {
  readonly allowedTools?: ReadonlyArray<string>;
  readonly mcpServers?: ClaudeQueryOptions["mcpServers"];
} {
  const session = input.mcpSession;
  if (session === undefined) {
    return input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools };
  }
  const mcpAllowedTools = input.readOnlySandbox
    ? CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS
    : [CLAUDE_T3_MCP_TOOL_WILDCARD];
  return {
    allowedTools: Array.from(new Set([...(input.allowedTools ?? []), ...mcpAllowedTools])),
    mcpServers: {
      "t3-code": {
        type: "http",
        url: session.endpoint,
        headers: {
          Authorization: session.authorizationHeader,
        },
        timeout: CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
      },
    },
  };
}
