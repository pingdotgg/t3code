import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationProjectShell } from "./orchestration.ts";

export const PROJECT_TRANSFER_CHUNK_BYTES = 256 * 1024;
export const PROJECT_TRANSFER_MAX_BYTES = 10 * 1024 * 1024 * 1024;
export const ProjectTransferMode = Schema.Literals(["clone", "copy"]);
export type ProjectTransferMode = typeof ProjectTransferMode.Type;

export const ProjectTransferConfiguration = Schema.Struct({
  project: OrchestrationProjectShell,
  agentBrowserAccess: Schema.Boolean,
  remoteUrl: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProjectTransferConfiguration = typeof ProjectTransferConfiguration.Type;

const TransferId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const ProjectTransferInput = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("prepare"),
    projectId: ProjectId,
    mode: ProjectTransferMode,
    includeIgnored: Schema.Boolean,
  }),
  Schema.Struct({
    operation: Schema.Literal("read"),
    transferId: TransferId,
    offset: NonNegativeInt,
  }),
  Schema.Struct({
    operation: Schema.Literal("begin"),
    destinationPath: TrimmedNonEmptyString,
    configuration: ProjectTransferConfiguration,
    mode: ProjectTransferMode,
    byteLength: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROJECT_TRANSFER_MAX_BYTES)),
  }),
  Schema.Struct({
    operation: Schema.Literal("write"),
    transferId: TransferId,
    offset: NonNegativeInt,
    data: Schema.String.check(Schema.isMaxLength(4 * Math.ceil(PROJECT_TRANSFER_CHUNK_BYTES / 3))),
  }),
  Schema.Struct({ operation: Schema.Literal("finish"), transferId: TransferId }),
  Schema.Struct({ operation: Schema.Literal("release"), transferId: TransferId }),
]);
export type ProjectTransferInput = typeof ProjectTransferInput.Type;

export const ProjectTransferResult = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("prepare"),
    transferId: TransferId,
    configuration: ProjectTransferConfiguration,
    byteLength: NonNegativeInt,
  }),
  Schema.Struct({ operation: Schema.Literal("read"), data: Schema.String }),
  Schema.Struct({ operation: Schema.Literal("begin"), transferId: TransferId }),
  Schema.Struct({ operation: Schema.Literal("write") }),
  Schema.Struct({
    operation: Schema.Literal("finish"),
    projectId: ProjectId,
    cwd: TrimmedNonEmptyString,
  }),
  Schema.Struct({ operation: Schema.Literal("release") }),
]);
export type ProjectTransferResult = typeof ProjectTransferResult.Type;

export class ProjectTransferError extends Schema.TaggedError<ProjectTransferError>()(
  "ProjectTransferError",
  { message: Schema.String },
) {}
