import { useAtomValue } from "@effect/atom-react";
import {
  createTerminalEnvironmentAtoms,
  terminalOutputText,
} from "@t3tools/client-runtime/state/terminal";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { createPortal } from "react-dom";

import { connectionAtomRuntime } from "../connection/runtime";

const terminalEnvironment = createTerminalEnvironmentAtoms(connectionAtomRuntime);

const ESCAPE_SEQUENCES = new RegExp(
  String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][0-2AB])|\r`,
  "g",
);

/** A worktree setup script's terminal, read only, as T3 holds it. */
export function SetupTerminal({
  environmentId,
  threadId,
  terminalId,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  terminalId: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    terminalEnvironment.observe({
      environmentId,
      input: { threadId: ThreadId.make(threadId), terminalId },
    }),
  );
  const buffer = AsyncResult.getOrElse(result, () => null);
  return createPortal(
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-black/50"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Setup script terminal"
        className="flex max-h-[80vh] w-[640px] max-w-[92vw] flex-col gap-3 rounded-xl border border-line bg-panel p-4 shadow-panel"
      >
        <pre
          data-testid="setup-terminal"
          className="min-h-24 overflow-auto font-mono text-[11px] leading-5 whitespace-pre-wrap text-fg"
        >
          {buffer === null
            ? "Connecting to the terminal"
            : terminalOutputText(buffer.output).replace(ESCAPE_SEQUENCES, "")}
        </pre>
        {buffer?.error != null && <p className="text-[11px] text-red-300">{buffer.error}</p>}
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="self-end rounded border border-line px-2 py-0.5 text-muted hover:bg-hover hover:text-fg"
        >
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}
