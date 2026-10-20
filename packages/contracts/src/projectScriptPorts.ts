import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProjectRunScriptInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  scriptId: TrimmedNonEmptyString,
});
export type ProjectRunScriptInput = typeof ProjectRunScriptInput.Type;

export const ProjectRunScriptResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("no-script") }),
  Schema.Struct({
    status: Schema.Literal("started"),
    threadId: ThreadId,
    terminalId: TrimmedNonEmptyString,
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  }),
]);
export type ProjectRunScriptResult = typeof ProjectRunScriptResult.Type;

export class ProjectRunScriptError extends Schema.TaggedError<ProjectRunScriptError>()(
  "ProjectRunScriptError",
  { threadId: ThreadId, projectId: ProjectId, scriptId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not run this action.";
  }
}

export const ProjectScriptPortsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  scriptIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100)),
});
export type ProjectScriptPortsInput = typeof ProjectScriptPortsInput.Type;

export const ProjectScriptPortsResult = Schema.Struct({
  ports: Schema.Record(
    Schema.String,
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  ),
});

export class ProjectScriptPortUnavailableError extends Schema.TaggedError<ProjectScriptPortUnavailableError>()(
  "ProjectScriptPortUnavailableError",
  { startPort: Schema.Int, attempts: Schema.Int },
) {
  override get message(): string {
    return `Could not assign a preview port after checking ${this.attempts} ports. Stop an unused server and try again.`;
  }
}
