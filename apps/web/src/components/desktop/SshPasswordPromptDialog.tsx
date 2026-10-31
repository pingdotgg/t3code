import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { KeyRoundIcon, TimerIcon } from "lucide-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { useId, useRef, useState, useSyncExternalStore } from "react";

import { useDeadlinePassed } from "../../hooks/useDeadline";
import { useNowSecond } from "../../hooks/useNowSecond";

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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { SubmitKbd } from "../SubmitKbd";
import { Label } from "../ui/label";

function describeSshTarget(request: DesktopSshPasswordPromptRequest): string {
  return request.username ? `${request.username}@${request.destination}` : request.destination;
}

/** SSH's own prompt when it asks for something other than a password, like a passphrase. */
function describeSshPrompt(prompt: string): string {
  return /password:?\s*$/i.test(prompt.trim()) ? "Password" : prompt.trim();
}

function formatRemainingSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function getPromptErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "SSH verification prompt failed.";
  return message.includes("expired") || message.includes("no longer pending")
    ? "This SSH verification prompt expired. Try connecting again."
    : message;
}

let promptQueue: readonly DesktopSshPasswordPromptRequest[] = [];
const promptQueueListeners = new Set<() => void>();

function setPromptQueue(next: readonly DesktopSshPasswordPromptRequest[]) {
  promptQueue = next;
  for (const listener of promptQueueListeners) listener();
}

/**
 * Queues the desktop's SSH password prompts for the life of the page, so a prompt
 * that arrives while no dialog is mounted still waits for one.
 */
export function startSshPasswordPromptQueue(): () => void {
  return (
    window.desktopBridge?.onSshPasswordPrompt((request) => {
      setPromptQueue([...promptQueue, request]);
    }) ?? (() => undefined)
  );
}

function subscribePromptQueue(listener: () => void): () => void {
  promptQueueListeners.add(listener);
  return () => {
    promptQueueListeners.delete(listener);
  };
}

const readPromptQueue = () => promptQueue;

function removeSshPasswordPrompt(requestId: string) {
  if (promptQueue[0]?.requestId === requestId) setPromptQueue(promptQueue.slice(1));
}

export function SshPasswordPromptDialog() {
  const queue = useSyncExternalStore(subscribePromptQueue, readPromptQueue, readPromptQueue);
  const currentRequest = queue[0] ?? null;

  if (!currentRequest) {
    return null;
  }

  return <ActiveSshPasswordPrompt key={currentRequest.requestId} request={currentRequest} />;
}

function ActiveSshPasswordPrompt({
  request,
}: {
  readonly request: DesktopSshPasswordPromptRequest;
}) {
  const [password, setPassword] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isRespondingRef = useRef(false);
  const formId = useId();

  const expiresAtMs = Date.parse(request.expiresAt);
  const now = useNowSecond();
  const isExpired = useDeadlinePassed(Number.isFinite(expiresAtMs) ? expiresAtMs : null);
  const remainingMs = Number.isFinite(expiresAtMs)
    ? isExpired
      ? 0
      : Math.max(0, expiresAtMs - now)
    : null;
  const remainingSeconds = remainingMs === null ? null : Math.ceil(remainingMs / 1_000);
  const remainingLabel =
    remainingSeconds === null ? null : formatRemainingSeconds(remainingSeconds);

  const respond = async (nextPassword: string | null) => {
    if (isRespondingRef.current) {
      return;
    }

    const requestId = request.requestId;
    if (nextPassword !== null && isExpired) {
      setResponseError("This SSH verification prompt expired. Try connecting again.");
      return;
    }

    isRespondingRef.current = true;
    setIsResponding(true);
    setResponseError(null);
    const result = await settlePromise(async () =>
      window.desktopBridge?.resolveSshPasswordPrompt(requestId, nextPassword),
    );
    if (AsyncResult.isSuccess(result) || nextPassword === null) {
      removeSshPasswordPrompt(requestId);
    } else {
      setResponseError(getPromptErrorMessage(Cause.squash(result.cause)));
    }
    isRespondingRef.current = false;
    setIsResponding(false);
  };

  const dismissExpiredPrompt = () => {
    removeSshPasswordPrompt(request.requestId);
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
      <DialogPopup className="max-w-100" initialFocus={inputRef} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>SSH verification required</DialogTitle>
          <DialogDescription>
            Enter the password or verification code required by <code>{target}</code>. T3 Code
            passes your response to the local SSH process and keeps it in memory to reuse for this
            host. T3 Code does not write it to disk.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <form
            className="space-y-3"
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void respond(password);
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-password`}>{describeSshPrompt(request.prompt)}</Label>
              <InputGroup>
                <InputGroupAddon>
                  <KeyRoundIcon />
                </InputGroupAddon>
                <InputGroupInput
                  ref={inputRef}
                  id={`${formId}-password`}
                  autoComplete="current-password"
                  disabled={isResponding || isExpired}
                  name="ssh-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </InputGroup>
            </div>
            {remainingLabel ? (
              <p
                className={
                  isExpired
                    ? "flex items-center gap-1.5 text-destructive text-meta"
                    : "flex items-center gap-1.5 text-dim-foreground text-meta"
                }
              >
                <TimerIcon aria-hidden className="size-3 shrink-0" />
                {isExpired ? "Expired. Try connecting again." : `Expires in ${remainingLabel}`}
              </p>
            ) : null}
            {responseError && !isExpired ? (
              <p className="text-body text-destructive">{responseError}</p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button disabled={isResponding} type="button" variant="secondary" onClick={cancelPrompt}>
            {isExpired ? "Dismiss" : "Cancel"}
          </Button>
          <Button disabled={isResponding || isExpired} form={formId} type="submit">
            Connect
            <SubmitKbd />
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
