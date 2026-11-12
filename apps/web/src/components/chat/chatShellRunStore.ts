import { create } from "zustand";

import {
  EMPTY_TERMINAL_SESSION_STATE,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";

import { subscribeAtomChanges } from "../../rpc/atomRegistry";
import { attachedTerminalSessionAtom } from "../../state/terminalSessions";
import {
  parseChatShellRunOutput,
  type ChatShellRun,
  type ChatShellRunOutput,
} from "./chatShellRun";

/** What a finished run's block shows once its terminal, or that terminal's history, is gone. */
export interface ChatShellRunResult {
  readonly text: string;
  readonly status: string;
}

interface ChatShellRunStore {
  readonly runs: Readonly<Record<string, ChatShellRun>>;
  /** Keyed by run id. */
  readonly results: Readonly<Record<string, ChatShellRunResult>>;
  readonly setRun: (key: string, run: ChatShellRun) => void;
}

/** Outlives the code block, which the virtualized timeline unmounts when it scrolls away. */
export const useChatShellRunStore = create<ChatShellRunStore>((set) => ({
  runs: {},
  results: {},
  setRun: (key, run) => set((state) => ({ runs: { ...state.runs, [key]: run } })),
}));

const finishedRunIds = new Set<string>();

/** A finished run's terminal sits idle at a prompt, so running the block again can reuse it. */
export function isChatShellRunFinished(run: ChatShellRun): boolean {
  return finishedRunIds.has(run.id);
}

/**
 * Follows the run's terminal without bringing it back: `resume` leaves a terminal the user
 * closed closed, so a block remounting after that does not respawn the shell.
 */
export function chatShellRunSessionAtom(run: ChatShellRun) {
  return attachedTerminalSessionAtom(run.environmentId, {
    threadId: run.threadId,
    terminalId: run.terminalId,
    cwd: run.cwd,
    worktreePath: run.worktreePath,
    resume: true,
  });
}

export function chatShellRunStatus(
  output: ChatShellRunOutput,
  session: Pick<TerminalSessionState, "status" | "version" | "summary">,
): string {
  if (output.error !== undefined) return `Couldn't read output: ${output.error}`;
  if (output.exitCode !== null) return `Exited with code ${output.exitCode}`;
  if (session.status === "exited") {
    const shellExitCode = session.summary?.exitCode ?? null;
    return shellExitCode === null
      ? "Ended without an exit status"
      : `Shell exited with code ${shellExitCode}`;
  }
  // A session that has not attached yet also reports "closed", at version 0.
  if (session.status === "closed" && session.version > 0) return "Terminal closed";
  return "Running…";
}

const launchFailureHandlers = new Map<string, (error: string) => void>();

/** Finishes a watched run whose terminal could not be opened or written to. */
export function failChatShellRunLaunch(runId: string, error: string): void {
  launchFailureHandlers.get(runId)?.(error);
}

export function watchChatShellRun(
  run: ChatShellRun,
  onFinished: (output: ChatShellRunOutput) => void,
): void {
  const finish = (output: ChatShellRunOutput, session: TerminalSessionState) => {
    unsubscribe();
    launchFailureHandlers.delete(run.id);
    useChatShellRunStore.setState((state) => ({
      results: {
        ...state.results,
        [run.id]: { text: output.text, status: chatShellRunStatus(output, session) },
      },
    }));
    // A failed terminal is not idle at a prompt, so it stays out of the reuse set.
    if (output.error === undefined) finishedRunIds.add(run.id);
    onFinished(output);
  };
  const unsubscribe = subscribeAtomChanges(chatShellRunSessionAtom(run), (session) => {
    const parsed = parseChatShellRunOutput(
      session.output.chunks.map((chunk) => chunk.data).join(""),
      run.id,
    );
    // A shell that exited without printing the end marker is finished too, so the block stops at "Running…".
    const ended =
      session.status === "exited" || (session.status === "closed" && session.version > 0);
    if (parsed.exitCode === null && !ended && session.error === null) return;
    const failed = parsed.exitCode === null && session.error !== null;
    finish(failed ? { ...parsed, error: String(session.error) } : parsed, session);
  });
  launchFailureHandlers.set(run.id, (error) =>
    finish({ text: "", exitCode: null, error }, EMPTY_TERMINAL_SESSION_STATE),
  );
}
