import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** The largest instruction file T3 Code reads or writes, in characters. */
export const INSTRUCTION_MAX_CHARS = 1_048_576;

/** `managed` is the organization's file, which T3 Code only reads. */
export const InstructionScope = Schema.Literals(["project", "global", "managed"]);
export type InstructionScope = typeof InstructionScope.Type;

/**
 * Which file an entry is. `shared` is AGENTS.md (in a project, or the one file all agents share
 * across projects), `claude` is a CLAUDE.md, `claudeLocal` is CLAUDE.local.md, `agentOwn` is an
 * agent's own file in its home folder, and `nested` is an AGENTS.md or CLAUDE.md in a subfolder.
 */
export const InstructionKind = Schema.Literals([
  "shared",
  "claude",
  "claudeLocal",
  "agentOwn",
  "nested",
  "managed",
]);
export type InstructionKind = typeof InstructionKind.Type;

/**
 * How one agent reaches an instruction file. `direct`: it reads the file where it is. `link`: its
 * own home file links to this one. `import`: Claude's CLAUDE.md imports it. `setting`: Claude
 * reads it through its "Project instructions" setting. `none`: it doesn't read this file.
 */
export const InstructionAgentState = Schema.Literals([
  "direct",
  "link",
  "import",
  "setting",
  "none",
]);
export type InstructionAgentState = typeof InstructionAgentState.Type;

/** Why an agent with state `none` doesn't read the file. A client words each one. */
export const InstructionAgentReason = Schema.Literals([
  /** Claude reads its own CLAUDE.md files instead of AGENTS.md (see `blockingFile`). */
  "claudeFiles",
  /** Claude's "Project instructions" setting turns AGENTS.md off. */
  "settingOff",
  /** The agent's home file is a real file with different text. */
  "ownFile",
  /** The agent's version is too old to read this file. */
  "oldVersion",
]);
export type InstructionAgentReason = typeof InstructionAgentReason.Type;

export const InstructionAgentAccess = Schema.Struct({
  /** The enabled provider instance this is about. Instances of unknown drivers are never listed. */
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  state: InstructionAgentState,
  reason: Schema.optional(InstructionAgentReason),
  /** The file that makes Claude skip AGENTS.md, relative to the project, e.g. `CLAUDE.local.md`. */
  blockingFile: Schema.optional(Schema.String),
});
export type InstructionAgentAccess = typeof InstructionAgentAccess.Type;

export const InstructionEntry = Schema.Struct({
  /** A stable id the server built. Every action takes it back; a client never sends a path. */
  id: TrimmedNonEmptyString,
  scope: InstructionScope,
  kind: InstructionKind,
  /** Absolute path of the file, or where it would be created. */
  path: Schema.String,
  /** Relative to the project, for project and nested files. */
  relativePath: Schema.optional(Schema.String),
  exists: Schema.Boolean,
  /** Size in bytes; 0 when the file doesn't exist. */
  size: NonNegativeInt,
  readOnly: Schema.Boolean,
  /** The agent whose own file this is, for `agentOwn` and Claude's home CLAUDE.md. */
  owner: Schema.optional(ProviderInstanceId),
  access: Schema.Array(InstructionAgentAccess),
  /** The file has the same text as the shared all-projects file. */
  sameAsShared: Schema.optional(Schema.Boolean),
});
export type InstructionEntry = typeof InstructionEntry.Type;

/**
 * Claude's "Project instructions" setting: when it reads AGENTS.md. `claude-md-or-agents-md` is
 * its default (AGENTS.md only when there is no CLAUDE.md), `claude-md-and-agents-md` reads both,
 * `claude-md` never reads AGENTS.md, and `managed-only` is set by the organization.
 */
export const ClaudeInstructionValue = Schema.Literals([
  "claude-md-or-agents-md",
  "claude-md-and-agents-md",
  "claude-md",
  "managed-only",
]);
export type ClaudeInstructionValue = typeof ClaudeInstructionValue.Type;

export const ClaudeInstructionChoice = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** What applies now, whether the user chose it or it is Claude's default. */
  value: ClaudeInstructionValue,
  /** The user set it; false means Claude's default. */
  explicit: Schema.Boolean,
  /** This Claude Code version has the setting. */
  supported: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
});
export type ClaudeInstructionChoice = typeof ClaudeInstructionChoice.Type;

export const InstructionListInput = Schema.Struct({
  /** A registered project's folder, for its own instruction files. */
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type InstructionListInput = typeof InstructionListInput.Type;

/** A file that exists but couldn't be read. */
export const InstructionProblem = Schema.Struct({
  path: Schema.String,
  reason: Schema.optional(Schema.String),
});
export type InstructionProblem = typeof InstructionProblem.Type;

export const InstructionListResult = Schema.Struct({
  entries: Schema.Array(InstructionEntry),
  /** One per enabled Claude instance. */
  claude: Schema.Array(ClaudeInstructionChoice),
  /** Where the shared all-projects file is or would be created. */
  sharedPath: Schema.String,
  unreadable: Schema.Array(InstructionProblem),
});
export type InstructionListResult = typeof InstructionListResult.Type;

export const InstructionReadInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  id: TrimmedNonEmptyString,
});
export type InstructionReadInput = typeof InstructionReadInput.Type;

export const InstructionReadResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The text; null when the file is missing or too large to show. */
  contents: Schema.NullOr(Schema.String),
  /** Identifies this version of the file, to pass back as `expectedRevision`. Null when missing. */
  revision: Schema.NullOr(Schema.String),
  tooLarge: Schema.Boolean,
});
export type InstructionReadResult = typeof InstructionReadResult.Type;

/** Replace a file's text, or create it. Refused when the file changed since it was read. */
export const InstructionWriteInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  id: TrimmedNonEmptyString,
  contents: Schema.String.check(Schema.isMaxLength(INSTRUCTION_MAX_CHARS)),
  /** The revision that was read; null to create a file that must not exist yet. */
  expectedRevision: Schema.NullOr(Schema.String),
});
export type InstructionWriteInput = typeof InstructionWriteInput.Type;

export const InstructionWriteResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  revision: Schema.String,
});
export type InstructionWriteResult = typeof InstructionWriteResult.Type;

const InstructionAgents = Schema.Union([
  Schema.Literal("all"),
  Schema.Array(ProviderInstanceId).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
]);

/** Make each agent read the shared all-projects file, or stop. `all` means every enabled agent. */
export const InstructionAgentsInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  id: TrimmedNonEmptyString,
  agents: InstructionAgents,
});
export type InstructionAgentsInput = typeof InstructionAgentsInput.Type;

export const InstructionAgentsResult = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      outcome: Schema.Literals(["changed", "unchanged", "failed"]),
      reason: Schema.optional(Schema.String),
    }),
  ),
});
export type InstructionAgentsResult = typeof InstructionAgentsResult.Type;

/** Set Claude's "Project instructions" setting; null goes back to Claude's default. */
export const ClaudeInstructionSettingInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  value: Schema.NullOr(ClaudeInstructionValue),
});
export type ClaudeInstructionSettingInput = typeof ClaudeInstructionSettingInput.Type;

/**
 * Make a project's CLAUDE.md into AGENTS.md so every agent reads it. Without `merge` the file is
 * renamed and the project must have no AGENTS.md; with `merge` its text goes at the end of the
 * project's existing AGENTS.md and CLAUDE.md is deleted.
 */
export const InstructionShareInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  merge: Schema.Boolean,
});
export type InstructionShareInput = typeof InstructionShareInput.Type;

/** Move an agent's own home file into the shared all-projects file and link it there. */
export const InstructionAdoptInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type InstructionAdoptInput = typeof InstructionAdoptInput.Type;

/** Delete a real instruction file. This can't be undone. */
export const InstructionDeleteInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
  id: TrimmedNonEmptyString,
});
export type InstructionDeleteInput = typeof InstructionDeleteInput.Type;

/** Which of these project instruction files git tracks, so a move, merge or delete shows in git. */
export const InstructionTrackedInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  ids: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type InstructionTrackedInput = typeof InstructionTrackedInput.Type;

export const InstructionTrackedResult = Schema.Struct({
  /** Ids of the files git tracks. Never includes a global or managed file. */
  tracked: Schema.Array(TrimmedNonEmptyString),
});
export type InstructionTrackedResult = typeof InstructionTrackedResult.Type;

/** A request that couldn't be carried out, with a reason a client can word. */
export class InstructionError extends Schema.TaggedError<InstructionError>()("InstructionError", {
  reason: Schema.Literals([
    "changedOnDisk",
    "exists",
    "notFound",
    "readOnly",
    "tooLarge",
    "unknownEntry",
    "unregisteredProject",
    "invalidSettings",
    "linkFailed",
    "writeFailed",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
