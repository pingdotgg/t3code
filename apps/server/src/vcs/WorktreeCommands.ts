/**
 * WorktreeCommands - runs the user-configured shell commands that replace the
 * built-in worktree create and remove steps (the `worktreeCommands` setting,
 * resolved per project).
 *
 * @module WorktreeCommands
 */
import {
  GitCommandError,
  type VcsRemoveWorktreeInput,
  type WorktreeCommands as WorktreeCommandsSetting,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { CustomWorktreeCheckoutInput } from "./GitVcsDriver.ts";

// Creation often installs dependencies, so allow far longer than a git call.
const COMMAND_TIMEOUT = "15 minutes";
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
const ERROR_OUTPUT_TAIL_CHARS = 800;

/** Environment a create command sees. Removal gets the path and force flag instead. */
export function worktreeCreateCommandEnv(
  projectCwd: string,
  input: CustomWorktreeCheckoutInput,
): Record<string, string> {
  return {
    T3CODE_PROJECT_ROOT: projectCwd,
    T3CODE_WORKTREE_PATH: input.worktreePath,
    T3CODE_BRANCH: input.branch,
    T3CODE_START_REF: input.startRef,
    T3CODE_CREATE_BRANCH: input.createBranch ? "1" : "0",
  };
}

/**
 * A create command that places the checkout itself (tools with their own layout) reports it by
 * printing an absolute path as its last line of stdout.
 */
export function reportedCheckoutPath(stdout: string): string | null {
  const lastLine = stdout.trimEnd().split(/\r?\n/).at(-1)?.trim() ?? "";
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(lastLine) ? lastLine : null;
}

export function worktreeRemoveCommandEnv(input: VcsRemoveWorktreeInput): Record<string, string> {
  return {
    T3CODE_PROJECT_ROOT: input.cwd,
    T3CODE_WORKTREE_PATH: input.path,
    T3CODE_FORCE: input.force ? "1" : "0",
  };
}

export class WorktreeCommands extends Context.Service<
  WorktreeCommands,
  {
    /** The effective commands for the project rooted at `projectCwd`; `""` keeps the built-in step. */
    readonly resolve: (
      projectCwd: string,
    ) => Effect.Effect<WorktreeCommandsSetting, GitCommandError>;
    /** Runs `command` at `projectCwd`, failing on a non-zero exit. Resolves to its stdout. */
    readonly run: (input: {
      readonly operation: string;
      readonly command: string;
      readonly projectCwd: string;
      readonly env: Record<string, string>;
    }) => Effect.Effect<string, GitCommandError>;
  }
>()("t3/vcs/WorktreeCommands") {}

/** Same shell choice as the setup-script terminal, so a command behaves the same in both. */
function shellInvocation(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  command: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  if (platform === "win32") {
    return { command: "powershell.exe", args: ["-NoProfile", "-Command", command] };
  }
  return { command: env.SHELL || "/bin/sh", args: ["-c", command] };
}

function outputTail(stdout: string, stderr: string): string {
  const output = (stderr.trim() || stdout.trim()).slice(-ERROR_OUTPUT_TAIL_CHARS);
  return output === "" ? "" : `\n${output}`;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const resolve: WorktreeCommands["Service"]["resolve"] = Effect.fn("WorktreeCommands.resolve")(
    function* (projectCwd) {
      const fail = (cause: unknown) =>
        new GitCommandError({
          operation: "WorktreeCommands.resolve",
          command: "worktree commands",
          cwd: projectCwd,
          detail: "Could not read the worktree command settings for this project.",
          cause,
        });
      const settings = yield* settingsService.getSettings.pipe(Effect.mapError(fail));
      const project = yield* projects
        .getByWorkspaceRoot(projectCwd)
        .pipe(Effect.map(Option.getOrNull), Effect.mapError(fail));
      return resolveProjectSettings(settings, project?.id ?? null, project).settings
        .worktreeCommands;
    },
  );

  const run: WorktreeCommands["Service"]["run"] = Effect.fn("WorktreeCommands.run")(
    function* (input) {
      const invocation = shellInvocation(
        yield* HostProcessPlatform,
        yield* HostProcessEnvironment,
        input.command,
      );
      const result = yield* processRunner
        .run({
          ...invocation,
          cwd: input.projectCwd,
          env: input.env,
          timeout: COMMAND_TIMEOUT,
          maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: input.operation,
                command: input.command,
                cwd: input.projectCwd,
                detail: `The custom worktree command could not run: ${cause.message}`,
                cause,
              }),
          ),
        );
      if (result.code !== 0) {
        // The user wrote this command, so its own output is the useful diagnostic.
        return yield* new GitCommandError({
          operation: input.operation,
          command: input.command,
          cwd: input.projectCwd,
          detail: `The custom worktree command exited with code ${result.code}.${outputTail(result.stdout, result.stderr)}`,
        });
      }
      return result.stdout;
    },
  );

  return WorktreeCommands.of({ resolve, run });
});

export const layer = Layer.effect(WorktreeCommands, make).pipe(Layer.provide(ProcessRunner.layer));
