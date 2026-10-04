import {
  OrchestratorMcpFailure,
  type TerminalAttachInput,
  type TerminalError,
  type TerminalSessionSnapshot,
  type TerminalSummary,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeUtil from "node:util";
import * as Project from "../../../project/ProjectService.ts";
import * as TerminalManager from "../../../terminal/Manager.ts";
import {
  readFullAccessCaller,
  readThread,
  readWritableThread,
  unavailable,
} from "../../threadAccess.ts";
import { TerminalToolkit } from "./tools.ts";

const DEFAULT_OUTPUT_CHARACTERS = 10_000;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const terminalFailure = (error: TerminalError) => {
  switch (error._tag) {
    case "TerminalSessionLookupError":
      return invalid(`Terminal ${error.terminalId} was not found on this thread.`);
    case "TerminalNotRunningError":
      return invalid(`Terminal ${error.terminalId} is not running; open it first.`);
    case "TerminalCwdNotFoundError":
    case "TerminalCwdNotDirectoryError":
      return invalid("The thread's checkout folder does not exist.");
    default:
      return unavailable();
  }
};

/** The thread's terminals from the metadata snapshot the terminal panel starts from. */
const listTerminals = Effect.fn("mcp.terminal.list")(function* (threadId: string) {
  const terminals = yield* TerminalManager.TerminalManager;
  const captured: { all: ReadonlyArray<TerminalSummary> } = { all: [] };
  const detach = yield* terminals.subscribeMetadata((event) =>
    Effect.sync(() => {
      if (event.type === "snapshot") captured.all = event.terminals;
    }),
  );
  detach();
  return captured.all.filter((terminal) => terminal.threadId === threadId);
});

const findTerminal = Effect.fn("mcp.terminal.find")(function* (
  threadId: string,
  terminalId: string,
) {
  const terminal = (yield* listTerminals(threadId)).find(
    (candidate) => candidate.terminalId === terminalId,
  );
  if (terminal === undefined)
    return yield* invalid(`Terminal ${terminalId} was not found on this thread.`);
  return terminal;
});

/**
 * Attach like a client and detach after the initial snapshot. Without a cwd an
 * attach never starts a shell, and with restartIfNotRunning it reuses a running
 * shell as is instead of restarting it for a different launch context.
 */
const attachSnapshot = Effect.fn("mcp.terminal.attach")(function* (input: TerminalAttachInput) {
  const terminals = yield* TerminalManager.TerminalManager;
  const captured: { snapshot?: TerminalSessionSnapshot } = {};
  const detach = yield* terminals
    .attachStream(input, (event) =>
      Effect.sync(() => {
        if (event.type === "snapshot") captured.snapshot ??= event.snapshot;
      }),
    )
    .pipe(Effect.mapError(terminalFailure));
  detach();
  // attachStream delivers the snapshot before it returns.
  if (captured.snapshot === undefined) return yield* unavailable();
  return captured.snapshot;
});

/** Terminal scrollback as plain text: escape sequences out, redrawn lines keep their last write. */
function plainText(history: string) {
  return (
    NodeUtil.stripVTControlCharacters(history)
      .split(/\r*\n/)
      .map((line) => {
        const trimmed = line.replace(/\r+$/, "");
        return trimmed.slice(trimmed.lastIndexOf("\r") + 1);
      })
      .join("\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
  );
}

export const TerminalToolkitHandlersLive = TerminalToolkit.toLayer({
  t3_terminal_list: (input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      const terminals = yield* listTerminals(thread.id);
      return {
        threadId: thread.id,
        terminals: terminals.map((terminal) => ({
          terminalId: terminal.terminalId,
          label: terminal.label,
          status: terminal.status,
          hasRunningSubprocess: terminal.hasRunningSubprocess,
          exitCode: terminal.exitCode,
          cwd: terminal.cwd,
          updatedAt: terminal.updatedAt,
        })),
      };
    }),
  t3_terminal_read: (input) =>
    Effect.gen(function* () {
      // Scrollback can hold secrets a command printed.
      yield* readFullAccessCaller(
        "Reading terminal output requires a live full-access/default thread or a full-access client.",
      );
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      const snapshot = yield* attachSnapshot({ threadId: thread.id, terminalId: input.terminalId });
      const text = plainText(snapshot.history);
      const maxCharacters = input.maxCharacters ?? DEFAULT_OUTPUT_CHARACTERS;
      return {
        threadId: thread.id,
        terminalId: snapshot.terminalId,
        label: snapshot.label,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
        cwd: snapshot.cwd,
        output: text.length > maxCharacters ? text.slice(-maxCharacters) : text,
        truncated: text.length > maxCharacters,
      };
    }),
  t3_terminal_control: (input) =>
    Effect.gen(function* () {
      yield* readFullAccessCaller(
        "Terminal control requires a live full-access/default thread or a full-access client.",
      );
      const {
        projection: { thread },
      } = yield* readWritableThread(input.threadId);
      const terminals = yield* TerminalManager.TerminalManager;
      switch (input.action) {
        case "open": {
          const existing = yield* listTerminals(thread.id);
          const terminalId =
            input.terminalId ?? nextTerminalId(existing.map((terminal) => terminal.terminalId));
          const alreadyRunning = existing.some(
            (terminal) => terminal.terminalId === terminalId && terminal.status === "running",
          );
          const projects = yield* Project.ProjectService;
          const project = yield* projects
            .getById(thread.projectId)
            .pipe(Effect.mapError(unavailable));
          if (Option.isNone(project)) return yield* invalid("The project was not found.");
          // The same launch context the terminal panel uses for a thread.
          const workspaceRoot = project.value.workspaceRoot;
          const snapshot = yield* attachSnapshot({
            threadId: thread.id,
            terminalId,
            cwd: thread.worktreePath ?? workspaceRoot,
            worktreePath: thread.worktreePath,
            env: projectScriptRuntimeEnv({
              project: { cwd: workspaceRoot },
              worktreePath: thread.worktreePath,
            }),
            restartIfNotRunning: true,
          });
          return { threadId: thread.id, terminalId, status: snapshot.status, alreadyRunning };
        }
        case "write": {
          if (input.terminalId === undefined) return yield* invalid("write requires terminalId.");
          const data = `${input.text ?? ""}${input.enter === true ? "\r" : ""}`;
          if (data.length === 0) return yield* invalid("write requires text or enter.");
          const terminal = yield* findTerminal(thread.id, input.terminalId);
          // A write to an exited shell is dropped without an error, so check first.
          if (terminal.status !== "running")
            return yield* invalid(`Terminal ${terminal.terminalId} is not running; open it first.`);
          yield* terminals
            .write({ threadId: thread.id, terminalId: terminal.terminalId, data })
            .pipe(Effect.mapError(terminalFailure));
          return {
            threadId: thread.id,
            terminalId: terminal.terminalId,
            status: "running" as const,
          };
        }
        case "close": {
          if (input.terminalId === undefined) return yield* invalid("close requires terminalId.");
          const terminal = yield* findTerminal(thread.id, input.terminalId);
          // Matches closing a terminal in the app, which discards its scrollback.
          yield* terminals
            .close({ threadId: thread.id, terminalId: terminal.terminalId, deleteHistory: true })
            .pipe(Effect.mapError(terminalFailure));
          return {
            threadId: thread.id,
            terminalId: terminal.terminalId,
            status: "closed" as const,
          };
        }
      }
    }),
});
