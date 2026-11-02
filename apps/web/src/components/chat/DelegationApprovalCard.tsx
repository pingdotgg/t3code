import { pipe } from "effect/Function";
import { useAtomValue } from "@effect/atom-react";
import {
  delegationApprovalAnswerInput,
  delegationApprovalDisplay,
  delegationApprovalFailureMessage,
  type DelegationApprovalItem,
  delegationSelectionLabel,
} from "@t3tools/client-runtime/delegation-approval";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { CheckIcon, GitForkIcon, MinusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { WorkLogRow } from "./WorkLog";

/** An agent asked to delegate a task to a provider, model or options other than its own. */
export function DelegationApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: DelegationApprovalItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = delegationApprovalDisplay(item, props.visibility);
  if (display.kind === "answered" || display.kind === "pending-elsewhere") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? GitForkIcon
        : display.outcome === "approved"
          ? CheckIcon
          : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            Delegate to {delegationSelectionLabel(item.proposed)} · {display.label}
          </>
        }
      />
    );
  }
  return <PendingDelegationApproval environmentId={props.environmentId} item={item} />;
}

function PendingDelegationApproval(props: {
  readonly environmentId: EnvironmentId;
  readonly item: DelegationApprovalItem;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerDelegationApproval, {
    label: "answer delegation approval",
    reportFailure: false,
    reportDefect: false,
  });
  const canAnswer = useAtomValue(
    serverEnvironment.answerDelegationApproval.permissionAtom(props.environmentId),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two clicks can both land before a render.
  const inFlight = useRef(false);

  const send = async (decision: "approve" | "decline") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: delegationApprovalAnswerInput(item, decision),
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      pipe(squashAtomCommandFailure(result), delegationApprovalFailureMessage, setError);
    }
  };

  return (
    <div
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium text-foreground">
          {item.environmentId === undefined
            ? "Run a subagent on a different model?"
            : "Run a subagent in another environment on a different model?"}
        </p>
        <p className="line-clamp-3 text-sm wrap-anywhere text-muted-foreground">{item.task}</p>
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">This thread</dt>
        <dd className="min-w-0 wrap-anywhere text-muted-foreground">
          {delegationSelectionLabel(item.current)}
        </dd>
        <dt className="text-muted-foreground">Subagent</dt>
        <dd className="min-w-0 wrap-anywhere text-foreground">
          {delegationSelectionLabel(item.proposed)}
          {item.environmentId === undefined ? null : ` · ${item.environmentId}`}
        </dd>
      </dl>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {canAnswer ? (
        <div className="flex min-w-0 items-center justify-end gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            disabled={submitting}
            onClick={() => void send("decline")}
          >
            Decline
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={submitting}
            onClick={() => void send("approve")}
          >
            Approve
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Only a session that can run agents here can answer this.
        </p>
      )}
    </div>
  );
}
