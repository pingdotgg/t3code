import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  EMPTY_TERMINAL_SESSION_STATE,
  selectRunningSubprocessTerminalIds,
  type KnownTerminalSession,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import {
  ThreadId,
  type EnvironmentId,
  type TerminalAttachInput,
  type TerminalSummary,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "./query";
import { terminalEnvironment } from "./terminal";

const EMPTY_TERMINAL_SUMMARIES: ReadonlyArray<TerminalSummary> = Object.freeze([]);
const EMPTY_KNOWN_TERMINAL_SESSIONS: ReadonlyArray<KnownTerminalSession> = Object.freeze([]);
const knownTerminalSessionIndexCache = new WeakMap<
  ReadonlyArray<TerminalSummary>,
  {
    readonly environmentId: EnvironmentId;
    readonly all: ReadonlyArray<KnownTerminalSession>;
    readonly byThreadId: ReadonlyMap<string, ReadonlyArray<KnownTerminalSession>>;
  }
>();

function indexKnownTerminalSessions(
  environmentId: EnvironmentId,
  summaries: ReadonlyArray<TerminalSummary>,
) {
  const cached = knownTerminalSessionIndexCache.get(summaries);
  if (cached?.environmentId === environmentId) return cached;

  const all = summaries
    .map((summary) => ({
      target: {
        environmentId,
        threadId: ThreadId.make(summary.threadId),
        terminalId: summary.terminalId,
      },
      state: combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE),
    }))
    .sort((left, right) =>
      left.target.terminalId.localeCompare(right.target.terminalId, undefined, {
        numeric: true,
      }),
    );
  const byThreadId = new Map<string, KnownTerminalSession[]>();
  for (const session of all) {
    const existing = byThreadId.get(session.target.threadId);
    if (existing) existing.push(session);
    else byThreadId.set(session.target.threadId, [session]);
  }
  const indexed = { environmentId, all, byThreadId };
  knownTerminalSessionIndexCache.set(summaries, indexed);
  return indexed;
}

export function useAttachedTerminalSession(input: {
  readonly environmentId: EnvironmentId | null;
  readonly terminal: TerminalAttachInput | null;
}): TerminalSessionState {
  const attach = useEnvironmentQuery(
    input.environmentId !== null && input.terminal !== null
      ? terminalEnvironment.attach({
          environmentId: input.environmentId,
          input: input.terminal,
        })
      : null,
  );
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );

  return useMemo(() => {
    if (input.environmentId === null || input.terminal === null) {
      return EMPTY_TERMINAL_SESSION_STATE;
    }
    const summary =
      metadata.data?.find(
        (terminal) =>
          terminal.threadId === input.terminal?.threadId &&
          terminal.terminalId === input.terminal?.terminalId,
      ) ?? null;
    const state = combineTerminalSessionState(summary, attach.data ?? EMPTY_TERMINAL_BUFFER_STATE);
    return attach.error === null ? state : { ...state, error: attach.error, status: "error" };
  }, [attach.data, attach.error, input.environmentId, input.terminal, metadata.data]);
}

export function useKnownTerminalSessions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<KnownTerminalSession> {
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );
  return useMemo(() => {
    if (input.environmentId === null) {
      return EMPTY_KNOWN_TERMINAL_SESSIONS;
    }
    const index = indexKnownTerminalSessions(
      input.environmentId,
      metadata.data ?? EMPTY_TERMINAL_SUMMARIES,
    );
    return input.threadId === null
      ? index.all
      : (index.byThreadId.get(input.threadId) ?? EMPTY_KNOWN_TERMINAL_SESSIONS);
  }, [input.environmentId, input.threadId, metadata.data]);
}

export function useThreadRunningTerminalIds(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<string> {
  return selectRunningSubprocessTerminalIds(useKnownTerminalSessions(input));
}
