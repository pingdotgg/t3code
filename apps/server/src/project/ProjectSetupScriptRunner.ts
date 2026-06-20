import { ProjectId } from "@t3tools/contracts";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
}

export class ProjectSetupScriptOperationError extends Schema.TaggedErrorClass<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "openTerminal", "writeCommand"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project setup script project was not found for thread '${this.threadId}'.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

const isProjectSetupScriptRunnerError = Schema.is(ProjectSetupScriptRunnerError);

function operationError(
  input: ProjectSetupScriptRunnerInput,
  operation: ProjectSetupScriptOperationError["operation"],
  cause: unknown,
): ProjectSetupScriptOperationError {
  return new ProjectSetupScriptOperationError({
    threadId: input.threadId,
    worktreePath: input.worktreePath,
    operation,
    cause,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
  });
}

function mapRunnerError(
  input: ProjectSetupScriptRunnerInput,
  operation: ProjectSetupScriptOperationError["operation"],
) {
  return Effect.mapError((cause: unknown) =>
    isProjectSetupScriptRunnerError(cause) ? cause : operationError(input, operation, cause),
  );
}

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery
          .getProjectShellById(ProjectId.make(input.projectId))
          .pipe(Effect.map(Option.getOrUndefined), mapRunnerError(input, "resolveProject"))
      : null;
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projectionSnapshotQuery
            .getActiveProjectByWorkspaceRoot(input.projectCwd)
            .pipe(Effect.map(Option.getOrUndefined), mapRunnerError(input, "resolveProject"))
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError({
        threadId: input.threadId,
        worktreePath: input.worktreePath,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
      });
    }

    const script = setupProjectScript(project.scripts);
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env,
      })
      .pipe(mapRunnerError(input, "openTerminal"));
    yield* terminalManager
      .write({
        threadId: input.threadId,
        terminalId,
        data: `${script.command}\r`,
      })
      .pipe(mapRunnerError(input, "writeCommand"));

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      terminalId,
      cwd,
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
