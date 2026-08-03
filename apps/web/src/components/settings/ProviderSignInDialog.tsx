"use client";

/**
 * In-app provider account sign-in (fork f1).
 *
 * Renders a single action pair — "Sign in" / "Switch account" plus an inline
 * "Sign out" — and the dialog that drives the streaming login RPC. Mounted from
 * both the Providers settings card and the chat provider banner, so the two
 * hook sites stay one line each.
 *
 * Two rules shape the whole component:
 *
 *   - **The dialog's open state is the login's lifetime.** The events atom is
 *     only mounted while a request is active; closing the dialog unmounts it,
 *     which closes the RPC stream, which cancels the login server-side and
 *     kills the app-server child.
 *   - **Never depend on a popup succeeding.** `openExternal` is attempted once
 *     on a browser handoff, but the URL is always rendered as a real anchor
 *     with a copy button, and the other mode is always one click away.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime"; // fork: f1 provider account sign-in
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentId, ProviderSignInMode, ServerProvider } from "@t3tools/contracts";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast"; // fork: f1 provider account sign-in
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { usePrimaryEnvironment } from "../../state/environments";
import { providerAuthEnvironment } from "../../state/providerAuth";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import {
  SIGN_IN_START_TIMEOUT_MS,
  SIGN_OUT_CONFIRM_TIMEOUT_MS,
  defaultSignInMode,
  describeSignInEvent,
  otherSignInMode,
  providerSignInModes,
  signInActionLabel,
  signOutButtonLabel,
  supportsInAppSignIn,
  switchSignInModeLabel,
} from "./providerSignInFlows";

const COMPLETED_AUTO_CLOSE_MS = 1_500;

/** fork: f1 — best-effort message for a failed sign-out command. */
function describeCommandFailure(result: { readonly cause: unknown }): string {
  const error = squashAtomCommandFailure(result as never);
  if (typeof error === "string") return error;
  const message = (error as { readonly message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "The provider refused the sign-out.";
}

function providerDisplayName(provider: ServerProvider): string {
  return provider.displayName?.trim() || formatProviderDriverKindLabel(provider.driver);
}

function CopyButton(props: { readonly value: string; readonly label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={props.label}
      onClick={() => copyToClipboard(props.value, undefined)}
    >
      {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

function ExternalLink(props: { readonly href: string; readonly children: React.ReactNode }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-w-0 items-center gap-1 break-all text-primary underline underline-offset-2"
    >
      <span className="min-w-0 break-all">{props.children}</span>
      <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

interface SignInRequest {
  readonly mode: ProviderSignInMode;
  readonly attempt: number;
}

function ProviderSignInDialogBody(props: {
  readonly provider: ServerProvider;
  readonly environmentId: EnvironmentId | null;
  readonly onClose: () => void;
}) {
  // fork: f1 — the RPC must go to the environment that OWNS this provider. The
  // chat banner's provider comes from the active thread's environment, and
  // default instance ids are driver-derived, so falling back to the primary
  // environment would happily log the user in on the wrong machine while the
  // remote provider stayed signed out.
  const primary = usePrimaryEnvironment();
  const environmentId = props.environmentId ?? primary?.environmentId ?? null;
  const providerName = providerDisplayName(props.provider);
  const availableModes = providerSignInModes(props.provider);

  const initialMode = useMemo(() => {
    const preferred = defaultSignInMode({
      environmentId,
      hasDesktopBridge: typeof window !== "undefined" && window.desktopBridge !== undefined,
    });
    return availableModes.includes(preferred) ? preferred : (availableModes[0] ?? "deviceCode");
  }, [availableModes, environmentId]);

  const [request, setRequest] = useState<SignInRequest | null>(null);

  // Mounted only while a request is active — unmounting is the cancel.
  const eventsAtom =
    request !== null && environmentId !== null
      ? providerAuthEnvironment.signInEvents({
          environmentId,
          input: {
            instanceId: props.provider.instanceId,
            mode: request.mode,
            attempt: request.attempt,
          },
        })
      : null;
  const events = useEnvironmentQuery(eventsAtom);
  const latestEvent = events.data ?? undefined;

  const mode = request?.mode ?? initialMode;
  const presentation = describeSignInEvent(latestEvent, { providerName, mode });
  const rawPhase = request === null ? "idle" : presentation.phase;

  /**
   * fork: f1 F-22 — time-box "Contacting…".
   *
   * An unreachable environment produces an empty event stream rather than an
   * error, so `starting` had no exit at all and the retry button is not
   * rendered in that phase. Now it becomes a real failure with a retry.
   */
  const [startTimedOut, setStartTimedOut] = useState(false);
  useEffect(() => {
    setStartTimedOut(false);
  }, [request]);
  useEffect(() => {
    if (rawPhase !== "starting") return;
    const timer = setTimeout(() => setStartTimedOut(true), SIGN_IN_START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [rawPhase, request]);

  const timedOut = startTimedOut && rawPhase === "starting";
  const phase = timedOut ? "failed" : rawPhase;

  const start = useCallback((nextMode: ProviderSignInMode) => {
    setStartTimedOut(false);
    setRequest((current) => ({ mode: nextMode, attempt: (current?.attempt ?? 0) + 1 }));
  }, []);

  // Unmounting the events atom is the cancel — see the header note.
  const cancel = useCallback(() => {
    setStartTimedOut(false);
    setRequest(null);
  }, []);

  // Attempt the native handoff once per URL. Harmless when it is blocked: the
  // anchor below is the real affordance.
  const openedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    const authUrl = presentation.authUrl;
    if (authUrl === undefined || openedUrlRef.current === authUrl) return;
    openedUrlRef.current = authUrl;
    void ensureLocalApi()
      .shell.openExternal(authUrl)
      .catch(() => undefined);
  }, [presentation.authUrl]);

  const onClose = props.onClose;
  useEffect(() => {
    if (phase !== "completed") return;
    const timer = setTimeout(onClose, COMPLETED_AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [onClose, phase]);

  const otherMode = otherSignInMode(mode);
  const canSwitchMode = availableModes.includes(otherMode);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {phase === "idle" ? `Sign in to ${providerName}` : presentation.title}
        </DialogTitle>
        <DialogDescription>
          {phase === "idle"
            ? props.provider.auth.email
              ? `Currently signed in as ${props.provider.auth.email}.`
              : "T3 Code never sees your credentials — the provider CLI stores them itself."
            : presentation.body}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-4">
        {environmentId === null ? (
          <p className="text-sm text-muted-foreground">
            Connect to an environment before signing in.
          </p>
        ) : null}

        {phase === "starting" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            <span>{presentation.body}</span>
          </div>
        ) : null}

        {phase === "browserHandoff" && presentation.authUrl ? (
          <div className="grid gap-2">
            <div className="flex items-start gap-1 rounded-md border border-border/70 bg-muted/40 p-2">
              <ExternalLink href={presentation.authUrl}>{presentation.authUrl}</ExternalLink>
              <CopyButton value={presentation.authUrl} label="Copy sign-in link" />
            </div>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-3.5" />
              Waiting for confirmation…
            </p>
          </div>
        ) : null}

        {phase === "deviceCode" && presentation.userCode && presentation.verificationUrl ? (
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/40 p-3">
              <code className="font-mono text-2xl tracking-[0.2em] text-foreground">
                {presentation.userCode}
              </code>
              <CopyButton value={presentation.userCode} label="Copy device code" />
            </div>
            <p className="text-sm text-muted-foreground">
              Enter this code on{" "}
              <ExternalLink href={presentation.verificationUrl}>
                {presentation.verificationUrl}
              </ExternalLink>
            </p>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-3.5" />
              Waiting for confirmation…
            </p>
          </div>
        ) : null}

        {phase === "completed" ? (
          <p className="flex items-center gap-2 text-sm text-foreground">
            <CheckIcon className="size-4 text-success" aria-hidden />
            {presentation.body}
          </p>
        ) : null}

        {phase === "failed" || events.error !== null ? (
          <p className="whitespace-pre-wrap text-sm text-destructive">
            {timedOut
              ? `${providerName} did not respond. The environment may be unreachable, or the provider CLI could not start.`
              : (events.error ?? presentation.body)}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {phase === "idle" || phase === "failed" || events.error !== null ? (
            <Button type="button" size="sm" onClick={() => start(mode)} disabled={!environmentId}>
              {phase === "idle"
                ? mode === "browser"
                  ? "Sign in with a browser"
                  : "Sign in with a device code"
                : "Try again"}
            </Button>
          ) : null}
          {/* fork: f1 F-22 — a cancel is always available while a request is
              live, so a stuck login is not a dead dialog. */}
          {request !== null && phase !== "completed" ? (
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          ) : null}
          {phase !== "completed" && canSwitchMode ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => start(otherMode)}
              disabled={!environmentId}
            >
              {switchSignInModeLabel(mode)}
            </Button>
          ) : null}
        </div>
      </DialogPanel>
    </>
  );
}

function SignOutButton(props: {
  readonly provider: ServerProvider;
  readonly environmentId: EnvironmentId | null;
}) {
  // fork: f1 — same targeting rule as the dialog; signing the WRONG machine's
  // account out is the worse half of that bug.
  const primary = usePrimaryEnvironment();
  const environmentId = props.environmentId ?? primary?.environmentId ?? null;
  const [armed, setArmed] = useState(false);
  // fork: f1 F-34 — a slow sign-out had no in-flight state at all: the label
  // went straight back to "Sign out" and a second press fired a second RPC.
  const [pending, setPending] = useState(false);
  const signOut = useAtomCommand(providerAuthEnvironment.signOut);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), SIGN_OUT_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  if (environmentId === null) return null;

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={pending}
      className={armed ? "text-destructive hover:text-destructive" : "text-muted-foreground"}
      onClick={() => {
        if (pending) return;
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        setPending(true);
        // fork: f1 — a dropped failure made "Confirm sign-out" look like a
        // no-op when the codex child could not spawn.
        void signOut({
          environmentId,
          input: { instanceId: props.provider.instanceId },
        }).then((result) => {
          if (mountedRef.current) setPending(false);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            toastManager.add({
              type: "error",
              title: "Could not sign out",
              description: describeCommandFailure(result),
            });
          }
        });
      }}
    >
      {signOutButtonLabel(armed, pending)}
    </Button>
  );
}

/**
 * The whole affordance: renders nothing at all when the server does not
 * advertise an in-app sign-in method for this instance, which is what keeps an
 * upstream server (and every non-Codex driver) looking exactly as it did.
 */
export function ProviderSignInAction(props: {
  readonly provider: ServerProvider | undefined;
  /**
   * fork: f1 — the environment whose config produced `provider`. Omitted (the
   * Settings card) means the primary environment.
   */
  readonly environmentId?: EnvironmentId | null;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const provider = props.provider;
  const close = useCallback(() => setOpen(false), []);

  if (!provider || !supportsInAppSignIn(provider)) return null;

  return (
    <div className={props.className}>
      <div className="flex flex-wrap items-center gap-1">
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
          {signInActionLabel(provider)}
        </Button>
        {provider.auth.status === "authenticated" ? (
          <SignOutButton provider={provider} environmentId={props.environmentId ?? null} />
        ) : null}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogPopup>
            <ProviderSignInDialogBody
              provider={provider}
              environmentId={props.environmentId ?? null}
              onClose={close}
            />
          </DialogPopup>
        ) : null}
      </Dialog>
    </div>
  );
}
