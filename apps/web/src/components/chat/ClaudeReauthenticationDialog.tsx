"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderReauthenticateAttemptId,
  ServerProviderReauthenticateStatusResult,
  ThreadId,
} from "@t3tools/contracts";
import { CircleAlertIcon } from "lucide-react";

import { readLocalApi } from "../../localApi";
import { Alert, AlertDescription } from "../ui/alert";
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

/** Status fields are deliberately complete so a successful login cannot hide a failed retry. */
export type ClaudeReauthenticationStatus = Pick<
  ServerProviderReauthenticateStatusResult,
  "status" | "authorizationUrl" | "error" | "continuation" | "continuationError"
>;

export interface ClaudeReauthenticationStatusInput extends ClaudeReauthenticationRequest {
  readonly attemptId: ServerProviderReauthenticateAttemptId;
}

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
  readonly getStatus: (
    input: ClaudeReauthenticationStatusInput,
  ) => Promise<ClaudeReauthenticationStatus>;
}

export interface ClaudeReauthenticationDialogProps {
  readonly open: boolean;
  readonly request: ClaudeReauthenticationRequest;
  readonly onOpenChange: (open: boolean) => void;
  readonly actions: ClaudeReauthenticationActions;
  /** Optional override for tests and clients with a native external-link handler. */
  readonly openAuthorizationUrl?: (url: string) => Promise<void> | void;
}

export type ClaudeReauthenticationDialogState =
  | { readonly phase: "starting"; readonly attempt?: ClaudeReauthenticationAttempt }
  | {
      readonly phase: "waiting" | "submitting";
      readonly attempt: ClaudeReauthenticationAttempt;
    }
  | {
      readonly phase: "success";
      readonly continuation: ServerProviderReauthenticateStatusResult["continuation"];
      readonly continuationError: string | null;
    }
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
  window.open(url, "_blank", "noopener,noreferrer");
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

/** The authentication result and the failed task's continuation are separate outcomes. */
export function taskContinuationMessage(
  continuation: ServerProviderReauthenticateStatusResult["continuation"],
  continuationError: string | null,
): string {
  switch (continuation) {
    case "resumed":
      return "Task resumed.";
    case "skipped":
      return "Task was not resumed. Send your message again.";
    case "failed":
      return continuationError ?? "Task could not be resumed. Send your message again.";
    case null:
      return "T3 could not confirm whether the task resumed. Send your message again if needed.";
  }
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
      return {
        phase: "success",
        continuation: input.status.continuation,
        continuationError: input.status.continuationError,
      };
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
  openAuthorizationUrl: openAuthorizationUrlProp = openAuthorizationUrl,
}: ClaudeReauthenticationDialogProps) {
  const [state, setState] = useState<DialogState>(INITIAL_STATE);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [openUrlError, setOpenUrlError] = useState<string | null>(null);
  const stateRef = useRef<DialogState>(INITIAL_STATE);
  const actionsRef = useRef(actions);
  const requestRef = useRef(request);
  const activeRequestRef = useRef<ClaudeReauthenticationRequest | null>(null);
  const activeAttemptIdRef = useRef<ServerProviderReauthenticateAttemptId | null>(null);
  const attemptGenerationRef = useRef(0);
  const openRef = useRef(open);
  const startedForOpenRef = useRef(false);
  const beginInFlightRef = useRef(false);
  const pendingBeginRef = useRef<Promise<ClaudeReauthenticationBeginResult> | null>(null);
  const cancellationByAttemptRef = useRef(new Map<string, Promise<void>>());
  const cancellationBarrierRef = useRef(Promise.resolve());
  const pollingCleanupRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    actionsRef.current = actions;
    requestRef.current = request;
    openRef.current = open;
  }, [actions, request, open]);

  const updateState = useCallback((next: DialogState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopPolling = useCallback(() => {
    pollingCleanupRef.current?.();
    pollingCleanupRef.current = null;
  }, []);

  const cancelAttempt = useCallback(
    (
      requestForAttempt: ClaudeReauthenticationRequest,
      attemptId: ServerProviderReauthenticateAttemptId,
    ) => {
      const key = String(attemptId);
      const existing = cancellationByAttemptRef.current.get(key);
      if (existing !== undefined) return existing;

      const cancellation = actionsRef.current.cancel({ ...requestForAttempt, attemptId }).then(
        () => undefined,
        () => undefined,
      );
      cancellationByAttemptRef.current.set(key, cancellation);
      void cancellation.then(() => {
        if (cancellationByAttemptRef.current.get(key) === cancellation) {
          cancellationByAttemptRef.current.delete(key);
        }
      });
      return cancellation;
    },
    [],
  );

  const cancelActiveAttempt = useCallback((): Promise<void> => {
    const currentAttemptId = activeAttemptIdRef.current;
    const requestForAttempt = activeRequestRef.current;
    const pendingBegin = pendingBeginRef.current;
    activeAttemptIdRef.current = null;
    activeRequestRef.current = null;
    stopPolling();

    const cancellations: Array<Promise<void>> = [];
    if (currentAttemptId !== null && requestForAttempt !== null) {
      cancellations.push(cancelAttempt(requestForAttempt, currentAttemptId));
    }
    if (pendingBegin !== null && requestForAttempt !== null) {
      cancellations.push(
        pendingBegin.then(
          (attempt) =>
            attempt.attemptId.trim().length === 0
              ? undefined
              : cancelAttempt(requestForAttempt, attempt.attemptId),
          () => undefined,
        ),
      );
    }
    return Promise.all(cancellations).then(() => undefined);
  }, [cancelAttempt, stopPolling]);

  const invalidateAttempt = useCallback(() => {
    attemptGenerationRef.current += 1;
    startedForOpenRef.current = false;
    const cancellation = Promise.all([cancellationBarrierRef.current, cancelActiveAttempt()]).then(
      () => undefined,
    );
    cancellationBarrierRef.current = cancellation;
    return cancellation;
  }, [cancelActiveAttempt]);

  const isCurrentAttempt = useCallback(
    (generation: number, attemptId: ServerProviderReauthenticateAttemptId) =>
      openRef.current &&
      generation === attemptGenerationRef.current &&
      activeAttemptIdRef.current === attemptId,
    [],
  );

  const finishSuccess = useCallback(
    (
      generation: number,
      attemptId: ServerProviderReauthenticateAttemptId,
      status: ClaudeReauthenticationStatus,
    ) => {
      if (!isCurrentAttempt(generation, attemptId) || status.status !== "succeeded") return;
      setOpenUrlError(null);
      activeAttemptIdRef.current = null;
      activeRequestRef.current = null;
      stopPolling();
      updateState({
        phase: "success",
        continuation: status.continuation,
        continuationError: status.continuationError,
      });
    },
    [isCurrentAttempt, stopPolling, updateState],
  );

  const startPolling = useCallback(
    (
      attempt: ClaudeReauthenticationAttempt,
      requestForAttempt: ClaudeReauthenticationRequest,
      generation: number,
    ) => {
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
        if (stopped || !isCurrentAttempt(generation, attempt.attemptId)) return;
        try {
          const status = await actionsRef.current.getStatus({
            ...requestForAttempt,
            attemptId: attempt.attemptId,
          });
          if (stopped || !isCurrentAttempt(generation, attempt.attemptId)) return;
          const nextState = transitionClaudeReauthenticationState({
            previous: stateRef.current,
            attempt,
            status,
          });
          if (nextState.phase === "success") {
            finishSuccess(generation, attempt.attemptId, status);
            return;
          }
          if (nextState.phase === "failure") {
            stopPolling();
            activeAttemptIdRef.current = null;
            activeRequestRef.current = null;
            updateState(nextState);
            return;
          }
          updateState(nextState);
          timer = setTimeout(() => void poll(), STATUS_POLL_INTERVAL_MS);
        } catch (error: unknown) {
          if (stopped || !isCurrentAttempt(generation, attempt.attemptId)) return;
          stopPolling();
          updateState({
            phase: "failure",
            message: errorMessage(error, "Could not read Claude sign-in status."),
            ...(attempt.authorizationUrl === null ? {} : { attempt }),
          });
        }
      };

      void poll();
    },
    [finishSuccess, isCurrentAttempt, stopPolling, updateState],
  );

  const startAttempt = useCallback(() => {
    if (!openRef.current || beginInFlightRef.current) return;

    const generation = ++attemptGenerationRef.current;
    const requestForAttempt = requestRef.current;
    activeRequestRef.current = requestForAttempt;
    activeAttemptIdRef.current = null;
    beginInFlightRef.current = true;
    setCode("");
    setCodeError(null);
    setOpenUrlError(null);
    updateState(INITIAL_STATE);

    const beginPromise = actionsRef.current.begin(requestForAttempt);
    pendingBeginRef.current = beginPromise;
    void beginPromise
      .then(
        (result) => {
          if (!openRef.current || generation !== attemptGenerationRef.current) {
            if (result.attemptId.trim().length > 0) {
              void cancelAttempt(requestForAttempt, result.attemptId);
            }
            return;
          }
          if (result.attemptId.trim().length === 0) {
            activeRequestRef.current = null;
            updateState({ phase: "failure", message: "Claude did not return a sign-in attempt." });
            return;
          }
          const normalizedAttempt = {
            ...result,
            authorizationUrl: result.authorizationUrl?.trim() || null,
          };
          activeAttemptIdRef.current = normalizedAttempt.attemptId;
          updateState(
            normalizedAttempt.authorizationUrl === null
              ? { phase: "starting", attempt: normalizedAttempt }
              : { phase: "waiting", attempt: normalizedAttempt },
          );
          startPolling(normalizedAttempt, requestForAttempt, generation);
        },
        (error: unknown) => {
          if (!openRef.current || generation !== attemptGenerationRef.current) return;
          activeAttemptIdRef.current = null;
          activeRequestRef.current = null;
          updateState({
            phase: "failure",
            message: errorMessage(error, "Could not start Claude sign-in."),
          });
        },
      )
      .finally(() => {
        beginInFlightRef.current = false;
        if (pendingBeginRef.current === beginPromise) pendingBeginRef.current = null;
      });
  }, [cancelAttempt, startPolling, updateState]);

  useEffect(() => {
    openRef.current = open;
    if (!open) {
      startedForOpenRef.current = false;
      void invalidateAttempt();
      return;
    }
    if (startedForOpenRef.current) return;
    startedForOpenRef.current = true;
    let cancelled = false;
    // Defer startup past Strict Mode's setup/cleanup replay so development mounts do not create an
    // attempt that the replay immediately cancels.
    queueMicrotask(() => {
      void cancellationBarrierRef.current.then(() => {
        if (!cancelled && openRef.current) startAttempt();
      });
    });
    return () => {
      cancelled = true;
      if (openRef.current) {
        openRef.current = false;
        void invalidateAttempt();
      }
    };
  }, [invalidateAttempt, open, startAttempt]);

  const close = useCallback(() => {
    openRef.current = false;
    void invalidateAttempt();
    onOpenChange(false);
  }, [invalidateAttempt, onOpenChange]);

  const retry = useCallback(async () => {
    if (stateRef.current.phase !== "failure") return;
    const cancellation = invalidateAttempt();
    setCode("");
    setCodeError(null);
    setOpenUrlError(null);
    updateState(INITIAL_STATE);
    await cancellation;
    if (openRef.current) startAttempt();
  }, [invalidateAttempt, startAttempt, updateState]);

  const handleSubmitCode = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!isActiveAttemptState(state) || state.phase === "submitting") return;
      const attemptId = state.attempt.attemptId;
      const generation = attemptGenerationRef.current;
      const requestForAttempt = activeRequestRef.current;
      if (requestForAttempt === null || activeAttemptIdRef.current !== attemptId) return;
      const trimmedCode = code.trim();
      if (trimmedCode.length === 0) {
        setCodeError("Paste the code from Claude's browser sign-in page.");
        return;
      }
      setCodeError(null);
      updateState({ phase: "submitting", attempt: state.attempt });
      try {
        const status = await actionsRef.current.submitCode({
          ...requestForAttempt,
          attemptId,
          code: trimmedCode,
        });
        if (!isCurrentAttempt(generation, attemptId)) return;
        const nextState = transitionClaudeReauthenticationState({
          previous: stateRef.current,
          attempt: state.attempt,
          status,
        });
        if (nextState.phase === "success") {
          finishSuccess(generation, attemptId, status);
        } else if (nextState.phase === "failure") {
          stopPolling();
          activeAttemptIdRef.current = null;
          activeRequestRef.current = null;
          updateState(nextState);
        } else {
          updateState(nextState);
        }
      } catch (error: unknown) {
        if (!isCurrentAttempt(generation, attemptId)) return;
        stopPolling();
        updateState({
          phase: "failure",
          message: errorMessage(error, "Claude sign-in did not complete."),
          attempt: state.attempt,
        });
      }
    },
    [code, finishSuccess, isCurrentAttempt, state, stopPolling, updateState],
  );

  const handleOpenAuthorizationUrl = useCallback(async () => {
    const attempt = attemptFromState(state);
    const requestForAttempt = activeRequestRef.current;
    const generation = attemptGenerationRef.current;
    if (
      attempt === null ||
      attempt.authorizationUrl === null ||
      requestForAttempt === null ||
      !isCurrentAttempt(generation, attempt.attemptId)
    ) {
      return;
    }
    setOpenUrlError(null);
    try {
      await openAuthorizationUrlProp(attempt.authorizationUrl);
      if (!isCurrentAttempt(generation, attempt.attemptId)) return;
    } catch (error: unknown) {
      if (!isCurrentAttempt(generation, attempt.attemptId)) return;
      setOpenUrlError(errorMessage(error, "Could not open Claude sign-in."));
    }
  }, [isCurrentAttempt, openAuthorizationUrlProp, state]);

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
            Sign in to Claude on the machine running this environment. T3 will report separately
            whether the failed task resumed.
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
            <Alert
              variant="success"
              data-reauthentication-outcome={state.continuation ?? "unknown"}
            >
              <AlertDescription>
                <p className="font-medium text-foreground">Claude is authenticated.</p>
                <p>{taskContinuationMessage(state.continuation, state.continuationError)}</p>
              </AlertDescription>
            </Alert>
          ) : null}

          {state.phase === "failure" ? (
            <Alert variant="error">
              <CircleAlertIcon />
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          ) : null}
          {openUrlError ? (
            <Alert variant="error">
              <CircleAlertIcon />
              <AlertDescription>{openUrlError}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>

        <DialogFooter>
          {state.phase === "success" ? (
            <Button type="button" onClick={close}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              {canRetry ? (
                <Button type="button" onClick={() => void retry()}>
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
