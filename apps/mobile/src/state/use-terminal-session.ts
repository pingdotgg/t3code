import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  EMPTY_TERMINAL_SESSION_STATE,
  terminalOutputText,
  type KnownTerminalSession,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import { ThreadId, type EnvironmentId, type TerminalAttachInput } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "./query";
import { terminalEnvironment } from "./terminal";

type LegacyTerminalSessionState = TerminalSessionState & { readonly buffer: string };
const EMPTY_LEGACY_TERMINAL_SESSION_STATE: LegacyTerminalSessionState = {
  ...EMPTY_TERMINAL_SESSION_STATE,
  buffer: "",
};

export function useAttachedTerminalSession(input: {
  readonly environmentId: EnvironmentId | null;
  readonly terminal: TerminalAttachInput | null;
}): LegacyTerminalSessionState {
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
  const output = attach.data?.output ?? EMPTY_TERMINAL_BUFFER_STATE.output;
  // Installed native binaries still accept initialBuffer. Keep materialization
  // at this mobile boundary until the native streaming API is released.
  const buffer = useMemo(() => terminalOutputText(output), [output]);

  return useMemo(() => {
    if (input.environmentId === null || input.terminal === null) {
      return EMPTY_LEGACY_TERMINAL_SESSION_STATE;
    }
    const summary =
      metadata.data?.find(
        (terminal) =>
          terminal.threadId === input.terminal?.threadId &&
          terminal.terminalId === input.terminal?.terminalId,
      ) ?? null;
    const state = {
      ...combineTerminalSessionState(summary, attach.data ?? EMPTY_TERMINAL_BUFFER_STATE),
      buffer,
    };
    return attach.error === null ? state : { ...state, error: attach.error, status: "error" };
  }, [attach.data, attach.error, buffer, input.environmentId, input.terminal, metadata.data]);
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
      return [];
    }
    return (metadata.data ?? [])
      .filter((summary) => input.threadId === null || summary.threadId === input.threadId)
      .map((summary) => ({
        target: {
          environmentId: input.environmentId!,
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
  }, [input.environmentId, input.threadId, metadata.data]);
}
