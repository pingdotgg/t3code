import { Effect, Schema } from "effect";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  OrchestrationMessageRole,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";

export class CodexImportError extends Schema.TaggedErrorClass<CodexImportError>()(
  "CodexImportError",
  {
    message: Schema.String,
  },
) {}

export const CodexImportSessionKind = Schema.Literals([
  "direct",
  "subagent-child",
  "orchestrator",
  "all",
]);
export type CodexImportSessionKind = typeof CodexImportSessionKind.Type;

export const CodexImportConcreteSessionKind = Schema.Literals([
  "direct",
  "subagent-child",
  "orchestrator",
]);
export type CodexImportConcreteSessionKind = typeof CodexImportConcreteSessionKind.Type;

export const CodexImportListSessionsInput = Schema.Struct({
  homePath: Schema.optionalKey(TrimmedNonEmptyString),
  query: Schema.optionalKey(TrimmedNonEmptyString),
  days: Schema.optionalKey(PositiveInt),
  limit: Schema.optionalKey(PositiveInt),
  kind: CodexImportSessionKind.pipe(Schema.withDecodingDefault(Effect.succeed("direct"))),
});
export type CodexImportListSessionsInput = typeof CodexImportListSessionsInput.Type;

export const CodexImportSessionSummary = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  cwd: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
  model: Schema.NullOr(TrimmedNonEmptyString),
  kind: CodexImportConcreteSessionKind,
  transcriptAvailable: Schema.Boolean,
  transcriptError: Schema.NullOr(TrimmedNonEmptyString),
  alreadyImported: Schema.Boolean,
  importedThreadId: Schema.NullOr(ThreadId),
  lastUserMessage: Schema.NullOr(Schema.String),
  lastAssistantMessage: Schema.NullOr(Schema.String),
});
export type CodexImportSessionSummary = typeof CodexImportSessionSummary.Type;

export const CodexImportPeekSessionInput = Schema.Struct({
  homePath: Schema.optionalKey(TrimmedNonEmptyString),
  sessionId: TrimmedNonEmptyString,
  messageCount: Schema.optionalKey(PositiveInt),
});
export type CodexImportPeekSessionInput = typeof CodexImportPeekSessionInput.Type;

export const CodexImportPeekMessage = Schema.Struct({
  role: OrchestrationMessageRole,
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type CodexImportPeekMessage = typeof CodexImportPeekMessage.Type;

export const CodexImportPeekSessionResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  cwd: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
  model: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  kind: CodexImportConcreteSessionKind,
  transcriptAvailable: Schema.Boolean,
  transcriptError: Schema.NullOr(TrimmedNonEmptyString),
  alreadyImported: Schema.Boolean,
  importedThreadId: Schema.NullOr(ThreadId),
  messages: Schema.Array(CodexImportPeekMessage),
});
export type CodexImportPeekSessionResult = typeof CodexImportPeekSessionResult.Type;

export const CodexImportImportSessionsInput = Schema.Struct({
  homePath: Schema.optionalKey(TrimmedNonEmptyString),
  targetProjectId: ProjectId,
  sessionIds: Schema.Array(TrimmedNonEmptyString),
});
export type CodexImportImportSessionsInput = typeof CodexImportImportSessionsInput.Type;

export const CodexImportImportSessionResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  status: Schema.Literals(["imported", "skipped-existing", "failed"]),
  threadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
  error: Schema.NullOr(TrimmedNonEmptyString),
});
export type CodexImportImportSessionResult = typeof CodexImportImportSessionResult.Type;

export const CodexImportImportSessionsResult = Schema.Struct({
  results: Schema.Array(CodexImportImportSessionResult),
});
export type CodexImportImportSessionsResult = typeof CodexImportImportSessionsResult.Type;
