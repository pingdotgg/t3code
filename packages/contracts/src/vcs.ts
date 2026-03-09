import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

export const VcsBackend = Schema.Literals(["git", "jj"]);
export type VcsBackend = typeof VcsBackend.Type;

export const VcsRefKind = Schema.Literals([
  "branch",
  "bookmark",
  "remoteBranch",
  "remoteBookmark",
]);
export type VcsRefKind = typeof VcsRefKind.Type;

export const VcsCapabilities = Schema.Struct({
  supportsPull: Schema.Boolean,
  supportsRunStackedAction: Schema.Boolean,
  supportsCreateWorkspace: Schema.Boolean,
  supportsRemoveWorkspace: Schema.Boolean,
  supportsCreateRef: Schema.Boolean,
  supportsCheckoutRef: Schema.Boolean,
  supportsInit: Schema.Boolean,
  supportsCheckpointing: Schema.Boolean,
});
export type VcsCapabilities = typeof VcsCapabilities.Type;

export const VcsRef = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  kind: VcsRefKind,
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  workspacePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsRef = typeof VcsRef.Type;

const VcsStatusPrState = Schema.Literals(["open", "closed", "merged"]);

const VcsStatusPr = Schema.Struct({
  number: NonNegativeInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseRef: TrimmedNonEmptyStringSchema,
  headRef: TrimmedNonEmptyStringSchema,
  state: VcsStatusPrState,
});

const VcsInputBase = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  backend: Schema.optional(VcsBackend),
});

export const VcsStatusInput = VcsInputBase;
export type VcsStatusInput = typeof VcsStatusInput.Type;

export const VcsListRefsInput = VcsInputBase;
export type VcsListRefsInput = typeof VcsListRefsInput.Type;

export const VcsCreateWorkspaceInput = Schema.Struct({
  ...VcsInputBase.fields,
  refName: TrimmedNonEmptyStringSchema,
  refKind: VcsRefKind,
  newRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsCreateWorkspaceInput = typeof VcsCreateWorkspaceInput.Type;

export const VcsRemoveWorkspaceInput = Schema.Struct({
  ...VcsInputBase.fields,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type VcsRemoveWorkspaceInput = typeof VcsRemoveWorkspaceInput.Type;

export const VcsCreateRefInput = Schema.Struct({
  ...VcsInputBase.fields,
  refName: TrimmedNonEmptyStringSchema,
  refKind: VcsRefKind,
});
export type VcsCreateRefInput = typeof VcsCreateRefInput.Type;

export const VcsCheckoutRefInput = Schema.Struct({
  ...VcsInputBase.fields,
  refName: TrimmedNonEmptyStringSchema,
  refKind: VcsRefKind,
});
export type VcsCheckoutRefInput = typeof VcsCheckoutRefInput.Type;

export const VcsInitInput = VcsInputBase;
export type VcsInitInput = typeof VcsInitInput.Type;

export const VcsStatusResult = Schema.Struct({
  backend: VcsBackend,
  capabilities: VcsCapabilities,
  refName: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  refKind: Schema.NullOr(VcsRefKind),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: TrimmedNonEmptyStringSchema,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  pr: Schema.NullOr(VcsStatusPr),
});
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsListRefsResult = Schema.Struct({
  backend: VcsBackend,
  capabilities: VcsCapabilities,
  refs: Schema.Array(VcsRef),
  isRepo: Schema.Boolean,
});
export type VcsListRefsResult = typeof VcsListRefsResult.Type;

export const VcsCreateWorkspaceResult = Schema.Struct({
  backend: VcsBackend,
  workspace: Schema.Struct({
    path: TrimmedNonEmptyStringSchema,
    refName: TrimmedNonEmptyStringSchema,
    refKind: VcsRefKind,
  }),
});
export type VcsCreateWorkspaceResult = typeof VcsCreateWorkspaceResult.Type;
