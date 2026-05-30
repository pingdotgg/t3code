import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_KNOWN_TERMINAL_SESSIONS_ATOM,
  EMPTY_TERMINAL_ID_LIST_ATOM,
  EMPTY_TERMINAL_SESSION_ATOM,
  createTerminalSessionManager,
  getKnownTerminalSessionTarget,
  getKnownTerminalSessionListFilter,
  knownTerminalSessionsAtom,
  runningTerminalIdsAtom,
  terminalSessionStateAtom,
  type KnownTerminalSession,
  type TerminalSessionTarget,
  type TerminalSessionState,
} from "@t3tools/client-runtime";
import type {
  EnvironmentId,
  TerminalAttachInput,
  TerminalSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";

import { appAtomRegistry } from "./rpc/atomRegistry";

export const terminalSessionManager = createTerminalSessionManager({
  getRegistry: () => appAtomRegistry,
});

export function subscribeTerminalMetadata(input: {
  readonly environmentId: EnvironmentId;
  readonly client: Parameters<typeof terminalSessionManager.subscribeMetadata>[0]["client"];
}) {
  return terminalSessionManager.subscribeMetadata(input);
}

export function attachTerminalSession(input: {
  readonly environmentId: EnvironmentId;
  readonly client: Parameters<typeof terminalSessionManager.attach>[0]["client"];
  readonly terminal: TerminalAttachInput;
  readonly onSnapshot?: (snapshot: TerminalSessionSnapshot) => void;
  readonly onEvent?: Parameters<typeof terminalSessionManager.attach>[0]["onEvent"];
}) {
  return terminalSessionManager.attach({
    environmentId: input.environmentId,
    client: input.client,
    terminal: input.terminal,
    ...(input.onSnapshot ? { onSnapshot: input.onSnapshot } : {}),
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
  });
}

export function useTerminalSession(input: TerminalSessionTarget): TerminalSessionState {
  const target = getKnownTerminalSessionTarget(input);
  return useAtomValue(
    target !== null ? terminalSessionStateAtom(target) : EMPTY_TERMINAL_SESSION_ATOM,
  );
}

export function useKnownTerminalSessions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<KnownTerminalSession> {
  const filter = getKnownTerminalSessionListFilter(input);
  return useAtomValue(
    filter !== null ? knownTerminalSessionsAtom(filter) : EMPTY_KNOWN_TERMINAL_SESSIONS_ATOM,
  );
}

export function useThreadRunningTerminalIds(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<string> {
  const filter = getKnownTerminalSessionListFilter(input);
  return useAtomValue(
    filter !== null ? runningTerminalIdsAtom(filter) : EMPTY_TERMINAL_ID_LIST_ATOM,
  );
}
