import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT } from "gt-react";
import { use, useState } from "react";
import { InlineButton } from "../ui/button";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { TimelineApprovalCard } from "./TimelinePendingApprovalRow";
import { TimelineApprovalCtx } from "./timelineRowContext";

export function TimelineChildApprovalCard({
  entry,
  onOpenThread,
  onAnswered,
}: {
  readonly entry: ChildThreadApproval;
  readonly onOpenThread?: (() => void) | undefined;
  readonly onAnswered?: (() => void) | null | undefined;
}) {
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const gt = useGT();
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { approval } = entry;
  return (
    <TimelineApprovalCard
      approval={approval}
      title={gt("Approval needed from {title}", { title: entry.title })}
      ariaLabel={gt("Approval from {title}", { title: entry.title })}
      headerTrailing={
        onOpenThread ? (
          <InlineButton onClick={onOpenThread}>
            <T>Open subagent</T>
          </InlineButton>
        ) : null
      }
      disabled={!canRespond}
      isResponding={responding}
      unavailableMessage={
        <T>Provider process is gone. Interrupt or restart the child thread to respond.</T>
      }
      error={error}
      onAnswered={onAnswered}
      onRespond={async (requestId, decision) => {
        if (!canRespond || responding) return;
        setResponding(true);
        setError(null);
        const result = await respond({
          environmentId: entry.thread.environmentId,
          input: { threadId: entry.thread.threadId, requestId, decision },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error ? failure.message : gt("Failed to submit approval decision."),
          );
        }
        setResponding(false);
        return result;
      }}
    />
  );
}

/** Pending approvals belonging to one subagent, rendered beneath its parent timeline row. */
export function SubagentPendingApprovals({
  childThreadKey,
  onOpenThread,
}: {
  readonly childThreadKey: string;
  readonly onOpenThread?: (() => void) | undefined;
}) {
  const { childApprovalsByThreadKey, onApprovalAnswered } = use(TimelineApprovalCtx);
  const entries = childApprovalsByThreadKey.get(childThreadKey);
  if (!entries || entries.length === 0) return null;
  return (
    <div className="mt-1 flex min-w-0 flex-col gap-2">
      {entries.map((entry) => (
        <TimelineChildApprovalCard
          key={JSON.stringify([
            entry.thread.environmentId,
            entry.thread.threadId,
            entry.approval.requestId,
          ])}
          entry={entry}
          onOpenThread={onOpenThread}
          onAnswered={onApprovalAnswered}
        />
      ))}
    </div>
  );
}
