import type { ReactNode } from "react";
import type { ComputerApproval, EnvironmentId } from "@t3tools/contracts";
import {
  computerActionSentence,
  computerApprovalSurface,
  computerApprovalTypedText,
} from "@t3tools/client-runtime/state/computer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as DateTime from "effect/DateTime";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { useDeadlinePassed } from "../../hooks/useDeadline";
import { tickTextContent } from "../../lib/tickTextContent";
import { computerEnvironment, useCanApproveComputerSteps } from "../../state/computer";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export interface ComputerApprovalCardProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly approval: ComputerApproval;
  /** Announce it: only the first line that needs the person in a thread does. */
  readonly announce?: boolean;
}

/** The exact text a step types, in full: it is what the person approves. */
function TypedText({ text }: { readonly text: string }) {
  return (
    <pre
      data-testid="computer-approval-typed-text"
      className="mt-2 max-h-40 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-xs break-words whitespace-pre-wrap"
    >
      {text}
    </pre>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/**
 * One consequential step, waiting for a person's tap, showing everything the tap is bound to:
 * what it does, the text it types, where, why, and the goal it serves.
 *
 * The countdown writes into its own node on the shared second tick, so a visible card never
 * re-renders the timeline around it; the component re-renders once, when the step lapses.
 */
export function ComputerApprovalCard({
  environmentId,
  environmentLabel,
  approval,
  announce = false,
}: ComputerApprovalCardProps) {
  const gt = useGT();
  const m = useMessages();
  const expiresAtMs = DateTime.toEpochMillis(approval.expiresAt);
  const expired = useDeadlinePassed(expiresAtMs);
  const canApprove = useCanApproveComputerSteps(environmentId);
  const respond = useAtomCommand(computerEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approve: boolean) => {
    if (!canApprove || responding !== null) return;
    setResponding(approve);
    setError(null);
    const result = await respond({
      environmentId,
      input: { approvalId: approval.id, approve },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Could not answer that step."));
    }
    setResponding(null);
  };

  const disabled = !canApprove || responding !== null || expired;
  const typedText = computerApprovalTypedText(approval);
  const surface = computerApprovalSurface(approval);
  const countdown = (nowMs: number) => {
    const seconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
    return seconds <= 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  const actions = (
    <>
      <Button size="xs" variant="outline" disabled={disabled} onClick={() => void decide(false)}>
        {responding === false
          ? gt("Denying...")
          : gt("Deny", { $context: "button, refuses a computer step" })}
      </Button>
      <Button size="xs" disabled={disabled} onClick={() => void decide(true)}>
        {responding === true
          ? gt("Approving...")
          : gt("Approve", { $context: "button, allows a computer step" })}
      </Button>
    </>
  );

  return (
    <section
      role={announce ? "alert" : "region"}
      aria-label={gt("Computer use approval")}
      data-computer-approval-card=""
      className="rounded-xl border border-warning/32 bg-warning-surface p-3 text-xs shadow-xs/5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium text-warning-foreground">
          {computerActionSentence(approval.binding.action, m)}
        </h3>
        {expired ? (
          <span className="shrink-0 text-muted-foreground">
            <T>Expired</T>
          </span>
        ) : (
          <span
            ref={tickTextContent(countdown, !expired)}
            className="shrink-0 text-muted-foreground tabular-nums"
          />
        )}
      </div>
      <p className="mt-1 text-muted-foreground">{approval.binding.why}</p>
      <dl className="mt-2 grid gap-1.5">
        {surface.length === 0 ? null : (
          <Field label={gt("On", { $context: "label for the app a computer step acts on" })}>
            <span className="font-mono">{surface}</span>
          </Field>
        )}
        <Field label={gt("Goal", { $context: "label for the task goal" })}>
          {approval.binding.goal}
        </Field>
        <Field label={gt("Asked by")}>
          {approval.binding.requester} · {environmentLabel}
        </Field>
      </dl>
      {typedText === null ? null : <TypedText text={typedText} />}
      <div className="mt-3 flex items-center justify-end gap-2">{actions}</div>
      {canApprove ? null : (
        <p className="mt-2 text-muted-foreground">
          <T>
            This connection cannot approve computer steps. Pair this device again in Settings →
            Connections.
          </T>
        </p>
      )}
      {error !== null ? (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
