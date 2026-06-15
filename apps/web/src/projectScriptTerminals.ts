import type {
  EnvironmentApi,
  ProjectScript,
  TerminalAttachStreamEvent,
  TerminalOpenInput,
} from "@t3tools/contracts";

const ACTION_TERMINAL_ID_PREFIX = "action-";
const ACTION_TERMINAL_READY_TIMEOUT_MS = 4_000;
const MAX_TERMINAL_BUFFER_TAIL = 2_000;
const PROMPT_LINE_MAX_LENGTH = 180;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const BELL_CHARACTER = String.fromCharCode(7);

function projectActionTerminalIdBase(scriptId: ProjectScript["id"]): string {
  return `${ACTION_TERMINAL_ID_PREFIX}${scriptId}`;
}

export function isProjectActionTerminalId(terminalId: string): boolean {
  return terminalId.startsWith(ACTION_TERMINAL_ID_PREFIX);
}

export function projectActionTerminalId(scriptId: ProjectScript["id"], suffix?: number): string {
  const base = projectActionTerminalIdBase(scriptId);
  return suffix === undefined ? base : `${base}-${suffix}`;
}

export function resolveProjectActionTerminalId(input: {
  readonly scriptId: ProjectScript["id"];
  readonly terminalIds: ReadonlyArray<string>;
  readonly runningTerminalIds: ReadonlyArray<string>;
}): string {
  const busyTerminalIds = new Set(input.runningTerminalIds);
  const baseTerminalId = projectActionTerminalId(input.scriptId);
  if (!busyTerminalIds.has(baseTerminalId)) {
    return baseTerminalId;
  }

  const basePrefix = `${baseTerminalId}-`;
  const idleActionTerminal = input.terminalIds.find(
    (terminalId) =>
      (terminalId === baseTerminalId || terminalId.startsWith(basePrefix)) &&
      !busyTerminalIds.has(terminalId),
  );
  if (idleActionTerminal) {
    return idleActionTerminal;
  }

  const takenTerminalIds = new Set(input.terminalIds);
  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = projectActionTerminalId(input.scriptId, suffix);
    if (!takenTerminalIds.has(candidate)) {
      return candidate;
    }
    suffix += 1;
  }

  return projectActionTerminalId(input.scriptId, Date.now());
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

export function terminalOutputLooksReadyForInput(value: string): boolean {
  const tail = stripAnsi(value).slice(-MAX_TERMINAL_BUFFER_TAIL).replaceAll(BELL_CHARACTER, "");
  const lines = tail.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.replace(/\r/g, "") ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    if (line.length > PROMPT_LINE_MAX_LENGTH) {
      return false;
    }
    return /[$#%>]\s*$/.test(line);
  }
  return false;
}

function terminalAttachInputFromOpenInput(input: TerminalOpenInput) {
  return {
    threadId: input.threadId,
    terminalId: input.terminalId,
    cwd: input.cwd,
    ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
    ...(input.cols !== undefined ? { cols: input.cols } : {}),
    ...(input.rows !== undefined ? { rows: input.rows } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
  };
}

export async function openTerminalAndWaitForInputReady(
  api: Pick<EnvironmentApi, "terminal">,
  input: TerminalOpenInput,
  timeoutMs = ACTION_TERMINAL_READY_TIMEOUT_MS,
): Promise<void> {
  let bufferTail = "";
  let unsubscribe: (() => void) | undefined;
  let shouldUnsubscribe = false;

  await new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(settle, timeoutMs);

    function cleanup() {
      if (unsubscribe) {
        const dispose = unsubscribe;
        unsubscribe = undefined;
        dispose();
      } else {
        shouldUnsubscribe = true;
      }
    }

    function settle() {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve();
    }

    function appendAndCheck(data: string) {
      bufferTail = `${bufferTail}${data}`.slice(-MAX_TERMINAL_BUFFER_TAIL);
      if (terminalOutputLooksReadyForInput(bufferTail)) {
        settle();
      }
    }

    function onEvent(event: TerminalAttachStreamEvent) {
      if (event.type === "snapshot") {
        appendAndCheck(event.snapshot.history);
        return;
      }
      if (event.type === "output") {
        appendAndCheck(event.data);
        return;
      }
      if (event.type === "closed" || event.type === "error" || event.type === "exited") {
        settle();
      }
    }

    try {
      unsubscribe = api.terminal.attach(terminalAttachInputFromOpenInput(input), onEvent);
      if (shouldUnsubscribe) {
        cleanup();
      }
    } catch {
      void api.terminal.open(input).finally(settle);
    }
  });
}
