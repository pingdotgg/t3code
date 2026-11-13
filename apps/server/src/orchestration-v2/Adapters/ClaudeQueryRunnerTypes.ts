// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  ForkSessionOptions,
  Options as ClaudeQueryOptions,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { OrchestrationV2ProviderSession, ThreadId } from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as Exit from "effect/Exit";

import * as Schema from "effect/Schema";

import * as Stream from "effect/Stream";

import { CLAUDE_ROOT_REFUSAL } from "./ClaudeProviderIdentity.ts";
import type { ClaudeFlagSettings } from "./ClaudeQueryOptions.ts";

export const CLAUDE_CODE_PRESET_TOOLS = {
  type: "preset",
  preset: "claude_code",
} satisfies NonNullable<ClaudeQueryOptions["tools"]>;

export type ClaudeAgentSdkQueryToolList = ReadonlyArray<string>;
export interface ClaudeAgentSdkQueryPresetTools {
  readonly type: "preset";
  readonly preset: "claude_code";
}
export type ClaudeAgentSdkQueryTools = ClaudeAgentSdkQueryToolList | ClaudeAgentSdkQueryPresetTools;

export const CLAUDE_READ_ONLY_ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;

export function claudeAgentSdkQueryToolsForSdk(
  tools: ClaudeAgentSdkQueryTools,
): NonNullable<ClaudeQueryOptions["tools"]> {
  if (isClaudeAgentSdkQueryToolList(tools)) {
    return [...tools];
  }
  return { type: tools.type, preset: tools.preset };
}

export function isClaudeAgentSdkQueryToolList(
  tools: ClaudeAgentSdkQueryTools,
): tools is ClaudeAgentSdkQueryToolList {
  return Array.isArray(tools);
}

export type ClaudeAgentSdkThreadIdentity =
  | {
      readonly sessionId: string;
      readonly resume?: never;
    }
  | {
      readonly sessionId?: never;
      readonly resume: string;
    };

export type ClaudeAgentSdkQueryOptions = Omit<
  ClaudeQueryOptions,
  "maxTurns" | "model" | "permissionMode" | "resume" | "sessionId" | "tools"
> & {
  readonly model: string;
  readonly tools: NonNullable<ClaudeQueryOptions["tools"]>;
  readonly permissionMode: NonNullable<ClaudeQueryOptions["permissionMode"]>;
} & ClaudeAgentSdkThreadIdentity;

export interface ClaudeAgentSdkQueryOpenInput {
  readonly options: ClaudeAgentSdkQueryOptions;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}

export interface ClaudeAgentSdkQuerySession {
  readonly messages: Stream.Stream<SDKMessage, ClaudeAgentSdkQueryRunnerError>;
  readonly offer: (
    message: SDKUserMessage,
    onQueued?: () => void,
  ) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly setModel: (model: string) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly applyFlagSettings: (
    settings: ClaudeFlagSettings,
  ) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly setPermissionMode: (
    mode: PermissionMode,
  ) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly stopTask: (taskId: string) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly backgroundTasks: (
    toolUseId: string,
  ) => Effect.Effect<boolean, ClaudeAgentSdkQueryRunnerError>;
  readonly interrupt: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly close: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
}

export type ClaudeQueryStreamExit = Exit.Exit<void, ClaudeAgentSdkQueryRunnerError>;

export class ClaudeAgentSdkQueryRunnerError extends Schema.TaggedError<ClaudeAgentSdkQueryRunnerError>()(
  "ClaudeAgentSdkQueryRunnerError",
  {
    method: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Claude Agent SDK query failed.";
  }
}

export class ClaudeCodeRootRefusalError extends Schema.TaggedError<ClaudeCodeRootRefusalError>()(
  "ClaudeCodeRootRefusalError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Claude Code exited before it started: ${CLAUDE_ROOT_REFUSAL}`;
  }
}

export class ClaudeMcpRegistrationTimeoutError extends Schema.TaggedError<ClaudeMcpRegistrationTimeoutError>()(
  "ClaudeMcpRegistrationTimeoutError",
  {},
) {
  override get message(): string {
    return "Claude timed out while registering its MCP tools. Retry the turn; if it keeps failing, check Claude and the server logs.";
  }
}

export class ClaudeBackgroundWorkBlocksQueryReplacementError extends Schema.TaggedError<ClaudeBackgroundWorkBlocksQueryReplacementError>()(
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  {},
) {
  override get message(): string {
    return "Claude is still running background agents or commands, and this model or setting change would end them. Wait for them to finish, or press Stop, then send the message again.";
  }
}

export class ClaudeAppendSystemPromptFileError extends Schema.TaggedError<ClaudeAppendSystemPromptFileError>()(
  "ClaudeAppendSystemPromptFileError",
  {
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Claude could not read the --append-system-prompt-file launch argument at ${this.path}. Fix the path in the Claude launch arguments, then send the message again.`;
  }
}

export class ClaudeAppendSystemPromptMissingValueError extends Schema.TaggedError<ClaudeAppendSystemPromptMissingValueError>()(
  "ClaudeAppendSystemPromptMissingValueError",
  { flag: Schema.Literals(["--append-system-prompt", "--append-system-prompt-file"]) },
) {
  override get message(): string {
    return `The ${this.flag} launch argument has no ${this.flag === "--append-system-prompt" ? "text" : "file path"}. Add it after the flag in the Claude launch arguments, then send the message again.`;
  }
}

export class ClaudeSettingsLaunchArgError extends Schema.TaggedError<ClaudeSettingsLaunchArgError>()(
  "ClaudeSettingsLaunchArgError",
  {
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Claude could not read the --settings launch argument${this.path === undefined ? "" : ` at ${this.path}`} as a JSON object. Fix it in the Claude launch arguments, then send the message again.`;
  }
}

export interface ClaudeAgentSdkSessionForkInput {
  readonly sessionId: string;
  readonly options: ForkSessionOptions;
  readonly environment: NodeJS.ProcessEnv;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}

export interface ClaudeAgentSdkSubagentLookupInput {
  readonly sessionId: string;
  readonly agentId: string;
  readonly dir: string | null;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}
