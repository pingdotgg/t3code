import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { useProviderFailureExplanation } from "../../state/queries";
import { InlineButton } from "../ui/button";
import { deriveThreadErrorExplanationView } from "./ThreadErrorExplanation.logic";

/**
 * The Explain action and its answer, rendered inside the error banner. Nothing
 * is requested until the user clicks, and the pending state is static text so
 * the banner never repaints on its own.
 */
export function ThreadErrorExplanation({
  environmentId,
  threadId,
  error,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  error: string;
}) {
  const [requested, setRequested] = useState(false);
  const query = useProviderFailureExplanation(
    requested ? { environmentId, threadId, failure: error } : null,
  );
  const view = deriveThreadErrorExplanationView({
    requested,
    isPending: query.isPending,
    data: query.data,
    error: query.error,
  });
  const explain = () => {
    if (requested) {
      query.refresh();
    } else {
      setRequested(true);
    }
  };

  return (
    <>
      {view.kind === "ready" ? (
        <dl className="space-y-1 border-t border-current/16 pt-2" data-testid="error-explanation">
          <div>
            <dt className="inline font-medium">What happened: </dt>
            <dd className="inline">{view.summary}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Likely fix: </dt>
            <dd className="inline">{view.likelyFix}</dd>
          </div>
        </dl>
      ) : null}
      {view.kind === "pending" ? <p>Explaining…</p> : null}
      {view.kind === "failed" ? <p>Couldn't explain this error: {view.message}</p> : null}
      {view.kind === "idle" || view.kind === "failed" ? (
        <InlineButton className="self-start" onClick={explain}>
          {view.kind === "failed" ? "Try again" : "Explain"}
        </InlineButton>
      ) : null}
    </>
  );
}
