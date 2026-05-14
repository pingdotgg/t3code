import { ProjectId } from "@t3tools/contracts";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import {
  type ProjectSetupScriptRunnerShape,
  ProjectSetupScriptRunner,
  ProjectSetupScriptRunnerError,
} from "../Services/ProjectSetupScriptRunner.ts";

const makeProjectSetupScriptRunner = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager;

  const runForThread: ProjectSetupScriptRunnerShape["runForThread"] = (input) =>
    Effect.gen(function* () {
      const project =
        (input.projectId
          ? yield* projectionSnapshotQuery
              .getProjectShellById(ProjectId.make(input.projectId))
              .pipe(Effect.map(Option.getOrUndefined))
          : null) ??
        (input.projectCwd
          ? yield* projectionSnapshotQuery
              .getActiveProjectByWorkspaceRoot(input.projectCwd)
              .pipe(Effect.map(Option.getOrUndefined))
          : null) ??
        null;

      if (!project) {
        return yield* new ProjectSetupScriptRunnerError({
          message: "Project was not found for setup script execution.",
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

      yield* terminalManager.open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env,
      });
      yield* terminalManager.write({
        threadId: input.threadId,
        terminalId,
        data: `${script.command}\r`,
      });

      return {
        status: "started",
        scriptId: script.id,
        scriptName: script.name,
        terminalId,
        cwd,
      } as const;
    }).pipe(
      Effect.mapError((cause) => {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "_tag" in cause &&
          cause._tag === "ProjectSetupScriptRunnerError"
        ) {
          return cause as ProjectSetupScriptRunnerError;
        }
        const message =
          typeof cause === "object" &&
          cause !== null &&
          "message" in cause &&
          typeof cause.message === "string"
            ? cause.message
            : String(cause);
        return new ProjectSetupScriptRunnerError({ message });
      }),
    );

  return {
    runForThread,
  } satisfies ProjectSetupScriptRunnerShape;
});

export const ProjectSetupScriptRunnerLive = Layer.effect(
  ProjectSetupScriptRunner,
  makeProjectSetupScriptRunner,
);
