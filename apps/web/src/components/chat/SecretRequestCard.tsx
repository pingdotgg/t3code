import { t } from "@palamedes/core/macro";
import { Trans } from "@palamedes/react/macro";
import { pipe } from "effect/Function";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestLink,
  secretRequestPrivacyNote,
  secretRequestReference,
  secretRequestSources,
  type SecretRequestItem,
  type SecretRequestReply,
  type SecretRequestSource,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  SecretProviderId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, ExternalLinkIcon, LockIcon, MinusIcon, ShieldCheckIcon } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { isSecretsFeatureEnabled } from "../../env";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SecretSourceSelect } from "../settings/SecretSourceInput";
import { WorkLogRow } from "./WorkLog";

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

const NO_SOURCES: ReadonlyArray<SecretRequestSource> = [];

function useSecretRequestSources(environmentId: EnvironmentId) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return isSecretsFeatureEnabled
    ? secretRequestSources(config, config?.settings.secretProviders ?? {})
    : NO_SOURCES;
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
}) {
  const { item } = props;
  const inputId = useId();
  const errorId = useId();
  const privacyId = useId();
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: t({ message: "answer secret request" }),
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const sources = useSecretRequestSources(props.environmentId);
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(null);
  const source = sources.find((candidate) => candidate.id === sourceId) ?? null;
  const [secret, setSecret] = useState("");
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter and click can both submit before a render.
  const inFlight = useRef(false);

  const send = async (reply: SecretRequestReply) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setSecret("");
      setReference("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      pipe(squashAtomCommandFailure(result), secretRequestFailureMessage, setError);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (source === null) {
      void send({ type: "save", secret });
    } else if (secretRequestReference(source, reference) === undefined) {
      setError(source.invalidReferenceMessage);
    } else {
      void send({ type: "reference", source, reference });
    }
  };
  const draft = source === null ? secret : reference;
  const link = secretRequestLink(item);
  const describedBy = error !== null ? `${privacyId} ${errorId}` : privacyId;

  return (
    <form
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={onSubmit}
      autoComplete="off"
      // On click, not pointerdown: the mousedown that follows a pointerdown
      // moves focus back off the input. A click that ends a text selection
      // leaves it alone so the reason can still be copied.
      onClick={(event) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest("input, button, a")) return;
        if (window.getSelection()?.isCollapsed === false) return;
        document.getElementById(inputId)?.focus();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={inputId} className="text-sm font-medium text-foreground">
          {item.label}
        </label>
        {item.reason.trim() ? (
          <p className="text-sm wrap-anywhere text-muted-foreground">{item.reason}</p>
        ) : null}
      </div>
      {link !== null ? (
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <Button
            variant="outline"
            size="sm"
            render={<a href={link.href} target="_blank" rel="noopener noreferrer" />}
          >
            Open {link.host}
            <ExternalLinkIcon aria-hidden />
          </Button>
          {/* A link found in the reason is already shown there. */}
          {item.url !== undefined ? (
            <p className="font-mono text-xs wrap-anywhere text-muted-foreground">{item.url}</p>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-2">
        {sources.length > 0 ? (
          <SecretSourceSelect
            value={source?.id ?? null}
            sources={sources}
            label={item.label}
            disabled={submitting}
            onValueChange={(next) => {
              setSourceId(next);
              setError(null);
            }}
          />
        ) : null}
        <div className="min-w-0 flex-1">
          {source === null ? (
            <Input
              id={inputId}
              // A CSS-masked text field still exposes its value to screen readers.
              type="password"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              placeholder={item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
              value={secret}
              disabled={submitting}
              aria-invalid={error !== null || undefined}
              aria-describedby={describedBy}
              onChange={(event) => setSecret(event.currentTarget.value)}
            />
          ) : (
            <Input
              id={inputId}
              font="mono"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={source.referencePlaceholder}
              value={reference}
              disabled={submitting}
              aria-invalid={error !== null || undefined}
              aria-describedby={describedBy}
              onChange={(event) => {
                setReference(event.currentTarget.value);
                setError(null);
              }}
            />
          )}
        </div>
        <Button type="submit" disabled={submitting || draft.trim().length === 0}>
          Save securely
        </Button>
      </div>
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {secretRequestPrivacyNote(item)}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={submitting}
          onClick={() => void send({ type: "decline" })}
        >
          <Trans>Decline</Trans>
        </Button>
      </div>
    </form>
  );
}
