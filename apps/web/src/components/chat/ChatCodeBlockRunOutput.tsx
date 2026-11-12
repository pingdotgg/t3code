import { useAtomMount, useAtomValue } from "@effect/atom-react";

import { parseChatShellRunOutput, type ChatShellRun } from "./chatShellRun";
import {
  chatShellRunSessionAtom,
  chatShellRunStatus,
  useChatShellRunStore,
  type ChatShellRunResult,
} from "./chatShellRunStore";

/**
 * The run's output as text. The command runs in the bottom drawer's terminal, so this block
 * shows what that terminal printed without drawing a second copy of the session. A finished
 * run shows its kept result, which stays after that terminal or its history is gone.
 */
export function ChatCodeBlockRunOutput({ run }: { readonly run: ChatShellRun }) {
  const result = useChatShellRunStore((state) => state.results[run.id]);
  return result ? <RunOutputView result={result} /> : <LiveRunOutput run={run} />;
}

function LiveRunOutput({ run }: { readonly run: ChatShellRun }) {
  const sessionAtom = chatShellRunSessionAtom(run);
  useAtomMount(sessionAtom);
  const session = useAtomValue(sessionAtom);
  const output = parseChatShellRunOutput(
    session.output.chunks.map((chunk) => chunk.data).join(""),
    run.id,
  );
  const status = chatShellRunStatus(
    session.error === null ? output : { ...output, error: session.error },
    session,
  );
  return <RunOutputView result={{ text: output.text, status }} />;
}

function RunOutputView({ result }: { readonly result: ChatShellRunResult }) {
  return (
    <div
      data-thread-find-ignore=""
      className="my-[0.65rem] overflow-hidden rounded-lg border border-border/70 bg-secondary font-mono text-2xs leading-snug dark:border-transparent dark:bg-input/32"
    >
      <div className="px-3 py-1.5 text-muted-foreground select-none">{result.status}</div>
      {result.text.length > 0 ? (
        <pre className="max-h-56 overflow-auto px-3 pb-2 whitespace-pre-wrap">{result.text}</pre>
      ) : null}
    </div>
  );
}
