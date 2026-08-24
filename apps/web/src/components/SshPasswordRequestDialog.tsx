import type { SourceControlSshPasswordPromptRequest } from "@t3tools/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { canSubmitSshPassword, getSshPasswordPromptRemainingMs } from "./sshPasswordRequestForm";

export interface SshPasswordPromptRequestPresentation {
  readonly requestId: string;
  readonly destination: string;
  readonly username: string | null;
  readonly prompt: string;
  readonly expiresInMs: number;
  readonly receivedAtMs?: number;
}

export function useSshPasswordRequest() {
  const [prompt, setPrompt] = useState<SourceControlSshPasswordPromptRequest | null>(null);
  const pendingRef = useRef<{
    readonly requestId: string;
    readonly resolve: (password: string | null) => void;
  } | null>(null);

  const request = useCallback(
    (nextPrompt: SourceControlSshPasswordPromptRequest) =>
      new Promise<string | null>((resolve) => {
        pendingRef.current?.resolve(null);
        pendingRef.current = { requestId: nextPrompt.requestId, resolve };
        setPrompt(nextPrompt);
      }),
    [],
  );

  const resolve = useCallback((requestId: string, password: string | null) => {
    const pending = pendingRef.current;
    if (pending?.requestId !== requestId) {
      return;
    }
    pendingRef.current = null;
    setPrompt(null);
    pending.resolve(password);
  }, []);

  const cancel = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setPrompt(null);
    pending?.resolve(null);
  }, []);

  useEffect(() => () => pendingRef.current?.resolve(null), []);

  return { prompt, request, resolve, cancel } as const;
}

function describeSshTarget(request: SshPasswordPromptRequestPresentation): string {
  return request.username ? `${request.username}@${request.destination}` : request.destination;
}

function formatRemainingSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function getPromptErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "SSH password prompt failed.";
  return message.includes("expired") || message.includes("no longer pending")
    ? "This SSH password prompt expired. Try again."
    : message;
}

export function SshPasswordRequestDialog({
  request,
  onRespond,
  onRemove,
}: {
  readonly request: SshPasswordPromptRequestPresentation;
  readonly onRespond: (password: string | null) => Promise<void>;
  readonly onRemove: (requestId: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [mountedAtMs] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAtMs);
  const [responseError, setResponseError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isRespondingRef = useRef(false);
  const formId = useId();

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const remainingMs = getSshPasswordPromptRemainingMs({
    expiresInMs: request.expiresInMs,
    nowMs: now,
    receivedAtMs: request.receivedAtMs ?? mountedAtMs,
  });
  const isExpired = remainingMs <= 0;
  const remainingSeconds = Math.ceil(remainingMs / 1_000);
  const remainingLabel = formatRemainingSeconds(remainingSeconds);
  const visibleResponseError = isExpired
    ? "This SSH password prompt expired. Try again."
    : responseError;
  const canSubmit = canSubmitSshPassword({ password, isResponding, isExpired });

  const respond = async (nextPassword: string | null) => {
    if (isRespondingRef.current) {
      return;
    }

    const requestId = request.requestId;
    if (nextPassword !== null && isExpired) {
      setResponseError("This SSH password prompt expired. Try again.");
      return;
    }

    isRespondingRef.current = true;
    setIsResponding(true);
    setResponseError(null);
    try {
      await onRespond(nextPassword);
      onRemove(requestId);
    } catch (error) {
      if (nextPassword === null) {
        onRemove(requestId);
      } else {
        setResponseError(getPromptErrorMessage(error));
      }
    } finally {
      isRespondingRef.current = false;
      setIsResponding(false);
    }
  };

  const cancelPrompt = () => {
    if (isExpired) {
      onRemove(request.requestId);
      return;
    }
    void respond(null);
  };

  const target = describeSshTarget(request);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          cancelPrompt();
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>SSH Authentication Required</DialogTitle>
          <DialogDescription>
            T3 needs your SSH key passphrase or password to connect to <code>{target}</code>. It is
            passed to the SSH process for this attempt and is not saved by T3 Code.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3" scrollFade={false}>
          <form
            className="space-y-3"
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) {
                void respond(password);
              }
            }}
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">{request.prompt}</p>
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
            {visibleResponseError ? (
              <p className="text-sm text-destructive">{visibleResponseError}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Add the key to your SSH agent to avoid repeated prompts.
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={isResponding} type="button" variant="outline" onClick={cancelPrompt}>
            {isExpired ? "Dismiss" : "Cancel"}
          </Button>
          <Button disabled={!canSubmit} form={formId} type="submit">
            Continue
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
