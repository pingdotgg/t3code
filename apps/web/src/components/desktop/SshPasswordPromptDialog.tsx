import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { useEffect, useId, useRef, useState } from "react";

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

export function SshPasswordPromptDialog() {
  const [queue, setQueue] = useState<readonly DesktopSshPasswordPromptRequest[]>([]);
  const currentRequest = queue[0] ?? null;

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onSshPasswordPrompt) {
      return;
    }

    return bridge.onSshPasswordPrompt((request) => {
      setQueue((currentQueue) => [...currentQueue, request]);
    });
  }, []);

  if (!currentRequest) {
    return null;
  }

  return (
    <ActiveSshPasswordPrompt
      key={currentRequest.requestId}
      request={currentRequest}
      onRemove={(requestId) => {
        setQueue((currentQueue) =>
          currentQueue[0]?.requestId === requestId ? currentQueue.slice(1) : currentQueue,
        );
      }}
    />
  );
}

function ActiveSshPasswordPrompt({
  request,
  onRemove,
}: {
  readonly request: DesktopSshPasswordPromptRequest;
  readonly onRemove: (requestId: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [now, setNow] = useState(() => Date.now());
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

  const expiresAtMs = Date.parse(request.expiresAt);
  const remainingMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - now) : null;
  const isExpired = remainingMs !== null && remainingMs <= 0;
  const remainingSeconds = remainingMs === null ? null : Math.ceil(remainingMs / 1_000);
  const remainingLabel =
    remainingSeconds === null ? null : formatRemainingSeconds(remainingSeconds);
  const visibleResponseError = isExpired
    ? "This SSH password prompt expired. Try connecting again."
    : responseError;

  const respond = async (nextPassword: string | null) => {
    if (isRespondingRef.current) {
      return;
    }

    const requestId = request.requestId;
    if (nextPassword !== null && isExpired) {
      setResponseError("This SSH password prompt expired. Try connecting again.");
      return;
    }

    isRespondingRef.current = true;
    setIsResponding(true);
    setResponseError(null);
    try {
      await window.desktopBridge?.resolveSshPasswordPrompt(requestId, nextPassword);
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

  const dismissExpiredPrompt = () => {
    onRemove(request.requestId);
  };

  const cancelPrompt = () => {
    if (isExpired) {
      dismissExpiredPrompt();
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
          <DialogTitle>SSH Password Required</DialogTitle>
          <DialogDescription>
            T3 needs your SSH password to connect to <code>{target}</code>. The password is passed
            to the local SSH process for this connection attempt and is not saved by T3 Code.
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
