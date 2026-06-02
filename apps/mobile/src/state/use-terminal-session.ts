import { useAtomValue } from "@effect/atom-react";
import {
  createTerminalSessionManager,
  EMPTY_KNOWN_TERMINAL_SESSIONS_ATOM,
  EMPTY_TERMINAL_SESSION_ATOM,
  getKnownTerminalSessionTarget,
  getKnownTerminalSessionListFilter,
  knownTerminalSessionsAtom,
  terminalSessionStateAtom,
  type TerminalSessionTarget,
  type TerminalSessionState,
} from "@t3tools/client-runtime";
import type {
  EnvironmentId,
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";

export const terminalSessionManager = createTerminalSessionManager({
  getRegistry: () => appAtomRegistry,
});

export function subscribeTerminalMetadata(input: {
  readonly environmentId: EnvironmentId;
  readonly client: {
    readonly terminal: {
      readonly onMetadata: (
        listener: (event: TerminalMetadataStreamEvent) => void,
        options?: { readonly onResubscribe?: () => void },
      ) => () => void;
    };
  };
}) {
  return terminalSessionManager.subscribeMetadata(input);
}

export function attachTerminalSession(input: {
  readonly environmentId: EnvironmentId;
  readonly client: Parameters<typeof terminalSessionManager.attach>[0]["client"];
  readonly terminal: TerminalAttachInput;
  readonly onSnapshot?: (snapshot: TerminalSessionSnapshot) => void;
  readonly onEvent?: (event: TerminalAttachStreamEvent) => void;
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

export function useTerminalSessionTarget(input: TerminalSessionTarget) {
  return useMemo(
    () => ({
      environmentId: input.environmentId,
      threadId: input.threadId,
      terminalId: input.terminalId,
    }),
    [input.environmentId, input.threadId, input.terminalId],
  );
}

export function useKnownTerminalSessions(input: {
  readonly environmentId: TerminalSessionTarget["environmentId"];
  readonly threadId: TerminalSessionTarget["threadId"];
}) {
  const filter = getKnownTerminalSessionListFilter(input);
  return useAtomValue(
    filter !== null ? knownTerminalSessionsAtom(filter) : EMPTY_KNOWN_TERMINAL_SESSIONS_ATOM,
  );
}
