import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
} from "react";

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

function describeSshTarget(request: DesktopSshPasswordPromptRequest): string {
  return request.username ? `${request.username}@${request.destination}` : request.destination;
}

function formatRemainingSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function getPromptErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "SSH password prompt failed.";
  return message.includes("expired") || message.includes("no longer pending")
    ? "This SSH password prompt expired. Try connecting again."
    : message;
}

const EXPIRED_PROMPT_MESSAGE = "This SSH password prompt expired. Try connecting again.";

type PromptDraftState = {
  password: string;
  responseError: string | null;
  now: number;
};

type PromptDraftAction =
  | { type: "prompt.reset"; now: number }
  | { type: "clock.tick"; now: number }
  | { type: "password.set"; password: string }
  | { type: "error.set"; error: string | null };

function promptDraftReducer(state: PromptDraftState, action: PromptDraftAction): PromptDraftState {
  switch (action.type) {
    case "prompt.reset":
      return {
        password: "",
        responseError: null,
        now: action.now,
      };
    case "clock.tick":
      return state.now === action.now ? state : { ...state, now: action.now };
    case "password.set":
      return state.password === action.password ? state : { ...state, password: action.password };
    case "error.set":
      return state.responseError === action.error
        ? state
        : { ...state, responseError: action.error };
  }
}

function useSshPasswordPromptQueue() {
  const [queue, setQueue] = useState<readonly DesktopSshPasswordPromptRequest[]>([]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onSshPasswordPrompt) {
      return;
    }

    return bridge.onSshPasswordPrompt((request) => {
      setQueue((currentQueue) => [...currentQueue, request]);
    });
  }, []);

  return [queue, setQueue] as const;
}

function useCurrentPromptLifecycle(
  currentRequest: DesktopSshPasswordPromptRequest | null,
  inputRef: RefObject<HTMLInputElement | null>,
  dispatch: Dispatch<PromptDraftAction>,
) {
  useEffect(() => {
    dispatch({ type: "prompt.reset", now: Date.now() });
    if (!currentRequest) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [currentRequest, dispatch, inputRef]);

  useEffect(() => {
    if (!currentRequest) {
      return;
    }

    const interval = window.setInterval(() => {
      dispatch({ type: "clock.tick", now: Date.now() });
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [currentRequest, dispatch]);
}

export function SshPasswordPromptDialog() {
  const [queue, setQueue] = useSshPasswordPromptQueue();
  const [isResponding, setIsResponding] = useState(false);
  const [draft, dispatchDraft] = useReducer(promptDraftReducer, undefined, () => ({
    password: "",
    responseError: null,
    now: Date.now(),
  }));
  const currentRequest = queue[0] ?? null;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isRespondingRef = useRef(false);
  const formId = useId();
  useCurrentPromptLifecycle(currentRequest, inputRef, dispatchDraft);

  const expiresAtMs = currentRequest ? Date.parse(currentRequest.expiresAt) : Number.NaN;
  const remainingMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - draft.now) : null;
  const isExpired = remainingMs !== null && remainingMs <= 0;
  const remainingSeconds = remainingMs === null ? null : Math.ceil(remainingMs / 1_000);
  const remainingLabel =
    remainingSeconds === null ? null : formatRemainingSeconds(remainingSeconds);
  const visibleResponseError = isExpired ? EXPIRED_PROMPT_MESSAGE : draft.responseError;

  const removeCurrentPrompt = (requestId: string) => {
    setQueue((currentQueue) =>
      currentQueue[0]?.requestId === requestId ? currentQueue.slice(1) : currentQueue,
    );
    dispatchDraft({ type: "prompt.reset", now: Date.now() });
  };

  const respond = async (nextPassword: string | null) => {
    if (!currentRequest || isRespondingRef.current) {
      return;
    }

    const requestId = currentRequest.requestId;
    if (nextPassword !== null && isExpired) {
      dispatchDraft({ type: "error.set", error: EXPIRED_PROMPT_MESSAGE });
      return;
    }

    isRespondingRef.current = true;
    setIsResponding(true);
    dispatchDraft({ type: "error.set", error: null });
    try {
      await window.desktopBridge?.resolveSshPasswordPrompt(requestId, nextPassword);
      removeCurrentPrompt(requestId);
    } catch (error) {
      if (nextPassword === null) {
        removeCurrentPrompt(requestId);
      } else {
        dispatchDraft({ type: "error.set", error: getPromptErrorMessage(error) });
      }
    } finally {
      isRespondingRef.current = false;
      setIsResponding(false);
    }
  };

  const dismissExpiredPrompt = () => {
    if (currentRequest) {
      removeCurrentPrompt(currentRequest.requestId);
    }
  };

  const cancelPrompt = () => {
    if (isExpired) {
      dismissExpiredPrompt();
      return;
    }
    void respond(null);
  };

  const target = currentRequest ? describeSshTarget(currentRequest) : null;

  return (
    <Dialog
      open={currentRequest !== null}
      onOpenChange={(open) => {
        if (!open) {
          cancelPrompt();
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>SSH Password Required</DialogTitle>
          <DialogDescription>
            T3 needs your SSH password to connect to{" "}
            {target ? <code>{target}</code> : "the remote host"}. The password is passed to the
            local SSH process for this connection attempt and is not saved by T3 Code.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3" scrollFade={false}>
          <form
            className="space-y-3"
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void respond(draft.password);
            }}
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">{currentRequest?.prompt}</p>
                {remainingLabel ? (
                  <span
                    className={
                      isExpired
                        ? "shrink-0 text-xs font-medium text-destructive"
                        : "shrink-0 text-xs text-muted-foreground"
                    }
                  >
                    {isExpired ? "Expired" : remainingLabel}
                  </span>
                ) : null}
              </div>
              <Input
                ref={inputRef}
                autoComplete="current-password"
                disabled={isResponding || isExpired}
                name="ssh-password"
                type="password"
                value={draft.password}
                onChange={(event) =>
                  dispatchDraft({ type: "password.set", password: event.target.value })
                }
              />
            </div>
            {visibleResponseError ? (
              <p className="text-sm text-destructive">{visibleResponseError}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Use SSH keys to avoid repeated password prompts on new SSH sessions.
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={isResponding} type="button" variant="outline" onClick={cancelPrompt}>
            {isExpired ? "Dismiss" : "Cancel"}
          </Button>
          <Button disabled={isResponding || isExpired} form={formId} type="submit">
            Continue
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
