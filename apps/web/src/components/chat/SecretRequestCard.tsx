import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  SECRET_REQUEST_PRIVACY_NOTE,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { CheckIcon, LockIcon, MinusIcon, ShieldCheckIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { WorkLogRow } from "./WorkLog";

/**
 * Inline card for a secret an agent asked the user for. The typed value lives
 * only in this component's state and the RPC payload: it is never logged,
 * toasted, or persisted, and the field clears once the answer is sent.
 */
export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = secretRequestDisplay(item, props.visibility);
  if (display.kind === "answered" || display.kind === "pending-elsewhere") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "saved"
          ? CheckIcon
          : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {item.label} · {display.label}
          </>
        }
      />
    );
  }
  return <PendingSecretRequestForm environmentId={props.environmentId} item={item} />;
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
}) {
  const { item } = props;
  const inputId = useId();
  const errorId = useId();
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (
    reply: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
  ) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input });
    setSubmitting(false);
    if (result._tag === "Success") {
      // The card switches to its answered row once the item updates.
      setSecret("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send({ type: "save", secret });
  };

  // Same hierarchy as a chat card: what is asked, why, the field, then the
  // promise about where the value goes.
  return (
    <form
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={onSubmit}
      autoComplete="off"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={inputId} className="text-sm font-medium text-foreground">
          {item.label}
        </label>
        {item.reason.trim() ? <p className="text-sm text-muted-foreground">{item.reason}</p> : null}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            id={inputId}
            type="password"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            // Password managers otherwise offer to save or fill this field.
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            placeholder={item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
            value={secret}
            disabled={submitting}
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(event) => setSecret(event.currentTarget.value)}
          />
        </div>
        <Button type="submit" disabled={submitting || secret.trim().length === 0}>
          Save securely
        </Button>
      </div>
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {SECRET_REQUEST_PRIVACY_NOTE}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={submitting}
          onClick={() => void send({ type: "decline" })}
        >
          Decline
        </Button>
      </div>
    </form>
  );
}
