import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  fullAccessOverrideExplanation,
  PUSH_HOOKS_APPROVAL_QUESTION,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";
import { ShieldIcon } from "lucide-react";
import { ComposerRequestCard } from "./ComposerRequestCard";
import { useEnvironmentScope } from "../../state/session";
import { childThreadApprovalsAtom, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ApprovalText } from "./ApprovalText";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { PushHooksApprovalDetails } from "./PushHooksApprovalDetails";

function ChildApproval({ entry }: { entry: ChildThreadApproval }) {
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const gt = useGT();
  const messages = useMessages();
  const [responding, setResponding] = useState(false);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { approval } = entry;
  return (
    <ComposerRequestCard.Root
      role="region"
      aria-label={gt("Approval from {title}", { title: entry.title })}
    >
      <ComposerRequestCard.Header
        icon={<ShieldIcon />}
        title={gt("Approval needed from {title}", { title: entry.title })}
      />
      <ComposerRequestCard.Well>
        {approval.pushHooks ? (
          <div className="flex min-w-0 flex-col gap-2 p-2.5">
            <span className="block min-w-0 text-meta text-foreground select-text! wrap-anywhere">
              {messages(PUSH_HOOKS_APPROVAL_QUESTION)}
            </span>
            <PushHooksApprovalDetails pushHooks={approval.pushHooks} />
          </div>
        ) : (
          <ApprovalText className="p-2" text={approval.detail || approval.requestKind} />
        )}
      </ComposerRequestCard.Well>
      {approval.appName ? (
        <p className="px-2.5 text-meta text-muted-foreground">{approval.appName}</p>
      ) : null}
      {approval.responseCapability !== "live" ? (
        <p className="px-2.5 text-meta text-warning-foreground">
          <T>Provider process is gone. Interrupt or restart the child thread to respond.</T>
        </p>
      ) : null}
      {approval.reason ? (
        <p className="px-2.5 text-meta text-muted-foreground">{approval.reason}</p>
      ) : null}
      {approval.fullAccessOverride ? (
        <p className="px-2.5 text-meta text-muted-foreground">
          {fullAccessOverrideExplanation(approval.fullAccessOverride, messages)}
        </p>
      ) : null}
      <ComposerRequestCard.Footer>
        <ComposerPendingApprovalActions
          designLabels
          showShortcutHints={false}
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
                failure instanceof Error
                  ? failure.message
                  : gt("Failed to submit approval decision."),
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
