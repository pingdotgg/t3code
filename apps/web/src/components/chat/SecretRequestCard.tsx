import { pipe } from "effect/Function";
import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestInputs,
  secretRequestPrivacyNote,
  secretRequestReference,
  secretRequestSources,
  secretRequestValue,
  type SecretRequestInput,
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
import { CheckIcon, EyeIcon, EyeOffIcon, LockIcon, MinusIcon, ShieldCheckIcon } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { isSecretsFeatureEnabled } from "../../env";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
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
  const formId = useId();
  const errorId = useId();
  const privacyId = useId();
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const inputs = secretRequestInputs(item);
  const multiple = item.fields !== undefined;
  // A reference answers one value, so a card with fields is always typed.
  const configuredSources = useSecretRequestSources(props.environmentId);
  const sources = multiple ? NO_SOURCES : configuredSources;
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(null);
  const source = sources.find((candidate) => candidate.id === sourceId) ?? null;
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter and click can both submit before a render.
  const inFlight = useRef(false);
  const inputId = (index: number) => `${formId}-${index}`;
  const describedBy = error !== null ? `${privacyId} ${errorId}` : privacyId;
  const canSave =
    source === null
      ? secretRequestAnswerInput(item, { type: "save", values }) !== null
      : reference.trim().length > 0;

  const send = async (reply: SecretRequestReply) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    // A password field that leaves the page with text in it can prompt to save a login,
    // so the card is emptied before it closes; a failed answer puts the values back.
    const typed = values;
    setValues({});
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setReference("");
      return;
    }
    setValues(typed);
    if (!isAtomCommandInterrupted(result)) {
      pipe(squashAtomCommandFailure(result), secretRequestFailureMessage, setError);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (source === null) {
      void send({ type: "save", values });
    } else if (secretRequestReference(source, reference) === undefined) {
      setError(source.invalidReferenceMessage);
    } else {
      void send({ type: "reference", source, reference });
    }
  };

  const field = (input: SecretRequestInput, index: number) => (
    <SecretRequestField
      key={input.key}
      id={inputId(index)}
      input={input}
      // A single input is labelled by the card title.
      label={multiple ? input.label : undefined}
      value={secretRequestValue(values, input.key)}
      disabled={submitting}
      invalid={error !== null}
      describedBy={describedBy}
      onChange={(value) => setValues((current) => ({ ...current, [input.key]: value }))}
    />
  );
  const saveButton = (
    <Button type="submit" disabled={submitting || !canSave}>
      Save securely
    </Button>
  );

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
        const empty = inputs.findIndex((input) => !secretRequestValue(values, input.key).trim());
        document.getElementById(inputId(Math.max(empty, 0)))?.focus();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {multiple ? (
          <p className="text-sm font-medium text-foreground">{item.label}</p>
        ) : (
          <label htmlFor={inputId(0)} className="text-sm font-medium text-foreground">
            {item.label}
          </label>
        )}
        {item.reason.trim() ? (
          <p className="text-sm wrap-anywhere text-muted-foreground">{item.reason}</p>
        ) : null}
      </div>
      {multiple ? (
        <div className="flex min-w-0 flex-col gap-2.5">{inputs.map(field)}</div>
      ) : (
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
              inputs.map(field)
            ) : (
              <Input
                id={inputId(0)}
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
          {saveButton}
        </div>
      )}
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 grow basis-52 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {secretRequestPrivacyNote(item)}
        </p>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            disabled={submitting}
            onClick={() => void send({ type: "decline" })}
          >
            Decline
          </Button>
          {multiple ? saveButton : null}
        </div>
      </div>
    </form>
  );
}

function SecretRequestField(props: {
  readonly id: string;
  readonly input: SecretRequestInput;
  readonly label: string | undefined;
  readonly value: string;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly describedBy: string;
  readonly onChange: (value: string) => void;
}) {
  const { input } = props;
  const [revealed, setRevealed] = useState(false);
  const masked = input.secret && !revealed;
  const control = (
    <InputGroup>
      <InputGroupInput
        id={props.id}
        // A CSS-masked text field still exposes its value to screen readers.
        type={masked ? "password" : "text"}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        placeholder={input.placeholder}
        value={props.value}
        disabled={props.disabled}
        aria-invalid={props.invalid || undefined}
        aria-describedby={props.describedBy}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
      {input.secret ? (
        <InputGroupAddon align="inline-end">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Show ${input.label}`}
            aria-pressed={revealed}
            disabled={props.disabled}
            // Keep focus, and the caret, in the input.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
          </Button>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
  if (props.label === undefined) return control;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={props.id} className="text-xs font-medium text-muted-foreground">
        {props.label}
      </label>
      {control}
    </div>
  );
}
