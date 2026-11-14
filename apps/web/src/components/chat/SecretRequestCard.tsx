import { pipe } from "effect/Function";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  secretRequestReasonParts,
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
import {
  ArrowUpRightIcon,
  CheckIcon,
  KeyRoundIcon,
  LockIcon,
  MinusIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useId, useRef, useState, type FormEvent, type MouseEvent } from "react";

import { isSecretsFeatureEnabled } from "../../env";
import { serverEnvironment } from "../../state/server";
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
    label: "answer secret request",
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
  // On click, not pointerdown: the mousedown that follows a pointerdown
  // moves focus back off the input. A click that ends a text selection
  // leaves it alone so the reason can still be copied.
  const onCardClick = (event: MouseEvent<HTMLFormElement>) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("input, button, a, [data-slot='tooltip-trigger']")) return;
    if (window.getSelection()?.isCollapsed === false) return;
    document.getElementById(inputId)?.focus();
  };
  const draft = source === null ? secret : reference;
  const describedBy = error !== null ? `${privacyId} ${errorId}` : privacyId;
  const reason = secretRequestReasonParts(item);
  const prefix = VARIABLE_NAME.test(item.label) ? item.label : null;

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
        <label htmlFor={inputId} className="min-w-0 flex-1 text-label text-foreground">
          {item.label}
        </label>
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
              {item.delivery === "file" ? "Private file, 24 hours" : "Hidden from agent"}
            </span>
          </TooltipTrigger>
          <TooltipPopup>{secretRequestPrivacyNote(item)}</TooltipPopup>
        </Tooltip>
      </div>
      <span id={privacyId} className="sr-only">
        {secretRequestPrivacyNote(item)}
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
          <div className="min-w-40 flex-1">
            <InputGroup>
              {prefix !== null ? (
                <InputGroupAddon className="max-w-1/2 min-w-0 shrink-0">
                  <div className="min-w-0 border-e border-divider pe-3">
                    <Text render={<p />} variant="body" tone="muted" mono truncate title={prefix}>
                      {prefix}
                    </Text>
                  </div>
                </InputGroupAddon>
              ) : null}
              {source === null ? (
                <InputGroupInput
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
                <InputGroupInput
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
            </InputGroup>
          </div>
          {/* One group, so a narrow pane wraps both buttons together. */}
          <div className="ms-auto flex shrink-0 items-center gap-1">
            <Button
              type="submit"
              variant="secondary"
              disabled={submitting || draft.trim().length === 0}
            >
              Save securely
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
              Decline
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
