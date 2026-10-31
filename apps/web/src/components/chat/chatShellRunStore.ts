import { create } from "zustand";

import { subscribeAtomChanges } from "../../rpc/atomRegistry";
import { attachedTerminalSessionAtom } from "../../state/terminalSessions";
import {
  parseChatShellRunOutput,
  type ChatShellRun,
  type ChatShellRunOutput,
} from "./chatShellRun";

interface ChatShellRunStore {
  readonly runs: Readonly<Record<string, ChatShellRun>>;
  readonly setRun: (key: string, run: ChatShellRun) => void;
}

/** Outlives the code block, which the virtualized timeline unmounts when it scrolls away. */
export const useChatShellRunStore = create<ChatShellRunStore>((set) => ({
  runs: {},
  setRun: (key, run) => set((state) => ({ runs: { ...state.runs, [key]: run } })),
}));

const finishedRunIds = new Set<string>();

/** A finished run's terminal sits idle at a prompt, so running the block again can reuse it. */
export function isChatShellRunFinished(run: ChatShellRun): boolean {
  return finishedRunIds.has(run.id);
}

export function chatShellRunSessionAtom(run: ChatShellRun) {
  return attachedTerminalSessionAtom(run.environmentId, {
    threadId: run.threadId,
    terminalId: run.terminalId,
    cwd: run.cwd,
    worktreePath: run.worktreePath,
  });
}

export function watchChatShellRun(
  run: ChatShellRun,
  onFinished: (output: ChatShellRunOutput) => void,
): void {
  const unsubscribe = subscribeAtomChanges(chatShellRunSessionAtom(run), (session) => {
    const output = parseChatShellRunOutput(
      session.output.chunks.map((chunk) => chunk.data).join(""),
      run.id,
    );
    if (output.exitCode === null && session.status !== "closed" && session.error === null) return;
    unsubscribe();
    if (output.exitCode === null) return;
    finishedRunIds.add(run.id);
    onFinished(output);
  });
}
