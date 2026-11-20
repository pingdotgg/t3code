import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { answerApproval } from "../foryou/actions";
import { useEnvironmentThread } from "../state/threads";
import { ActionButton } from "./CardActions";
import type { EngineBodyProps } from "./engineBody";

/** An approval a child asks for: the command or change, and the choice to run it or not. */
export function ApprovalBody({ target, card, request, sent, onError }: EngineBodyProps) {
  const projection = Option.getOrNull(
    useEnvironmentThread(target.environmentId, ThreadId.make(request.threadId)).data,
  );
  const approval = useMemo(
    () =>
      projection === null
        ? undefined
        : derivePendingThreadRequests(projection).approvals.find(
            (entry) => entry.requestId === request.id,
          ),
    [projection, request.id],
  );
  const answer = (decision: "accept" | "decline") => {
    onError(null);
    void answerApproval(target, card, request, decision).then(onError);
  };
  const detail = approval?.detail ?? approval?.reason;
  return (
    <>
      <p className="text-[11px] text-muted">
        {approval === undefined ? "Loading the request" : `Approval for: ${approval.requestKind}`}
      </p>
      {detail !== undefined && (
        <pre
          data-testid="approval-detail"
          className="max-h-32 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px] break-words whitespace-pre-wrap text-fg"
        >
          {detail}
        </pre>
      )}
      <div className="flex gap-1.5">
        <ActionButton tone="primary" disabled={sent} onClick={() => answer("accept")}>
          Approve
        </ActionButton>
        <ActionButton disabled={sent} onClick={() => answer("decline")}>
          Decline
        </ActionButton>
      </div>
    </>
  );
}
