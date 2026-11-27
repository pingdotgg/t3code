import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import type {
  ChildThreadApproval,
  ThreadPendingApproval,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  fullAccessOverrideExplanation,
  PUSH_HOOKS_APPROVAL_QUESTION,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { childThreadApprovalsAtom, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ApprovalText } from "./ApprovalText";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { PushHooksApprovalDetails } from "./PushHooksApprovalDetails";

function ChildApproval({ entry }: { entry: ChildThreadApproval }) {
  const gt = useGT();
  return (
    <section
      aria-label={gt("Approval from {title}", { title: entry.title })}
      className="rounded-lg border border-border bg-background p-3 text-xs"
    >
      <p className="mb-2 font-medium">
        <T>
          Approval needed from <Var>{entry.title}</Var>
        </T>
      </p>
      <OtherThreadApproval thread={entry.thread} approval={entry.approval} />
    </section>
  );
}

/** Another thread's pending approval, answered on that thread. */
export function OtherThreadApproval({
  thread,
  approval,
}: {
  thread: ScopedThreadRef;
  approval: ThreadPendingApproval;
}) {
  const connected = Option.isSome(usePreparedConnection(thread.environmentId));
  const canRespond =
    useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope) && connected;
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const gt = useGT();
  const messages = useMessages();
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notice = !connected ? gt("Not connected") : error;
  return (
    <>
      {approval.pushHooks ? (
        <>
          <p className="mb-1">{messages(PUSH_HOOKS_APPROVAL_QUESTION)}</p>
          <PushHooksApprovalDetails pushHooks={approval.pushHooks} />
        </>
      ) : (
        <ApprovalText text={approval.detail || approval.requestKind} />
      )}
      {approval.appName ? <p className="mt-2 text-muted-foreground">{approval.appName}</p> : null}
      {approval.responseCapability !== "live" ? (
        <p className="mt-2 text-warning">
          <T>Provider process is gone. Interrupt or restart the child thread to respond.</T>
        </p>
      ) : null}
      {approval.reason ? <p className="mt-2 text-muted-foreground">{approval.reason}</p> : null}
      {approval.fullAccessOverride ? (
        <p className="mt-2 text-muted-foreground">
          {fullAccessOverrideExplanation(approval.fullAccessOverride, messages)}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <ComposerPendingApprovalActions
          presentation="inline"
          requestId={approval.requestId}
          isResponding={responding}
          canRespond={approval.responseCapability === "live"}
          disabled={!canRespond}
          options={approval.options}
          onRespondToApproval={async (requestId, decision) => {
            if (!canRespond || responding) return;
            setResponding(true);
            setError(null);
            const result = await respond({
              environmentId: thread.environmentId,
              input: { threadId: thread.threadId, requestId, decision },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const failure = squashAtomCommandFailure(result);
              setError(
                failure instanceof Error
                  ? failure.message
                  : gt("Failed to submit approval decision."),
              );
            }
            setResponding(false);
            return result;
          }}
        />
        {notice !== null ? (
          <p role="alert" className="min-w-0 self-center truncate text-destructive">
            {notice}
          </p>
        ) : null}
      </div>
    </>
  );
}

export function ChildThreadApprovals({
  threadRef,
  hideWorkers = false,
}: {
  threadRef: ScopedThreadRef | null;
  /** A Bot's chat shows its workers' requests itself. */
  hideWorkers?: boolean;
}) {
  const allApprovals = useAtomValue(childThreadApprovalsAtom(threadRef));
  const approvals = hideWorkers ? allApprovals.filter((entry) => !entry.worker) : allApprovals;
  if (approvals.length === 0) return null;
  return (
    <div className="mb-2 flex max-h-80 flex-col gap-2 overflow-auto">
      {approvals.map((entry) => (
        <ChildApproval
          key={JSON.stringify([
            entry.thread.environmentId,
            entry.thread.threadId,
            entry.approval.requestId,
          ])}
          entry={entry}
        />
      ))}
    </div>
  );
}
