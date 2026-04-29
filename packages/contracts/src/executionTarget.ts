import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ExecutionTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local") }),
  Schema.Struct({
    kind: Schema.Literal("wsl"),
    distroName: TrimmedNonEmptyString,
    user: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type ExecutionTarget = typeof ExecutionTarget.Type;

export const LocalExecutionTarget: ExecutionTarget = { kind: "local" };

export const ProjectLocation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("local"),
    path: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("wsl"),
    distroName: TrimmedNonEmptyString,
    user: Schema.optional(TrimmedNonEmptyString),
    path: TrimmedNonEmptyString,
  }),
]);
export type ProjectLocation = typeof ProjectLocation.Type;

export const WslDistribution = Schema.Struct({
  name: TrimmedNonEmptyString,
  default: Schema.Boolean,
  running: Schema.Boolean,
  version: Schema.optional(Schema.Number),
});
export type WslDistribution = typeof WslDistribution.Type;

export const WslListDistributionsResult = Schema.Struct({
  distributions: Schema.Array(WslDistribution),
});
export type WslListDistributionsResult = typeof WslListDistributionsResult.Type;

export const WslTargetInput = Schema.Struct({
  target: Schema.Struct({
    kind: Schema.Literal("wsl"),
    distroName: TrimmedNonEmptyString,
    user: Schema.optional(TrimmedNonEmptyString),
  }),
});

export const WslBrowseInput = Schema.Struct({
  ...WslTargetInput.fields,
  partialPath: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type WslBrowseInput = typeof WslBrowseInput.Type;

export const WslResolvePathInput = Schema.Struct({
  ...WslTargetInput.fields,
  path: TrimmedNonEmptyString,
});
export type WslResolvePathInput = typeof WslResolvePathInput.Type;

export const WslResolvePathResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  exists: Schema.Boolean,
  kind: Schema.optional(Schema.Literals(["file", "directory"])),
});
export type WslResolvePathResult = typeof WslResolvePathResult.Type;
