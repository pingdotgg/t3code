import {
  PROJECT_SCRIPT_MCP_DEFAULT_LIST_LIMIT,
  PROJECT_SCRIPT_MCP_DEFAULT_PREVIEW_CHARS,
  type ProjectScript,
  ProjectScriptMcpFailure,
  type ProjectScriptMcpListInput,
  type ProjectScriptMcpListResult,
  type ProjectScriptMcpRunInput,
  type ProjectScriptMcpRunResult,
  type ProjectScriptMcpStopInput,
  type ProjectScriptMcpStopResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { TerminalMcpService } from "./TerminalMcpService.ts";
import * as TerminalManager from "../terminal/Manager.ts";

const MAX_SCRIPT_INPUT_CHARS = 65_535;

interface ScriptRunOwnership {
  readonly projectId: string;
  readonly scriptId: string;
  readonly handle: TerminalManager.TerminalSessionHandle;
}

type ScriptRuns = Map<ThreadId, Map<string, ScriptRunOwnership>>;

export class ProjectScriptMcpService extends Context.Service<
  ProjectScriptMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: ProjectScriptMcpListInput,
    ) => Effect.Effect<ProjectScriptMcpListResult, ProjectScriptMcpFailure>;
    readonly run: (
      scope: McpInvocationScope,
      input: ProjectScriptMcpRunInput,
    ) => Effect.Effect<ProjectScriptMcpRunResult, ProjectScriptMcpFailure>;
    readonly stop: (
      scope: McpInvocationScope,
      input: ProjectScriptMcpStopInput,
    ) => Effect.Effect<ProjectScriptMcpStopResult, ProjectScriptMcpFailure>;
  }
>()("t3/mcp/ProjectScriptMcpService") {}

function scriptForId(scripts: ReadonlyArray<ProjectScript>, scriptId: string) {
  return scripts.find((candidate) => candidate.id === scriptId);
}

function preview(script: ProjectScript, maxChars: number) {
  const characters = Array.from(script.command);
  return {
    scriptId: script.id,
    name: script.name,
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
    previewUrl: script.previewUrl ?? null,
    autoOpenPreview: script.autoOpenPreview ?? false,
    commandPreview: characters.slice(0, maxChars).join(""),
    commandCharacters: characters.length,
    commandTruncated: characters.length > maxChars,
  } as const;
}

export const make = Effect.gen(function* () {
  const terminals = yield* TerminalMcpService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const runs: ScriptRuns = new Map();

  const recordRun = (threadId: ThreadId, terminalId: string, ownership: ScriptRunOwnership) => {
    const forThread = runs.get(threadId) ?? new Map();
    forThread.set(terminalId, ownership);
    runs.set(threadId, forThread);
  };

  const removeRun = (
    threadId: ThreadId,
    terminalId: string,
    handle: TerminalManager.TerminalSessionHandle,
  ) => {
    const forThread = runs.get(threadId);
    if (forThread?.get(terminalId)?.handle.incarnation !== handle.incarnation) return;
    forThread.delete(terminalId);
    if (forThread.size === 0) runs.delete(threadId);
  };

  const load = Effect.fn("ProjectScriptMcpService.load")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId | undefined,
  ) {
    return yield* terminals
      .resolveTarget(scope, threadId)
      .pipe(
        Effect.mapError(
          (error) => new ProjectScriptMcpFailure({ code: error.code, message: error.message }),
        ),
      );
  });

  const unsubscribe = yield* terminalManager.subscribeSessionInvalidation((handle) =>
    Effect.sync(() => removeRun(ThreadId.make(handle.threadId), handle.terminalId, handle)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  return ProjectScriptMcpService.of({
    list: (scope, input) =>
      Effect.gen(function* () {
        const resolved = yield* load(scope, input.threadId);
        const cursor = input.cursor ?? 0;
        const limit = input.limit ?? PROJECT_SCRIPT_MCP_DEFAULT_LIST_LIMIT;
        const maxChars = input.commandPreviewChars ?? PROJECT_SCRIPT_MCP_DEFAULT_PREVIEW_CHARS;
        const page = resolved.project.scripts.slice(cursor, cursor + limit);
        return {
          threadId: resolved.target.thread.id,
          projectId: resolved.project.id,
          scripts: page.map((script) => preview(script, maxChars)),
          nextCursor:
            cursor + page.length < resolved.project.scripts.length ? cursor + page.length : null,
          total: resolved.project.scripts.length,
        };
      }),
    run: (scope, input) =>
      Effect.gen(function* () {
        const resolved = yield* load(scope, input.threadId);
        const script = scriptForId(resolved.project.scripts, input.scriptId);
        if (script === undefined) {
          return yield* new ProjectScriptMcpFailure({
            code: "script_not_found",
            message: `Saved script '${input.scriptId}' was not found in project '${resolved.project.id}'.`,
          });
        }
        if (script.command.length > MAX_SCRIPT_INPUT_CHARS) {
          return yield* new ProjectScriptMcpFailure({
            code: "script_command_too_large",
            message: `Saved script '${script.id}' exceeds the managed terminal input limit.`,
          });
        }

        const opened = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const opened = yield* terminals
              .openFreshOwned(scope, {
                threadId: resolved.target.thread.id,
                terminalId: input.terminalId,
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new ProjectScriptMcpFailure({ code: error.code, message: error.message }),
                ),
              );
            const ownership = {
              projectId: resolved.project.id,
              scriptId: script.id,
              handle: opened.handle,
            } satisfies ScriptRunOwnership;
            const admitted = yield* terminalManager.admitRunningSessionHandle(
              {
                threadId: resolved.target.thread.id,
                terminalId: input.terminalId,
                handle: opened.handle,
              },
              () => recordRun(resolved.target.thread.id, input.terminalId, ownership),
            );
            if (!admitted) {
              return yield* new ProjectScriptMcpFailure({
                code: "terminal_not_found",
                message: `Terminal '${input.terminalId}' changed before script ownership could be recorded.`,
              });
            }
            return opened;
          }),
        );

        const write = yield* Effect.result(
          terminals.writeOwned(scope, {
            threadId: resolved.target.thread.id,
            terminalId: input.terminalId,
            data: `${script.command}\r`,
            handle: opened.handle,
          }),
        );
        return Result.match(write, {
          onFailure: (error) => ({
            threadId: resolved.target.thread.id,
            projectId: resolved.project.id,
            scriptId: script.id,
            terminalId: input.terminalId,
            outcome: "terminal_opened_input_failed" as const,
            terminal: opened.terminal,
            inputAcceptance: null,
            error: error.message,
            previewUrl: script.previewUrl ?? null,
            previewAutoOpened: false as const,
          }),
          onSuccess: (inputAcceptance) => ({
            threadId: resolved.target.thread.id,
            projectId: resolved.project.id,
            scriptId: script.id,
            terminalId: input.terminalId,
            outcome: "input_accepted" as const,
            terminal: opened.terminal,
            inputAcceptance,
            error: null,
            previewUrl: script.previewUrl ?? null,
            previewAutoOpened: false as const,
          }),
        });
      }),
    stop: (scope, input) =>
      Effect.gen(function* () {
        const resolved = yield* load(scope, input.threadId);
        const ownership = runs.get(resolved.target.thread.id)?.get(input.terminalId);
        if (
          ownership === undefined ||
          ownership.projectId !== resolved.project.id ||
          ownership.scriptId !== input.scriptId
        ) {
          return yield* new ProjectScriptMcpFailure({
            code: "script_run_not_found",
            message: `Terminal '${input.terminalId}' is not a managed run of saved script '${input.scriptId}' for thread '${resolved.target.thread.id}'.`,
          });
        }
        const closed = yield* terminals
          .closeOwned(scope, {
            threadId: resolved.target.thread.id,
            terminalId: input.terminalId,
            handle: ownership.handle,
          })
          .pipe(
            Effect.mapError(
              (error) => new ProjectScriptMcpFailure({ code: error.code, message: error.message }),
            ),
          );
        if (!closed) {
          removeRun(resolved.target.thread.id, input.terminalId, ownership.handle);
          return yield* new ProjectScriptMcpFailure({
            code: "script_run_not_found",
            message: `Terminal '${input.terminalId}' no longer names the managed run of saved script '${input.scriptId}'.`,
          });
        }
        removeRun(resolved.target.thread.id, input.terminalId, ownership.handle);
        return {
          threadId: resolved.target.thread.id,
          projectId: resolved.project.id,
          scriptId: input.scriptId,
          terminalId: input.terminalId,
          stopped: true,
        };
      }),
  });
});

export const layer = Layer.effect(ProjectScriptMcpService, make);
