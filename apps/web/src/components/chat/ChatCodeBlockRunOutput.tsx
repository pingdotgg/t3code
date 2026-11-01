import { useAtomMount, useAtomValue } from "@effect/atom-react";

import { parseChatShellRunOutput, type ChatShellRun } from "./chatShellRun";
import { chatShellRunSessionAtom } from "./chatShellRunStore";

/**
 * The run's output as text. The command runs in the bottom drawer's terminal, so this block
 * shows what that terminal printed without drawing a second copy of the session.
 */
export function ChatCodeBlockRunOutput({ run }: { readonly run: ChatShellRun }) {
  const sessionAtom = chatShellRunSessionAtom(run);
  useAtomMount(sessionAtom);
  const session = useAtomValue(sessionAtom);
  const { text, exitCode } = parseChatShellRunOutput(
    session.output.chunks.map((chunk) => chunk.data).join(""),
    run.id,
  );

  const status =
    session.error !== null
      ? `Couldn't read output: ${session.error}`
      : exitCode !== null
        ? `Exited with code ${exitCode}`
        : session.status === "exited"
          ? "Ended without an exit status"
          : session.status === "closed"
            ? "Terminal closed"
            : "Running…";

  return (
    <div
      data-thread-find-ignore=""
      className="my-[0.65rem] overflow-hidden rounded-lg border border-border/70 bg-secondary font-mono text-2xs leading-snug dark:border-transparent dark:bg-input/32"
    >
      <div className="px-3 py-1.5 text-muted-foreground select-none">{status}</div>
      {text.length > 0 ? (
        <pre className="max-h-56 overflow-auto px-3 pb-2 whitespace-pre-wrap">{text}</pre>
      ) : null}
    </div>
  );
}
