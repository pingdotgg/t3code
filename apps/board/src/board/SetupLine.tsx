import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { vcsEnvironment } from "../state/vcs";
import { type SetupLine, setupLine } from "../state/worktreeSetup";
import { SetupTerminal } from "./SetupTerminal";

/** T3's setup stream for an agent's thread, as the card line it renders. */
export function useSetupLine(environmentId: EnvironmentId, threadId: string): SetupLine | null {
  const result = useAtomValue(
    vcsEnvironment.worktreeSetup({ environmentId, input: { threadId: ThreadId.make(threadId) } }),
  );
  return setupLine(AsyncResult.getOrElse(result, () => null));
}

/** What T3 reported when a worktree's setup failed, hung under the agent's card. */
export function SetupFailure({
  environmentId,
  threadId,
  line,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  line: Extract<SetupLine, { kind: "failed" }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid="setup-failed"
      className="absolute top-full right-0 left-0 z-10 mt-1 flex flex-col gap-1 rounded-md border border-red-400/40 bg-panel p-2 shadow-panel"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {line.error !== null && <p className="text-[11px] break-words text-red-300">{line.error}</p>}
      {line.tail.length > 0 && (
        <pre className="overflow-hidden font-mono text-[10px] leading-4 text-muted">
          {line.tail.join("\n")}
        </pre>
      )}
      {line.terminalId !== null && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="self-start rounded border border-line px-1.5 text-[11px] leading-5 text-muted hover:bg-hover hover:text-fg"
        >
          Open terminal
        </button>
      )}
      {open && line.terminalId !== null && (
        <SetupTerminal
          environmentId={environmentId}
          threadId={threadId}
          terminalId={line.terminalId}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
