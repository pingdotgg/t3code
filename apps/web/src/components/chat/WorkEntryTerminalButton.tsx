import { useAtomValue } from "@effect/atom-react";
import { terminalSessionStateAtom } from "@t3tools/client-runtime";
import { extractCommandOutputText } from "@t3tools/client-runtime/work-log/presentation";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { TerminalIcon } from "lucide-react";
import { memo } from "react";

import type { WorkLogEntry } from "../../session-logic";
import { terminalSessionManager } from "../../terminalSessionState";
import { useTerminalStateStore } from "../../terminalStateStore";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function workEntryTerminalId(entry: WorkLogEntry): string | null {
  const data = record(entry.toolData);
  const name =
    data?.toolName ?? data?.copilotToolName ?? data?.tool ?? entry.toolTitle ?? entry.label;
  if (typeof name !== "string" || !/(?:^|[._])terminal_(?:start|read)$/.test(name)) return null;
  if (entry.tone === "error" || entry.toolLifecycleStatus === "failed") return null;
  const input = record(data?.rawInput) ?? record(data?.input);
  let output = record(data?.rawOutput);
  if (!output?.terminalId) {
    const text = extractCommandOutputText(entry.toolData);
    if (text) {
      try {
        output = record(JSON.parse(text));
      } catch {
        // Output is untrusted provider data; truncated/non-JSON results cannot link a terminal.
      }
    }
  }
  const id = output?.terminalId ?? input?.terminalId;
  return typeof id === "string" && /^agent-[a-z0-9-]{1,100}$/.test(id) ? id : null;
}

/** Resolve only explicit IDs, never command text or another thread's terminal. */
export const WorkEntryTerminalButton = memo(function WorkEntryTerminalButton({
  entry,
  threadRef,
}: {
  entry: WorkLogEntry;
  threadRef: ScopedThreadRef;
}) {
  const terminalId = workEntryTerminalId(entry);
  return terminalId ? <LiveTerminalButton threadRef={threadRef} terminalId={terminalId} /> : null;
});

function LiveTerminalButton({
  threadRef,
  terminalId,
}: {
  threadRef: ScopedThreadRef;
  terminalId: string;
}) {
  const target = { ...threadRef, terminalId };
  const state = useAtomValue(terminalSessionStateAtom(target));
  if (state.summary?.status !== "running") return null;
  const label = state.summary?.label || terminalId;
  return (
    <button
      type="button"
      aria-label={`Open running terminal: ${label}`}
      title={`Open running terminal: ${label}`}
      className="chat-work-terminal shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={() => {
        const current = terminalSessionManager.getSnapshot(target);
        if (current.summary?.status !== "running") return;
        useTerminalStateStore
          .getState()
          .ensureTerminal(threadRef, terminalId, { open: true, active: true });
      }}
    >
      <TerminalIcon className="size-[1em]" aria-hidden="true" />
    </button>
  );
}
