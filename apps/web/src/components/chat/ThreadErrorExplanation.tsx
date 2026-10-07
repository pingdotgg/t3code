import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { InlineButton } from "../ui/button";
import {
  copyReportDetails,
  explanationStateFromFailure,
  explanationStateFromResult,
  REPORT_DETAILS_COPIED_NOTE,
  reportDetailsText,
  type ThreadErrorExplanationState,
} from "./ThreadErrorExplanation.logic";

/**
 * The Explain action and its answer, rendered inside the error banner. One
 * click makes one request: the answer lives in this component, which the
 * banner keys by the error, so nothing refetches on reconnect, focus, or
 * remount. The pending state is static text so the banner never repaints on
 * its own.
 */
export function ThreadErrorExplanation({
  environmentId,
  threadId,
  runId,
  error,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  runId: RunId | null;
  error: string;
}) {
  const [state, setState] = useState<ThreadErrorExplanationState>({ kind: "idle" });
  const explainProviderFailure = useAtomCommand(orchestrationEnvironment.explainProviderFailure, {
    reportFailure: false,
  });
  const [detailsCopied, setDetailsCopied] = useState(false);
  const explain = async () => {
    setState({ kind: "pending" });
    const result = await explainProviderFailure({
      environmentId,
      input: { threadId, ...(runId === null ? {} : { runId }), revision: error },
    });
    if (result._tag === "Success") {
      setState(explanationStateFromResult(error, result.value));
    } else if (!isAtomCommandInterrupted(result)) {
      setState(explanationStateFromFailure(squashAtomCommandFailure(result)));
    }
  };

  return (
    <>
      {state.kind === "ready" ? (
        <dl className="space-y-1 border-t border-current/16 pt-2" data-testid="error-explanation">
          <div>
            <dt className="inline font-medium">What happened: </dt>
            <dd className="inline">{state.summary}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Likely fix: </dt>
            <dd className="inline">{state.likelyFix}</dd>
          </div>
        </dl>
      ) : null}
      {state.kind === "ready" && state.link !== null ? (
        <InlineButton
          className="self-start [--inline-button-text-align:start] [--inline-button-white-space:normal]"
          render={<a href={state.link.url} target="_blank" rel="noopener noreferrer" />}
          // The link still opens: the details only go to the clipboard, where the user checks them.
          onClick={
            state.link.kind === "report"
              ? () =>
                  void copyReportDetails(reportDetailsText(state), (text) =>
                    writeTextToClipboard(text, "error details"),
                  ).then(setDetailsCopied)
              : undefined
          }
        >
          {state.link.label}
        </InlineButton>
      ) : null}
      {state.kind === "ready" && state.link?.kind === "report" && detailsCopied ? (
        <p>{REPORT_DETAILS_COPIED_NOTE}</p>
      ) : null}
      {state.kind === "pending" ? <p>Explaining…</p> : null}
      {state.kind === "failed" ? <p>Couldn't explain this error: {state.message}</p> : null}
      {state.kind === "idle" || state.kind === "failed" ? (
        <InlineButton className="self-start" onClick={() => void explain()}>
          {state.kind === "failed" ? "Try again" : "Explain"}
        </InlineButton>
      ) : null}
    </>
  );
}
