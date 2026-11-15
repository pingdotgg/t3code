import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Project Memory Vaults: folders of Markdown notes that agents read and maintain. A vault is
 * chosen per thread and is independent of the thread's project, folder, and repository.
 */

export const MemoryVaultId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
export type MemoryVaultId = typeof MemoryVaultId.Type;

/** A file inside a vault: Markdown or text, at most one folder deep. */
export const MemoryVaultFilePath = Schema.String.check(
  Schema.isPattern(
    /^(?:[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9 _.-]{0,95}\.(?:md|txt)$/,
  ),
);
export type MemoryVaultFilePath = typeof MemoryVaultFilePath.Type;

/**
 * `read-write`: relevant notes are added to each turn and the agent may update the vault.
 * `read-only`: notes are added, but the agent cannot change them.
 * `reference`: nothing is added automatically; the agent may search or read it when needed.
 */
export const MemoryVaultAccess = Schema.Literals(["read-write", "read-only", "reference"]);
export type MemoryVaultAccess = typeof MemoryVaultAccess.Type;

export const MemoryVaultDetailLevel = Schema.Literals(["concise", "standard", "detailed"]);
export type MemoryVaultDetailLevel = typeof MemoryVaultDetailLevel.Type;

/** `relevant`: matching sections only. `full`: the whole vault, within the budget. */
export const MemoryVaultRetrieval = Schema.Literals(["relevant", "full"]);
export type MemoryVaultRetrieval = typeof MemoryVaultRetrieval.Type;

export const MemoryVaultSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Give a thread without a vault one named after its project on its first turn. */
  autoCreate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Ask agents with write access to record important work as they go. */
  autoUpdate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  defaultVaultId: Schema.NullOr(MemoryVaultId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  defaultAccess: MemoryVaultAccess.pipe(
    Schema.withDecodingDefault(Effect.succeed<MemoryVaultAccess>("read-write")),
  ),
  detailLevel: MemoryVaultDetailLevel.pipe(
    Schema.withDecodingDefault(Effect.succeed<MemoryVaultDetailLevel>("standard")),
  ),
  retrieval: MemoryVaultRetrieval.pipe(
    Schema.withDecodingDefault(Effect.succeed<MemoryVaultRetrieval>("relevant")),
  ),
  /** Characters of vault text added to a turn. */
  contextBudgetChars: Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 40_000 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(6_000)),
  ),
  /** Empty uses the default folder in Continuum's data directory. */
  storageRoot: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type MemoryVaultSettings = typeof MemoryVaultSettings.Type;

export const MemoryVaultFile = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
  updatedAt: Schema.String,
});
export type MemoryVaultFile = typeof MemoryVaultFile.Type;

export const MemoryVaultSummary = Schema.Struct({
  id: MemoryVaultId,
  name: Schema.String,
  createdAt: Schema.String,
  files: Schema.Array(MemoryVaultFile),
});
export type MemoryVaultSummary = typeof MemoryVaultSummary.Type;

export const MemoryVaultSelection = Schema.Struct({
  vaultId: Schema.NullOr(MemoryVaultId),
  access: MemoryVaultAccess,
  /** True when the thread follows the default rather than its own choice. */
  inherited: Schema.Boolean,
});
export type MemoryVaultSelection = typeof MemoryVaultSelection.Type;

export const MemoryVaultOverviewInput = Schema.Struct({
  threadId: Schema.optionalKey(Schema.String),
});
export const MemoryVaultOverview = Schema.Struct({
  settings: MemoryVaultSettings,
  storageRoot: Schema.String,
  vaults: Schema.Array(MemoryVaultSummary),
  selection: Schema.optionalKey(MemoryVaultSelection),
});
export type MemoryVaultOverview = typeof MemoryVaultOverview.Type;

export const MemoryVaultManageInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("create"), name: Schema.String }),
  Schema.Struct({ action: Schema.Literal("rename"), vaultId: MemoryVaultId, name: Schema.String }),
  Schema.Struct({ action: Schema.Literal("delete"), vaultId: MemoryVaultId }),
  /** Copies the vault's files into `directory` (created if missing). */
  Schema.Struct({
    action: Schema.Literal("export"),
    vaultId: MemoryVaultId,
    directory: Schema.String,
  }),
  /** Creates a vault from the Markdown and text files in `directory`. */
  Schema.Struct({
    action: Schema.Literal("import"),
    directory: Schema.String,
    name: Schema.String,
  }),
]);
export type MemoryVaultManageInput = typeof MemoryVaultManageInput.Type;

export const MemoryVaultManageResult = Schema.Struct({
  vaultId: Schema.NullOr(MemoryVaultId),
  path: Schema.NullOr(Schema.String),
});

export const MemoryVaultReadInput = Schema.Struct({
  vaultId: MemoryVaultId,
  path: MemoryVaultFilePath,
});
export const MemoryVaultReadResult = Schema.Struct({ content: Schema.String });

export const MemoryVaultWriteInput = Schema.Struct({
  vaultId: MemoryVaultId,
  path: MemoryVaultFilePath,
  content: Schema.String,
});

export const MemoryVaultSearchInput = Schema.Struct({
  vaultId: Schema.optionalKey(MemoryVaultId),
  query: Schema.String,
});
export const MemoryVaultSearchHit = Schema.Struct({
  vaultId: MemoryVaultId,
  path: Schema.String,
  heading: Schema.String,
  excerpt: Schema.String,
  score: Schema.Number,
});
export type MemoryVaultSearchHit = typeof MemoryVaultSearchHit.Type;
export const MemoryVaultSearchResult = Schema.Struct({ hits: Schema.Array(MemoryVaultSearchHit) });

export const MemoryVaultSelectInput = Schema.Struct({
  threadId: Schema.String,
  /** Null selects no vault; omit both to return to the default. */
  vaultId: Schema.optionalKey(Schema.NullOr(MemoryVaultId)),
  access: Schema.optionalKey(MemoryVaultAccess),
  reset: Schema.optionalKey(Schema.Boolean),
});

export const MemoryVaultSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  autoCreate: Schema.optionalKey(Schema.Boolean),
  autoUpdate: Schema.optionalKey(Schema.Boolean),
  defaultVaultId: Schema.optionalKey(Schema.NullOr(MemoryVaultId)),
  defaultAccess: Schema.optionalKey(MemoryVaultAccess),
  detailLevel: Schema.optionalKey(MemoryVaultDetailLevel),
  retrieval: Schema.optionalKey(MemoryVaultRetrieval),
  contextBudgetChars: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 40_000 })),
  ),
  storageRoot: Schema.optionalKey(Schema.String),
});
export type MemoryVaultSettingsPatch = typeof MemoryVaultSettingsPatch.Type;

export class MemoryVaultError extends Schema.TaggedError<MemoryVaultError>()("MemoryVaultError", {
  message: Schema.String,
}) {}
