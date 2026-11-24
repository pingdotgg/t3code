import { pipe } from "effect/Function";
import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestInputs,
  secretRequestPrivacyNote,
  secretRequestReasonParts,
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
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type SecretProviderId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { hasFeatureFlag } from "@t3tools/client-runtime/state/server";
import { T, useGT, useMessages } from "gt-react";
import {
  ArrowUpRightIcon,
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LockIcon,
  MinusIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useId, useRef, useState, type FormEvent, type MouseEvent } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { SecretSourceSelect } from "../settings/SecretSourceInput";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Kbd } from "../ui/kbd";
import { Text } from "../ui/text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkLogRow } from "./WorkLog";

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const messages = useMessages();
  const display = secretRequestDisplay(item, props.visibility, messages);
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
        wrapLabel
        label={
          <>
            {item.label} {display.label.toLowerCase()}
          </>
        }
      />
    );
  }
  return <PendingSecretRequestForm environmentId={props.environmentId} item={item} />;
}

const NO_SOURCES: ReadonlyArray<SecretRequestSource> = [];

/** A label written as an environment variable name, the only kind worth repeating as a prefix. */
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{1,47}$/;

// A tooltip above the link would cover the reason being read, so it opens to the side instead.
const TOOLTIP_ROOM_BELOW_PX = 48;

/** The host as an ordinary text link; the full address shows on hover and focus. */
function HostLink(props: { readonly href: string; readonly host: string }) {
  const [side, setSide] = useState<"bottom" | "inline-end">("bottom");
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Tooltip
      onOpenChange={(open) => {
        const trigger = triggerRef.current;
        if (!open || trigger === null) return;
        const roomBelow = window.innerHeight - trigger.getBoundingClientRect().bottom;
        setSide(roomBelow >= TOOLTIP_ROOM_BELOW_PX ? "bottom" : "inline-end");
      }}
    >
      <TooltipTrigger
        ref={triggerRef}
        render={
          <InlineButton
            tone="link"
            render={<a href={props.href} target="_blank" rel="noopener noreferrer" />}
          />
        }
      >
        {props.host}
        <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </TooltipTrigger>
      <TooltipPopup variant="code" side={side}>
        {props.href}
      </TooltipPopup>
    </Tooltip>
  );
}

function useSecretRequestSources(environmentId: EnvironmentId) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const messages = useMessages();
  // The server accepts a reference answer only with this scope; without it the card is typed.
  const canUseReferences = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  return canUseReferences && hasFeatureFlag(config, "secretProviders")
    ? secretRequestSources(config, config?.settings.secretProviders ?? {}, messages)
    : NO_SOURCES;
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
}) {
  const { item } = props;
  const gt = useGT();
  const messages = useMessages();
  const formId = useId();
  const errorId = useId();
  const privacyId = useId();
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
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
  const inputs = secretRequestInputs(item, messages);
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
      pipe(
        squashAtomCommandFailure(result),
        (failure) => secretRequestFailureMessage(failure, messages),
        setError,
      );
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
  // On click, not pointerdown: the mousedown that follows a pointerdown
  // moves focus back off the input. A click that ends a text selection
  // leaves it alone so the reason can still be copied.
  const onCardClick = (event: MouseEvent<HTMLFormElement>) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("input, button, a, [data-slot='tooltip-trigger']")) return;
    if (window.getSelection()?.isCollapsed === false) return;
    const empty = inputs.findIndex((input) => !secretRequestValue(values, input.key).trim());
    document.getElementById(inputId(Math.max(empty, 0)))?.focus();
  };
  const reason = secretRequestReasonParts(item);
  const prefix = !multiple && VARIABLE_NAME.test(item.label) ? item.label : null;
  const field = (input: SecretRequestInput, index: number) => (
    <SecretRequestField
      key={input.key}
      id={inputId(index)}
      input={input}
      // A single input is labelled by the card title.
      label={multiple ? input.label : undefined}
      prefix={prefix}
      value={secretRequestValue(values, input.key)}
      disabled={submitting}
      invalid={error !== null}
      describedBy={describedBy}
      onChange={(value) => setValues((current) => ({ ...current, [input.key]: value }))}
    />
  );

  return (
    <form
      data-v2-item-type={item.type}
      className="@container/secret-card flex min-w-0 flex-col rounded-xl surface-tray p-1"
      onSubmit={onSubmit}
      autoComplete="off"
      onClick={onCardClick}
    >
      <div className="flex min-h-9 min-w-0 items-center gap-2 px-2.5 pb-1">
        <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-warning-foreground" />
        {multiple ? (
          <p className="min-w-0 flex-1 text-label text-foreground">{item.label}</p>
        ) : (
          <label htmlFor={inputId(0)} className="min-w-0 flex-1 text-label text-foreground">
            {item.label}
          </label>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                aria-describedby={privacyId}
                className="ms-auto flex shrink-0 items-center gap-1 py-0.5 whitespace-nowrap text-meta text-muted-foreground"
              />
            }
          >
            <ShieldCheckIcon className="size-3 shrink-0" aria-hidden />
            <span className="@max-[30rem]/secret-card:sr-only">
              {item.delivery === "file" ? gt("Private file, 24 hours") : gt("Hidden from agent")}
            </span>
          </TooltipTrigger>
          <TooltipPopup>{secretRequestPrivacyNote(item, messages)}</TooltipPopup>
        </Tooltip>
      </div>
      <span id={privacyId} className="sr-only">
        {secretRequestPrivacyNote(item, messages)}
      </span>
      {/* Flat paints wells and secondary buttons with the composer fill, so this box takes the tray fill. */}
      <div className="flex min-w-0 flex-col gap-2.5 rounded-lg surface-composer px-2.5 pt-2 pb-2.5 in-data-[surface-style=flat]:[--composer-fill:var(--tray-fill)]">
        {reason.before !== "" || reason.link !== null ? (
          <p className="min-w-0 px-1 text-body text-muted-foreground">
            {reason.before}
            {reason.link !== null ? (
              <HostLink href={reason.link.href} host={reason.link.host} />
            ) : null}
            {reason.after}
          </p>
        ) : null}
        {multiple ? <div className="flex min-w-0 flex-col gap-2">{inputs.map(field)}</div> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
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
          {multiple ? null : (
            <div className="min-w-40 flex-1">
              {source === null ? (
                inputs.map(field)
              ) : (
                <InputGroup>
                  {prefix !== null ? <SecretVariablePrefix prefix={prefix} /> : null}
                  <InputGroupInput
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
                </InputGroup>
              )}
            </div>
          )}
          {/* One group, so a narrow pane wraps both buttons together. */}
          <div className="ms-auto flex shrink-0 items-center gap-1">
            <Button type="submit" variant="secondary" disabled={submitting || !canSave}>
              <T>Save securely</T>
              <Kbd size="sm" aria-hidden>
                ↵
              </Kbd>
            </Button>
            <Button
              type="button"
              variant="ghost-muted"
              disabled={submitting}
              onClick={() => void send({ type: "decline" })}
            >
              <T>Decline</T>
            </Button>
          </div>
        </div>
        {error !== null ? (
          <p id={errorId} role="alert" className="px-1 text-meta text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function SecretVariablePrefix(props: { readonly prefix: string }) {
  return (
    <InputGroupAddon className="max-w-1/2 min-w-0 shrink-0">
      <div className="min-w-0 border-e border-divider pe-3">
        <Text render={<p />} variant="body" tone="muted" mono truncate title={props.prefix}>
          {props.prefix}
        </Text>
      </div>
    </InputGroupAddon>
  );
}

function SecretRequestField(props: {
  readonly id: string;
  readonly input: SecretRequestInput;
  readonly label: string | undefined;
  readonly prefix: string | null;
  readonly value: string;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly describedBy: string;
  readonly onChange: (value: string) => void;
}) {
  const { input } = props;
  const gt = useGT();
  const [revealed, setRevealed] = useState(false);
  const masked = input.secret && !revealed;
  const control = (
    <InputGroup>
      {props.prefix !== null ? <SecretVariablePrefix prefix={props.prefix} /> : null}
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
            aria-label={gt("Show {label}", { label: input.label })}
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
      <label htmlFor={props.id} className="px-1 text-meta text-muted-foreground">
        {props.label}
      </label>
      {control}
    </div>
  );
}
