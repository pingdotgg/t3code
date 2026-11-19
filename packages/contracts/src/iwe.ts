import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * IWE (https://iwe.md) workspaces: folders of Markdown notes with `.iwe/config.toml`. Continuum
 * opens them in place and drives IWE's own tools: the `iwe` CLI for notes and search, and the
 * `iwes` language server for link completion and renames. It never rewrites IWE's settings.
 */

export const IweBinary = Schema.Struct({
  path: Schema.String,
  version: Schema.NullOr(Schema.String),
  source: Schema.Literals(["path", "managed"]),
});
export type IweBinary = typeof IweBinary.Type;

export const IweSetupStep = Schema.Struct({
  title: Schema.String,
  commands: Schema.Array(Schema.String),
  note: Schema.NullOr(Schema.String),
});
export type IweSetupStep = typeof IweSetupStep.Type;

export const IweToolStatus = Schema.Struct({
  /** `iwe`, the CLI that searches, reads, and writes notes. */
  cli: Schema.NullOr(IweBinary),
  /** `iwes`, the language server behind link completion and renames. */
  languageServer: Schema.NullOr(IweBinary),
  /** `iwec`, IWE's MCP server; Continuum's agent tools use the CLI and do not need it. */
  mcpServer: Schema.NullOr(IweBinary),
  /** The recommended route for this OS first. */
  setup: Schema.Array(IweSetupStep),
  /** A prebuilt release Continuum can download into its tools folder. */
  managedInstall: Schema.NullOr(
    Schema.Struct({ version: Schema.String, url: Schema.String, source: Schema.String }),
  ),
});
export type IweToolStatus = typeof IweToolStatus.Type;

export const IweWorkspaceInfo = Schema.Struct({
  root: Schema.String,
  name: Schema.String,
  /** Where notes live: the root, or `[workspace] path` from the config. */
  notesRoot: Schema.String,
  linkFormat: Schema.String,
  refsExtension: Schema.String,
  documentCount: Schema.Int,
});
export type IweWorkspaceInfo = typeof IweWorkspaceInfo.Type;

export const IweLink = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
});
export type IweLink = typeof IweLink.Type;

export const IweNoteSummary = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  references: Schema.Array(IweLink),
  includes: Schema.Array(IweLink),
  referencedBy: Schema.Array(IweLink),
  includedBy: Schema.Array(IweLink),
});
export type IweNoteSummary = typeof IweNoteSummary.Type;

export const IweNote = Schema.Struct({
  ...IweNoteSummary.fields,
  path: Schema.String,
  content: Schema.String,
  modifiedAt: Schema.NullOr(IsoDateTime),
});
export type IweNote = typeof IweNote.Type;

export const IweCompletion = Schema.Struct({
  label: Schema.String,
  insertText: Schema.String,
  /** The text to replace, as UTF-16 offsets into the line the cursor is on. */
  replaceFrom: Schema.Int,
  replaceTo: Schema.Int,
});
export type IweCompletion = typeof IweCompletion.Type;

export const IweNoteActivity = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  action: Schema.Literals(["attached", "searched", "read", "created", "updated", "renamed"]),
  by: Schema.Literals(["agent", "user"]),
  at: IsoDateTime,
});
export type IweNoteActivity = typeof IweNoteActivity.Type;

export const IweThreadState = Schema.Struct({
  threadId: ThreadId,
  workspaceRoot: Schema.NullOr(Schema.String),
  /** Notes waiting to go out with the next message, each with its linked context. */
  attachments: Schema.Array(
    Schema.Struct({ key: Schema.String, title: Schema.String, depth: Schema.Int }),
  ),
  activity: Schema.Array(IweNoteActivity),
});
export type IweThreadState = typeof IweThreadState.Type;

const Root = Schema.Struct({ root: TrimmedNonEmptyString });

export const IwePrepareWorkspaceInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  mode: Schema.Literals(["open", "new"]),
});
export type IwePrepareWorkspaceInput = typeof IwePrepareWorkspaceInput.Type;

export const IweWorkspaceInput = Root;
export const IweSearchInput = Schema.Struct({
  ...Root.fields,
  query: Schema.String,
  mode: Schema.Literals(["fuzzy", "lexical", "both"]),
  limit: Schema.optionalKey(Schema.Int),
});
export type IweSearchInput = typeof IweSearchInput.Type;

export const IweNoteInput = Schema.Struct({ ...Root.fields, key: TrimmedNonEmptyString });
export type IweNoteInput = typeof IweNoteInput.Type;

export const IweSaveNoteInput = Schema.Struct({
  ...Root.fields,
  key: TrimmedNonEmptyString,
  content: Schema.String,
  threadId: Schema.optionalKey(ThreadId),
});
export type IweSaveNoteInput = typeof IweSaveNoteInput.Type;

export const IweCreateNoteInput = Schema.Struct({
  ...Root.fields,
  title: TrimmedNonEmptyString,
  content: Schema.optionalKey(Schema.String),
});
export type IweCreateNoteInput = typeof IweCreateNoteInput.Type;

export const IweRenameNoteInput = Schema.Struct({
  ...Root.fields,
  key: TrimmedNonEmptyString,
  newKey: TrimmedNonEmptyString,
});
export type IweRenameNoteInput = typeof IweRenameNoteInput.Type;

export const IweEditorPositionInput = Schema.Struct({
  ...Root.fields,
  key: TrimmedNonEmptyString,
  /** The editor's current text, which may not be saved yet. */
  text: Schema.String,
  line: Schema.Int,
  character: Schema.Int,
});
export type IweEditorPositionInput = typeof IweEditorPositionInput.Type;

export const IweRenameLinkInput = Schema.Struct({
  ...IweEditorPositionInput.fields,
  newName: TrimmedNonEmptyString,
});
export type IweRenameLinkInput = typeof IweRenameLinkInput.Type;

export const IweRenameResult = Schema.Struct({
  changedFiles: Schema.Array(Schema.String),
  /** The note's key afterwards, when the rename moved the open note. */
  key: Schema.String,
});
export type IweRenameResult = typeof IweRenameResult.Type;

export const IweThreadInput = Schema.Struct({ threadId: ThreadId });
export const IweAttachInput = Schema.Struct({
  threadId: ThreadId,
  root: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  /** How many link hops of related notes go with it (0 for the note alone). */
  depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
});
export type IweAttachInput = typeof IweAttachInput.Type;
export const IweDetachInput = Schema.Struct({ threadId: ThreadId, key: TrimmedNonEmptyString });
export const IweSelectWorkspaceInput = Schema.Struct({
  threadId: ThreadId,
  root: Schema.NullOr(TrimmedNonEmptyString),
});

export const IweInstallEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    completedBytes: Schema.NullOr(Schema.Number),
    totalBytes: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("complete"), status: IweToolStatus }),
]);
export type IweInstallEvent = typeof IweInstallEvent.Type;

export class IweError extends Schema.TaggedError<IweError>()("IweError", {
  message: Schema.String,
}) {}
