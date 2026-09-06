import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectScriptIcon } from "./project.ts";
import { TerminalId } from "./terminal.ts";
import { TerminalMcpAcceptedInputResult, TerminalMcpSession } from "./terminalMcp.ts";

export const PROJECT_SCRIPT_MCP_DEFAULT_LIST_LIMIT = 20;
export const PROJECT_SCRIPT_MCP_MAX_LIST_LIMIT = 50;
export const PROJECT_SCRIPT_MCP_DEFAULT_PREVIEW_CHARS = 240;
export const PROJECT_SCRIPT_MCP_MAX_PREVIEW_CHARS = 1_000;

const ListLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(PROJECT_SCRIPT_MCP_MAX_LIST_LIMIT),
);
const PreviewLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(PROJECT_SCRIPT_MCP_MAX_PREVIEW_CHARS),
);
const ScriptId = TrimmedNonEmptyString;
const TargetThreadFields = { threadId: Schema.optional(ThreadId) };

export const ProjectScriptMcpListInput = Schema.Struct({
  ...TargetThreadFields,
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(ListLimit),
  commandPreviewChars: Schema.optional(PreviewLimit),
});
export type ProjectScriptMcpListInput = typeof ProjectScriptMcpListInput.Type;

export const ProjectScriptMcpRunInput = Schema.Struct({
  ...TargetThreadFields,
  scriptId: ScriptId,
  terminalId: TerminalId,
});
export type ProjectScriptMcpRunInput = typeof ProjectScriptMcpRunInput.Type;

export const ProjectScriptMcpStopInput = Schema.Struct({
  ...TargetThreadFields,
  scriptId: ScriptId,
  terminalId: TerminalId,
});
export type ProjectScriptMcpStopInput = typeof ProjectScriptMcpStopInput.Type;

export const ProjectScriptMcpPreview = Schema.Struct({
  scriptId: ScriptId,
  name: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  previewUrl: Schema.NullOr(Schema.String),
  autoOpenPreview: Schema.Boolean,
  commandPreview: Schema.String,
  commandCharacters: NonNegativeInt,
  commandTruncated: Schema.Boolean,
});
export type ProjectScriptMcpPreview = typeof ProjectScriptMcpPreview.Type;

export const ProjectScriptMcpListResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  scripts: Schema.Array(ProjectScriptMcpPreview),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type ProjectScriptMcpListResult = typeof ProjectScriptMcpListResult.Type;

export const ProjectScriptMcpRunResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  scriptId: ScriptId,
  terminalId: TerminalId,
  outcome: Schema.Literals(["input_accepted", "terminal_opened_input_failed"]),
  terminal: TerminalMcpSession,
  inputAcceptance: Schema.NullOr(TerminalMcpAcceptedInputResult),
  error: Schema.NullOr(Schema.String),
  previewUrl: Schema.NullOr(Schema.String),
  previewAutoOpened: Schema.Literal(false),
});
export type ProjectScriptMcpRunResult = typeof ProjectScriptMcpRunResult.Type;

export const ProjectScriptMcpStopResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  scriptId: ScriptId,
  terminalId: TerminalId,
  stopped: Schema.Literal(true),
});
export type ProjectScriptMcpStopResult = typeof ProjectScriptMcpStopResult.Type;

export const ProjectScriptMcpFailureCode = Schema.Literals([
  "capability_denied",
  "thread_not_found",
  "project_not_found",
  "execution_policy_denied",
  "script_not_found",
  "script_command_too_large",
  "script_run_not_found",
  "terminal_not_found",
  "terminal_not_running",
  "terminal_already_exists",
  "operation_failed",
]);
export type ProjectScriptMcpFailureCode = typeof ProjectScriptMcpFailureCode.Type;

export class ProjectScriptMcpFailure extends Schema.TaggedErrorClass<ProjectScriptMcpFailure>()(
  "ProjectScriptMcpFailure",
  {
    code: ProjectScriptMcpFailureCode,
    message: Schema.String,
  },
) {}
