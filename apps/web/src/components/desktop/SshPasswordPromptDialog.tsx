import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";

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

const EXPIRED_PROMPT_ERROR = "This SSH password prompt expired. Try connecting again.";

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

  const removeCurrentPrompt = useCallback((requestId: string) => {
    setQueue((currentQueue) =>
      currentQueue[0]?.requestId === requestId ? currentQueue.slice(1) : currentQueue,
    );
  }, []);

  return {
    currentRequest: queue[0] ?? null,
    removeCurrentPrompt,
  };
}

function useSshPasswordPromptFocus(
  requestId: string,
  inputRef: RefObject<HTMLInputElement | null>,
) {
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [inputRef, requestId]);
}

function useSshPasswordPromptNow(requestId: string) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [requestId]);

  return now;
}

export function SshPasswordPromptDialog() {
  const { currentRequest, removeCurrentPrompt } = useSshPasswordPromptQueue();

  if (!currentRequest) {
    return null;
  }

  return (
    <SshPasswordPromptRequestDialog
      key={currentRequest.requestId}
      currentRequest={currentRequest}
      removeCurrentPrompt={removeCurrentPrompt}
    />
  );
}

function SshPasswordPromptRequestDialog({
  currentRequest,
  removeCurrentPrompt,
}: {
  currentRequest: DesktopSshPasswordPromptRequest;
  removeCurrentPrompt: (requestId: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isRespondingRef = useRef(false);
  const formId = useId();
  const now = useSshPasswordPromptNow(currentRequest.requestId);
  useSshPasswordPromptFocus(currentRequest.requestId, inputRef);

  const expiresAtMs = Date.parse(currentRequest.expiresAt);
  const remainingMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - now) : null;
  const isExpired = remainingMs !== null && remainingMs <= 0;
  const remainingSeconds = remainingMs === null ? null : Math.ceil(remainingMs / 1_000);
  const remainingLabel =
    remainingSeconds === null ? null : formatRemainingSeconds(remainingSeconds);
  const displayedError = isExpired ? EXPIRED_PROMPT_ERROR : responseError;

  const respond = async (nextPassword: string | null) => {
    if (isRespondingRef.current) {
      return;
    }

    const requestId = currentRequest.requestId;
    if (nextPassword !== null && isExpired) {
      setResponseError(EXPIRED_PROMPT_ERROR);
      return;
    }

    isRespondingRef.current = true;
    setIsResponding(true);
    setResponseError(null);
    try {
      await window.desktopBridge?.resolveSshPasswordPrompt(requestId, nextPassword);
      removeCurrentPrompt(requestId);
    } catch (error) {
      if (nextPassword === null) {
        removeCurrentPrompt(requestId);
      } else {
        setResponseError(getPromptErrorMessage(error));
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
              void respond(password);
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
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {displayedError ? (
              <p className="text-sm text-destructive">{displayedError}</p>
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
