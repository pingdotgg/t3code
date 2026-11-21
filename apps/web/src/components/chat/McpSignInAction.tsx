import type { EnvironmentId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { formatEnvironmentQueryError } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
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
import { toastManager } from "../ui/toast";

type SignIn =
  | { readonly phase: "starting" }
  | { readonly phase: "ready" | "finishing"; readonly url: string }
  | { readonly phase: "failed"; readonly url: string | null; readonly message: string };

const stopRowToggle = (event: KeyboardEvent<HTMLElement>) => event.stopPropagation();

/**
 * Signs an MCP server in from the notice that says it needs one. The agent
 * keeps the credential; the user approves in a browser, then pastes back the
 * address it lands on, which is often a localhost page on another machine.
 */
export function McpSignInAction({
  environmentId,
  threadId,
  providerThreadId,
  server,
  noticeAt,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly server: string;
  /** When the environment raised the notice, in epoch milliseconds. */
  readonly noticeAt: number;
}) {
  const gt = useGT();
  const formId = useId();
  const allowed = useAtomValue(threadEnvironment.mcpSignInStart.permissionAtom(environmentId));
  const signedIn = useAtomValue(
    threadEnvironment.mcpSignedInAtom(environmentId, { threadId, server, noticeAt }),
  );
  const start = useAtomCommand(threadEnvironment.mcpSignInStart, { reportFailure: false });
  const complete = useAtomCommand(threadEnvironment.mcpSignInComplete, { reportFailure: false });
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  // Counts attempts, so a result that lands after a close or a restart changes nothing.
  const attempt = useRef(0);
  if (!allowed) return null;

  const input = { threadId, providerThreadId, server };
  const close = () => {
    attempt.current += 1;
    setSignIn(null);
  };
  const done = () => {
    close();
    toastManager.add({ type: "success", title: gt("Signed in to {server}", { server }) });
  };
  const begin = async () => {
    const current = ++attempt.current;
    setSignIn({ phase: "starting" });
    setCallbackUrl("");
    const result = await start({ environmentId, input });
    if (current !== attempt.current) return;
    if (result._tag === "Failure") {
      setSignIn({ phase: "failed", url: null, message: formatEnvironmentQueryError(result.cause) });
    } else if (result.value.authorizationUrl === null) {
      done();
    } else {
      setSignIn({ phase: "ready", url: result.value.authorizationUrl });
    }
  };
  const finish = async (url: string) => {
    if (callbackUrl.trim().length === 0) return;
    const current = attempt.current;
    setSignIn({ phase: "finishing", url });
    const result = await complete({
      environmentId,
      input: { ...input, callbackUrl: callbackUrl.trim() },
    });
    if (current !== attempt.current) return;
    if (result._tag === "Failure") {
      setSignIn({ phase: "failed", url, message: formatEnvironmentQueryError(result.cause) });
    } else {
      done();
    }
  };
  const url = signIn !== null && signIn.phase !== "starting" ? signIn.url : null;

  return (
    <>
      {signedIn ? (
        <span className="shrink-0 text-sm text-success-foreground">
          <T>Signed in</T>
        </span>
      ) : (
        <InlineButton
          aria-label={gt("Sign in to {server}", { server })}
          onClick={(event) => {
            event.stopPropagation();
            void begin();
          }}
          onKeyDown={stopRowToggle}
        >
          <T>Sign in</T>
        </InlineButton>
      )}
      <Dialog
        open={signIn !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{gt("Sign in to {server}", { server })}</DialogTitle>
            <DialogDescription>
              <T>
                Approve access in your browser. It then opens a page that may not load: copy that
                page's address and paste it here.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {signIn?.phase === "starting" ? (
              <p className="text-sm text-muted-foreground">
                <T>Starting the sign-in…</T>
              </p>
            ) : null}
            {url !== null ? (
              <form
                id={formId}
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void finish(url);
                }}
              >
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void ensureLocalApi().shell.openExternal(url)}
                  >
                    <ExternalLinkIcon aria-hidden />
                    <T>Open sign-in page</T>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => copyToClipboard(url)}>
                    {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
                    <T>Copy link</T>
                  </Button>
                </div>
                <label className="grid gap-1.5 text-sm">
                  <T>Address of the page your browser opened</T>
                  <Input
                    // Browsers can hide `http://`, which the environment adds back.
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    value={callbackUrl}
                    maxLength={16_384}
                    disabled={signIn?.phase === "finishing"}
                    onChange={(event) => setCallbackUrl(event.target.value)}
                  />
                </label>
              </form>
            ) : null}
            {signIn?.phase === "failed" ? (
              <p role="alert" className="mt-3 text-sm text-destructive-foreground">
                {signIn.message}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" onClick={close}>
              <T>Cancel</T>
            </Button>
            {url === null && signIn?.phase === "failed" ? (
              <Button onClick={() => void begin()}>
                <T>Try again</T>
              </Button>
            ) : (
              <Button
                type="submit"
                form={formId}
                disabled={
                  url === null || signIn?.phase === "finishing" || callbackUrl.trim().length === 0
                }
              >
                <T>Finish sign-in</T>
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
