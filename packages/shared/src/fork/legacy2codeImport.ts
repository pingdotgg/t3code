import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const LEGACY_2CODE_IMPORT_VERSION = 1 as const;

export const Legacy2CodeImportProject = Schema.Struct({
  legacyPath: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
});
export type Legacy2CodeImportProject = typeof Legacy2CodeImportProject.Type;

const Legacy2CodeImportThreadBase = {
  legacyId: TrimmedNonEmptyString,
  projectPath: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  subtitle: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  createdAt: Schema.optional(IsoDateTime),
  legacyRoute: Schema.optional(
    Schema.Literals(["anthropic", "hybrid", "codex-via-claude", "native-codex"]),
  ),
};

export const Legacy2CodeImportThread = Schema.Union([
  Schema.Struct({
    ...Legacy2CodeImportThreadBase,
    provider: Schema.Literal("claude"),
    resumeCursor: Schema.Struct({ resume: TrimmedNonEmptyString }),
  }),
  Schema.Struct({
    ...Legacy2CodeImportThreadBase,
    provider: Schema.Literal("codex"),
    resumeCursor: Schema.Struct({ threadId: TrimmedNonEmptyString }),
  }),
]);
export type Legacy2CodeImportThread = typeof Legacy2CodeImportThread.Type;

export const Legacy2CodeClaudeCodexRouting = Schema.Struct({
  enabled: Schema.Literal(true),
  model: Schema.optional(TrimmedNonEmptyString),
});
export type Legacy2CodeClaudeCodexRouting = typeof Legacy2CodeClaudeCodexRouting.Type;

/**
 * Immutable hand-off written by the desktop compatibility build and consumed
 * by the server startup importer. It intentionally contains provider resume
 * cursors, not reconstructed messages; provider history remains authoritative.
 */
export const Legacy2CodeImportManifest = Schema.Struct({
  version: Schema.Literal(LEGACY_2CODE_IMPORT_VERSION),
  source: Schema.Struct({
    workspacePath: TrimmedNonEmptyString,
    sha256: TrimmedNonEmptyString,
  }),
  projects: Schema.Array(Legacy2CodeImportProject),
  threads: Schema.Array(Legacy2CodeImportThread),
  claudeCodexRouting: Schema.optional(Legacy2CodeClaudeCodexRouting),
  skippedSessions: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type Legacy2CodeImportManifest = typeof Legacy2CodeImportManifest.Type;

export const Legacy2CodeImportManifestJson = Schema.fromJsonString(Legacy2CodeImportManifest);
export const decodeLegacy2CodeImportManifestJson = Schema.decodeUnknownEffect(
  Legacy2CodeImportManifestJson,
);
export const encodeLegacy2CodeImportManifestJson = Schema.encodeEffect(
  Legacy2CodeImportManifestJson,
);
