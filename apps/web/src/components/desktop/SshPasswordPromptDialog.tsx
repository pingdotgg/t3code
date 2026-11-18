import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshPasswordPromptRequest } from "@t3tools/contracts";
import { KeyRoundIcon, TimerIcon } from "lucide-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { msg, T, useGT, Var } from "gt-react";
import { useId, useRef, useState, useSyncExternalStore } from "react";

import { m } from "../../i18n/messages";

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

/** False when SSH asks for something other than a password, like a passphrase; its own prompt shows then. */
function isSshPasswordPrompt(prompt: string): boolean {
  return /password:?\s*$/i.test(prompt.trim());
}

function formatRemainingSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function getPromptErrorMessage(error: unknown): string {
  const message = thrownErrorMessage(error, m) ?? m(msg("SSH verification prompt failed."));
  return message.includes("expired") || message.includes("no longer pending")
    ? m(msg("This SSH verification prompt expired. Try connecting again."))
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
  const bridge = window.desktopBridge;
  if (!bridge) return () => undefined;
  const stopPrompts = bridge.onSshPasswordPrompt((request) => {
    if (promptQueue.some((queued) => queued.requestId === request.requestId)) return;
    setPromptQueue([...promptQueue, request]);
  });
  const stopSettled = bridge.onSshPasswordPromptSettled(removeSshPasswordPrompt);
  return () => {
    stopPrompts();
    stopSettled();
  };
}

function subscribePromptQueue(listener: () => void): () => void {
  promptQueueListeners.add(listener);
  return () => {
    promptQueueListeners.delete(listener);
  };
}

const readPromptQueue = () => promptQueue;

function removeSshPasswordPrompt(requestId: string) {
  if (!promptQueue.some((request) => request.requestId === requestId)) return;
  setPromptQueue(promptQueue.filter((request) => request.requestId !== requestId));
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
  const gt = useGT();
  const [password, setPassword] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isRespondingRef = useRef(false);
  const formId = useId();
  const isPasswordPrompt = isSshPasswordPrompt(request.prompt);

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
      setResponseError(gt("This SSH verification prompt expired. Try connecting again."));
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
          <DialogTitle>
            {isPasswordPrompt ? (
              <T>SSH Password Required</T>
            ) : (
              <T>SSH verification required</T>
            )}
          </DialogTitle>
          <DialogDescription>
            {isPasswordPrompt ? (
              <T>
                <code>
                  <Var>{target}</Var>
                </code>{" "}
                asked for a password to connect.
              </T>
            ) : (
              <T>
                <code>
                  <Var>{target}</Var>
                </code>{" "}
                asked for verification to connect.
              </T>
            )}
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
              <Label htmlFor={`${formId}-password`}>
                {isPasswordPrompt ? gt("Password") : request.prompt.trim()}
              </Label>
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
            <p className="text-caption text-dim-foreground">
              <T>Your response stays in memory for this host and is never written to disk.</T>
            </p>
            {remainingLabel ? (
              <p
                className={
                  isExpired
                    ? "flex items-center gap-1.5 text-destructive text-meta"
                    : "flex items-center gap-1.5 text-dim-foreground text-meta"
                }
              >
                <TimerIcon aria-hidden className="size-3 shrink-0" />
                {isExpired
                  ? gt("Expired. Try connecting again.")
                  : gt("Expires in {duration}", { duration: remainingLabel })}
              </p>
            ) : null}
            {responseError && !isExpired ? (
              <p className="text-body text-destructive">{responseError}</p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button
            size="standard"
            disabled={isResponding}
            type="button"
            variant="secondary"
            onClick={cancelPrompt}
          >
            {isExpired ? gt("Dismiss") : gt("Cancel")}
          </Button>
          <Button size="standard" disabled={isResponding || isExpired} form={formId} type="submit">
            <T>Connect</T>
            <SubmitKbd />
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
