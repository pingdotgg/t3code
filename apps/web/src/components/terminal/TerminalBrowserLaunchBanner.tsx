import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@lathe/client-runtime/state/runtime";
import {
  terminalBrowserLaunchRelayMode,
  type TerminalBrowserLaunch,
} from "@lathe/client-runtime/state/terminal";
import type { ScopedThreadRef } from "@lathe/contracts";
import { useState } from "react";

import { useHostedAuthRelay } from "~/browser/useHostedAuthRelay";
import { useOpenLink } from "~/browser/useOpenLink";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { namedClipboardTarget, writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { terminalEnvironment } from "~/state/terminal";
import { useAtomCommand } from "~/state/use-atom-command";

interface TerminalBrowserLaunchBannerProps {
  readonly threadRef: ScopedThreadRef;
  readonly terminalId: string;
  readonly launch: TerminalBrowserLaunch;
}

/**
 * A terminal command asked the environment to open a page, which it never does; this banner
 * opens it where the user is and carries the sign-in's result back. On desktop the app holds the
 * loopback port itself; elsewhere a query response can still be pasted, and a form POST cannot be
 * relayed at all.
 */
export function TerminalBrowserLaunchBanner({
  threadRef,
  terminalId,
  launch,
}: TerminalBrowserLaunchBannerProps) {
  const commandOptions = { reportFailure: false, reportDefect: false };
  const openLink = useOpenLink(threadRef);
  const complete = useAtomCommand(terminalEnvironment.completeBrowserLaunch, commandOptions);
  const cancel = useAtomCommand(terminalEnvironment.cancelBrowserLaunch, commandOptions);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hosted = useHostedAuthRelay({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    terminalId,
    captureId: launch.captureId,
    redirectUri: launch.redirectUri,
    expiresAt: launch.expiresAt,
  });
  const relayMode = terminalBrowserLaunchRelayMode({
    responseMode: launch.responseMode,
    redirectUri: launch.redirectUri,
    hosted,
  });
  const target = {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, terminalId, captureId: launch.captureId },
  };

  async function run<A, E>(request: () => Promise<AtomCommandResult<A, E>>): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError(null);
    const settled = await settlePromise(request);
    setPending(false);
    if (settled._tag === "Failure") {
      setError("Could not finish sign-in. Try again.");
      return false;
    }
    const result = settled.value;
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not finish sign-in.");
    }
    return false;
  }

  return (
    <div
      role="status"
      className="grid gap-2 border-b border-border/80 bg-background px-3 py-2 text-xs"
      data-terminal-browser-launch={launch.captureId}
    >
      <p className="font-medium">
        A command in this terminal asked to open a page. Press Open to open it in your browser.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            // A hosted listener catches the return itself, so the tab must not
            // be tagged: the tagged navigation never reaches that listener.
            void openLink(
              launch.url,
              relayMode === "hosted"
                ? {}
                : {
                    authRelay: {
                      kind: "terminal",
                      environmentId: threadRef.environmentId,
                      threadId: threadRef.threadId,
                      terminalId,
                      captureId: launch.captureId,
                      redirectUri: launch.redirectUri,
                    },
                  },
            ).catch(() => {
              setError("Could not open the page. Copy the link and open it in your browser.");
            });
          }}
        >
          Open
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            void writeTextToClipboard(launch.url, namedClipboardTarget("sign-in link"))
              .then(() => setCopied(true))
              .catch(() => setError("Could not copy the link."));
          }}
        >
          {copied ? "Link copied" : "Copy link"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() => void run(() => cancel(target))}
        >
          Dismiss
        </Button>
      </div>
      {relayMode === "hosted" ? (
        <p className="text-muted-foreground">
          Sign in there. Lathe returns the result to this terminal on its own, even if you switch
          threads meanwhile.
        </p>
      ) : null}
      {relayMode === "unreachable" ? (
        <p className="text-muted-foreground [overflow-wrap:anywhere]">
          This sign-in posts its result to a page only this computer&apos;s Lathe desktop app can
          catch. Open the link from the desktop app, or use the command&apos;s device-code option if
          it has one.
        </p>
      ) : null}
      {relayMode === "paste" ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = callbackUrl.trim();
            if (!trimmed) return;
            void run(() =>
              complete({ ...target, input: { ...target.input, callbackUrl: trimmed } }),
            ).then((accepted) => {
              if (accepted) setCallbackUrl("");
            });
          }}
        >
          <label htmlFor={`terminal-browser-launch-${launch.captureId}`} className="basis-full">
            If it ends on a 127.0.0.1 or localhost page that will not load, paste that page&apos;s
            full address here.
          </label>
          <Input
            id={`terminal-browser-launch-${launch.captureId}`}
            size="sm"
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:..."
            className="min-w-0 flex-1"
            value={callbackUrl}
            maxLength={16_384}
            disabled={pending}
            onChange={(event) => setCallbackUrl(event.target.value)}
          />
          <Button
            size="xs"
            variant="outline"
            type="submit"
            disabled={pending || !callbackUrl.trim()}
          >
            Continue
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
