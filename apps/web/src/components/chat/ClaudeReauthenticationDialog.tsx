"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderReauthenticateAttemptId,
  ServerProviderReauthenticateStatusResult,
  ThreadId,
} from "@t3tools/contracts";

import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

export interface ClaudeReauthenticationRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
}

/** The information needed to show a server-owned Claude login attempt. */
export type ClaudeReauthenticationAttempt = Pick<
  ServerProviderReauthenticateStatusResult,
  "attemptId" | "authorizationUrl"
>;

export type ClaudeReauthenticationBeginResult = ClaudeReauthenticationAttempt;

export interface ClaudeReauthenticationSubmitInput extends ClaudeReauthenticationRequest {
  readonly attemptId: ServerProviderReauthenticateAttemptId;
  readonly code: string;
}

export interface ClaudeReauthenticationCancelInput extends ClaudeReauthenticationRequest {
  readonly attemptId: ServerProviderReauthenticateAttemptId;
}

export type ClaudeReauthenticationStatus = Pick<
  ServerProviderReauthenticateStatusResult,
  "status" | "authorizationUrl" | "error"
>;

/** Commands used by the dialog. The server owns the child process and its attempt state. */
export interface ClaudeReauthenticationActions {
  /** Starts `claude auth login` and resolves once its authorization URL is available. */
  readonly begin: (
    request: ClaudeReauthenticationRequest,
  ) => Promise<ClaudeReauthenticationBeginResult>;
  /** Sends the code to the waiting Claude process and returns its current status. */
  readonly submitCode: (
    input: ClaudeReauthenticationSubmitInput,
  ) => Promise<ClaudeReauthenticationStatus>;
  /** Stops an in-progress attempt. */
  readonly cancel: (input: ClaudeReauthenticationCancelInput) => Promise<void>;
  /** Reads the current server-owned attempt state. */
  readonly getStatus: (input: {
    readonly attemptId: ServerProviderReauthenticateAttemptId;
  }) => Promise<ClaudeReauthenticationStatus>;
}

export interface ClaudeReauthenticationDialogProps {
  readonly open: boolean;
  readonly request: ClaudeReauthenticationRequest;
  readonly onOpenChange: (open: boolean) => void;
  readonly actions: ClaudeReauthenticationActions;
  /** True when the owning screen observes the server attempt completing in the browser. */
  readonly resolved?: boolean;
  /** Called after Claude authentication succeeds, before the dialog is closed. */
  readonly onSuccess?: () => Promise<void> | void;
  /** Optional override for tests and clients with a native external-link handler. */
  readonly openAuthorizationUrl?: (url: string) => Promise<void> | void;
}

export type ClaudeReauthenticationDialogState =
  | { readonly phase: "starting"; readonly attempt?: ClaudeReauthenticationAttempt }
  | {
      readonly phase: "waiting" | "submitting";
      readonly attempt: ClaudeReauthenticationAttempt;
    }
  | { readonly phase: "success" }
  | {
      readonly phase: "failure";
      readonly message: string;
      readonly attempt?: ClaudeReauthenticationAttempt;
    };

type DialogState = ClaudeReauthenticationDialogState;

const INITIAL_STATE: DialogState = { phase: "starting" };

const STATUS_POLL_INTERVAL_MS = 1_000;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

async function openAuthorizationUrl(url: string): Promise<void> {
  const localApi = readLocalApi();
  if (localApi !== undefined) {
    await localApi.shell.openExternal(url);
    return;
  }

  // This fallback is only reachable outside the normal browser bootstrap. Keep it tied to the
  // click handler so browsers do not treat it as an unsolicited popup.
  if (typeof window === "undefined") {
    throw new Error("Unable to open Claude sign-in from this client.");
  }
  const openedWindow = window.open(url, "_blank", "noopener,noreferrer");
  if (openedWindow === null) {
    window.location.assign(url);
  }
}

function isActiveAttemptState(
  state: DialogState,
): state is Extract<DialogState, { readonly attempt: ClaudeReauthenticationAttempt }> {
  return state.phase === "waiting" || state.phase === "submitting";
}

function attemptFromState(state: DialogState): ClaudeReauthenticationAttempt | null {
  return "attempt" in state ? (state.attempt ?? null) : null;
}

export function statusFailureMessage(status: ClaudeReauthenticationStatus): string {
  if (status.status === "expired") {
    return "The Claude sign-in attempt expired. Try again.";
  }
  if (status.status === "cancelled") {
    return "The Claude sign-in attempt was cancelled.";
  }
  return status.error ?? "Claude sign-in did not complete.";
}

/** Maps one server status receipt into the UI state without performing side effects. */
export function transitionClaudeReauthenticationState(input: {
  readonly previous: ClaudeReauthenticationDialogState;
  readonly attempt: ClaudeReauthenticationAttempt;
  readonly status: ClaudeReauthenticationStatus;
}): ClaudeReauthenticationDialogState {
  const nextAttempt = {
    ...input.attempt,
    authorizationUrl: input.status.authorizationUrl ?? input.attempt.authorizationUrl,
  };

  switch (input.status.status) {
    case "succeeded":
      return { phase: "success" };
    case "failed":
    case "cancelled":
    case "expired":
      return {
        phase: "failure",
        message: statusFailureMessage(input.status),
        ...(nextAttempt.authorizationUrl === null ? {} : { attempt: nextAttempt }),
      };
    case "starting":
      return input.previous.phase === "submitting"
        ? { phase: "submitting", attempt: nextAttempt }
        : { phase: "starting", attempt: nextAttempt };
    case "awaiting_code":
      if (nextAttempt.authorizationUrl === null) {
        return input.previous.phase === "submitting"
          ? { phase: "submitting", attempt: nextAttempt }
          : { phase: "starting", attempt: nextAttempt };
      }
      return input.previous.phase === "submitting"
        ? { phase: "submitting", attempt: nextAttempt }
        : { phase: "waiting", attempt: nextAttempt };
  }
}

/**
 * Presents the interactive half of Claude's headless login flow. The process and attempt state
 * remain on the server; this component only owns the short-lived form state and client actions.
 */
export function ClaudeReauthenticationDialog({
  open,
  onOpenChange,
  request,
  actions,
  resolved = false,
  onSuccess,
  openAuthorizationUrl: openAuthorizationUrlProp = openAuthorizationUrl,
}: ClaudeReauthenticationDialogProps) {
  const [state, setState] = useState<DialogState>(INITIAL_STATE);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [openUrlError, setOpenUrlError] = useState<string | null>(null);
  const stateRef = useRef<DialogState>(INITIAL_STATE);
  const actionsRef = useRef(actions);
  const requestRef = useRef(request);
  const onSuccessRef = useRef(onSuccess);
  const activeAttemptIdRef = useRef<ServerProviderReauthenticateAttemptId | null>(null);
  const attemptGenerationRef = useRef(0);
  const openRef = useRef(open);
  const startedForOpenRef = useRef(false);
  const completedAttemptIdRef = useRef<ServerProviderReauthenticateAttemptId | null>(null);
  const pollingCleanupRef = useRef<(() => void) | null>(null);

  actionsRef.current = actions;
  requestRef.current = request;
  onSuccessRef.current = onSuccess;
  openRef.current = open;
  stateRef.current = state;

  const stopPolling = useCallback(() => {
    pollingCleanupRef.current?.();
    pollingCleanupRef.current = null;
  }, []);

  const finishSuccess = useCallback(
    (attemptId: ServerProviderReauthenticateAttemptId) => {
      if (completedAttemptIdRef.current === attemptId) return;
      completedAttemptIdRef.current = attemptId;
      activeAttemptIdRef.current = null;
      stopPolling();
      setState({ phase: "success" });
      const callback = onSuccessRef.current;
      if (callback === undefined) return;
      void Promise.resolve(callback()).catch((error: unknown) => {
        setState({
          phase: "failure",
          message: errorMessage(
            error,
            "Claude was authenticated, but the task could not continue.",
          ),
        });
      });
    },
    [stopPolling],
  );

  const startPolling = useCallback(
    (attempt: ClaudeReauthenticationAttempt, generation: number) => {
      stopPolling();
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const stop = () => {
        stopped = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      pollingCleanupRef.current = stop;

      const poll = async () => {
        if (stopped || !openRef.current || generation !== attemptGenerationRef.current) return;
        try {
          const status = await actionsRef.current.getStatus({ attemptId: attempt.attemptId });
          if (stopped || !openRef.current || generation !== attemptGenerationRef.current) return;
          const nextState = transitionClaudeReauthenticationState({
            previous: stateRef.current,
            attempt,
            status,
          });
          if (nextState.phase === "success") {
            stopPolling();
            finishSuccess(attempt.attemptId);
            return;
          }
          if (nextState.phase === "failure") {
            stopPolling();
            activeAttemptIdRef.current = null;
            setState(nextState);
            return;
          }
          setState(nextState);
          timer = setTimeout(() => void poll(), STATUS_POLL_INTERVAL_MS);
        } catch (error: unknown) {
          if (stopped || !openRef.current || generation !== attemptGenerationRef.current) return;
          stopPolling();
          setState({
            phase: "failure",
            message: errorMessage(error, "Could not read Claude sign-in status."),
            ...(attempt.authorizationUrl === null ? {} : { attempt }),
          });
        }
      };

      void poll();
    },
    [finishSuccess, stopPolling],
  );

  useEffect(() => {
    if (!open) return;

    if (startedForOpenRef.current) return;
    startedForOpenRef.current = true;

    const generation = attemptGenerationRef.current + 1;
    attemptGenerationRef.current = generation;
    activeAttemptIdRef.current = null;
    completedAttemptIdRef.current = null;
    setCode("");
    setCodeError(null);
    setOpenUrlError(null);
    setState({ phase: "starting" });

    let cancelled = false;
    const requestForAttempt = requestRef.current;
    // Defer the process start past React Strict Mode's setup/cleanup replay so
    // development mounts do not create an attempt that the replay immediately cancels.
    queueMicrotask(() => {
      if (cancelled || !openRef.current || generation !== attemptGenerationRef.current) return;
      void actionsRef.current.begin(requestForAttempt).then(
        (attempt) => {
          if (cancelled || !openRef.current || generation !== attemptGenerationRef.current) {
            void actionsRef.current
              .cancel({ ...requestForAttempt, attemptId: attempt.attemptId })
              .catch(() => undefined);
            return;
          }
          if (attempt.attemptId.trim().length === 0) {
            setState({ phase: "failure", message: "Claude did not return a sign-in attempt." });
            return;
          }
          const normalizedAttempt = {
            ...attempt,
            authorizationUrl: attempt.authorizationUrl?.trim() || null,
          };
          activeAttemptIdRef.current = normalizedAttempt.attemptId;
          setState(
            normalizedAttempt.authorizationUrl === null
              ? { phase: "starting", attempt: normalizedAttempt }
              : { phase: "waiting", attempt: normalizedAttempt },
          );
          startPolling(normalizedAttempt, generation);
        },
        (error: unknown) => {
          if (cancelled || !openRef.current || generation !== attemptGenerationRef.current) return;
          setState({
            phase: "failure",
            message: errorMessage(error, "Could not start Claude sign-in."),
          });
        },
      );
    });

    return () => {
      cancelled = true;
      startedForOpenRef.current = false;
      attemptGenerationRef.current += 1;
      const attemptId = activeAttemptIdRef.current;
      activeAttemptIdRef.current = null;
      stopPolling();
      if (attemptId !== null) {
        void actionsRef.current.cancel({ ...requestForAttempt, attemptId }).catch(() => undefined);
      }
    };
  }, [open, startPolling, stopPolling]);

  useEffect(() => {
    if (open) return;
    startedForOpenRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!open || !resolved) return;
    const attempt = attemptFromState(state);
    if (attempt === null) return;
    const attemptId = attempt.attemptId;
    finishSuccess(attemptId);
  }, [finishSuccess, open, resolved, state]);

  const close = useCallback(() => {
    const attemptId = activeAttemptIdRef.current;
    attemptGenerationRef.current += 1;
    activeAttemptIdRef.current = null;
    stopPolling();
    if (attemptId !== null) {
      void actionsRef.current.cancel({ ...requestRef.current, attemptId }).catch(() => undefined);
    }
    startedForOpenRef.current = false;
    onOpenChange(false);
  }, [onOpenChange, stopPolling]);

  const handleSubmitCode = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!isActiveAttemptState(state) || state.phase === "submitting") return;
      const attemptId = state.attempt.attemptId;
      const trimmedCode = code.trim();
      if (trimmedCode.length === 0) {
        setCodeError("Paste the code from Claude's browser sign-in page.");
        return;
      }
      setCodeError(null);
      setState({ phase: "submitting", attempt: state.attempt });
      try {
        const status = await actionsRef.current.submitCode({
          ...requestRef.current,
          attemptId,
          code: trimmedCode,
        });
        if (status.status === "succeeded") {
          finishSuccess(attemptId);
          return;
        }
        if (
          status.status === "failed" ||
          status.status === "cancelled" ||
          status.status === "expired"
        ) {
          stopPolling();
          activeAttemptIdRef.current = null;
          setState(
            transitionClaudeReauthenticationState({
              previous: state,
              attempt: state.attempt,
              status,
            }),
          );
          return;
        }
        const nextState = transitionClaudeReauthenticationState({
          previous: state,
          attempt: state.attempt,
          status,
        });
        setState(nextState);
      } catch (error: unknown) {
        stopPolling();
        setState({
          phase: "failure",
          message: errorMessage(error, "Claude sign-in did not complete."),
          attempt: state.attempt,
        });
      }
    },
    [code, finishSuccess, state, stopPolling],
  );

  const handleOpenAuthorizationUrl = useCallback(async () => {
    const attempt = attemptFromState(state);
    if (attempt === null || attempt.authorizationUrl === null) return;
    setOpenUrlError(null);
    try {
      await openAuthorizationUrlProp(attempt.authorizationUrl);
    } catch (error: unknown) {
      setOpenUrlError(errorMessage(error, "Could not open Claude sign-in."));
    }
  }, [openAuthorizationUrlProp, state]);

  const isStarting = state.phase === "starting";
  const isSubmitting = state.phase === "submitting";
  const canRetry = state.phase === "failure";
  const attempt = attemptFromState(state);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reauthenticate Claude</DialogTitle>
          <DialogDescription>
            Sign in to Claude on the machine running this environment. T3 will continue the task
            after authentication succeeds.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          {isStarting && attempt === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner className="size-4" />
              Starting Claude sign-in…
            </div>
          ) : null}

          {attempt ? (
            <div className="space-y-3">
              {attempt.authorizationUrl === null ? (
                <div
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                  role="status"
                >
                  <Spinner className="size-4" />
                  Waiting for Claude sign-in URL…
                </div>
              ) : (
                <>
                  <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
                    <p className="text-xs font-medium text-foreground">Claude sign-in URL</p>
                    <p className="mt-1 max-h-16 overflow-auto break-all font-mono text-[11px] text-muted-foreground select-all">
                      {attempt.authorizationUrl}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => void handleOpenAuthorizationUrl()}
                    disabled={isSubmitting}
                  >
                    Open Claude sign-in
                  </Button>
                </>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                Complete sign-in in your browser. If Claude shows a code instead, paste it below.
              </p>
            </div>
          ) : null}

          {isActiveAttemptState(state) ? (
            <form
              id="claude-reauthentication-form"
              className="space-y-2"
              onSubmit={(event) => void handleSubmitCode(event)}
            >
              <label className="grid gap-1.5" htmlFor="claude-reauthentication-code">
                <span className="text-xs font-medium text-foreground">Paste code if prompted</span>
                <Input
                  id="claude-reauthentication-code"
                  autoComplete="one-time-code"
                  placeholder="Paste the Claude authorization code"
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value);
                    setCodeError(null);
                  }}
                  disabled={isSubmitting}
                  aria-invalid={codeError !== null || undefined}
                />
              </label>
              {codeError ? <p className="text-destructive text-xs">{codeError}</p> : null}
              {isSubmitting ? (
                <div
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                  role="status"
                >
                  <Spinner className="size-3.5" />
                  Finishing Claude sign-in…
                </div>
              ) : null}
            </form>
          ) : null}

          {state.phase === "success" ? (
            <div
              className="rounded-xl border border-success/30 bg-success/8 p-3 text-sm text-success-foreground"
              role="status"
            >
              Claude is authenticated. Resuming your task…
            </div>
          ) : null}

          {state.phase === "failure" ? (
            <p className="text-destructive text-sm" role="alert">
              {state.message}
            </p>
          ) : null}
          {openUrlError ? (
            <p className="text-destructive text-xs" role="alert">
              {openUrlError}
            </p>
          ) : null}
        </DialogPanel>

        <DialogFooter>
          {state.phase === "success" ? (
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              {canRetry ? (
                <Button
                  type="button"
                  onClick={() => {
                    close();
                    window.requestAnimationFrame(() => onOpenChange(true));
                  }}
                >
                  Try again
                </Button>
              ) : null}
              {isActiveAttemptState(state) ? (
                <Button
                  type="submit"
                  form="claude-reauthentication-form"
                  disabled={isSubmitting || code.trim().length === 0}
                >
                  {isSubmitting ? "Signing in…" : "Submit code"}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
