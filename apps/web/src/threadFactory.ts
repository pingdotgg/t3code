import { DEFAULT_MODEL } from "./model-logic";
import { DEFAULT_THREAD_TERMINAL_HEIGHT, DEFAULT_THREAD_TERMINAL_ID, type Thread } from "./types";

interface CreateThreadOptions {
  branch?: string | null;
  createdAt?: string;
  model?: string;
  title?: string;
  worktreePath?: string | null;
}

export function createThread(projectId: string, options: CreateThreadOptions = {}): Thread {
  const createdAt = options.createdAt ?? new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    codexThreadId: null,
    projectId,
    title: options.title ?? "New thread",
    model: options.model ?? DEFAULT_MODEL,
    terminalOpen: false,
    terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    runningTerminalIds: [],
    activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
    terminalGroups: [
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ],
    activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
    session: null,
    messages: [],
    events: [],
    turnDiffSummaries: [],
    error: null,
    createdAt,
    branch: options.branch ?? null,
    worktreePath: options.worktreePath ?? null,
  };
}
