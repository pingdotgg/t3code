import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import { fullAccessOverrideExplanation } from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { ShieldIcon } from "lucide-react";
import { ComposerRequestCard } from "./ComposerRequestCard";
import { useEnvironmentScope } from "../../state/session";
import { childThreadApprovalsAtom, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

function ChildApproval({ entry }: { entry: ChildThreadApproval }) {
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { approval } = entry;
  return (
    <ComposerRequestCard.Root role="region" aria-label={`Approval from ${entry.title}`}>
      <ComposerRequestCard.Header
        icon={<ShieldIcon />}
        title={`Approval needed from ${entry.title}`}
      />
      <ComposerRequestCard.Well>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap p-2 font-mono text-meta text-foreground wrap-anywhere">
          {approval.detail || approval.requestKind}
        </pre>
      </ComposerRequestCard.Well>
      {approval.appName ? (
        <p className="px-2.5 text-meta text-muted-foreground">{approval.appName}</p>
      ) : null}
      {approval.responseCapability !== "live" ? (
        <p className="px-2.5 text-meta text-warning-foreground">
          Provider process is gone. Interrupt or restart the child thread to respond.
        </p>
      ) : null}
      {approval.reason ? (
        <p className="px-2.5 text-meta text-muted-foreground">{approval.reason}</p>
      ) : null}
      {approval.fullAccessOverride ? (
        <p className="px-2.5 text-meta text-muted-foreground">
          {fullAccessOverrideExplanation(approval.fullAccessOverride)}
        </p>
      ) : null}
      <ComposerRequestCard.Footer>
        <ComposerPendingApprovalActions
          designLabels
          alwaysAllow={alwaysAllow}
          onAlwaysAllowChange={setAlwaysAllow}
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
              environmentId: entry.thread.environmentId,
              input: { threadId: entry.thread.threadId, requestId, decision },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const failure = squashAtomCommandFailure(result);
              setError(
                failure instanceof Error ? failure.message : "Failed to submit approval decision.",
              );
            }
            setResponding(false);
            return result;
          }}
        />
      </ComposerRequestCard.Footer>
      {error !== null ? (
        <p role="alert" className="px-2.5 text-meta text-error-foreground">
          {error}
        </p>
      ) : null}
    </ComposerRequestCard.Root>
  );
}

export function ChildThreadApprovals({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const approvals = useAtomValue(childThreadApprovalsAtom(threadRef));
  if (approvals.length === 0) return null;
  return (
    <div className="flex max-h-80 flex-col gap-2 overflow-auto">
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
