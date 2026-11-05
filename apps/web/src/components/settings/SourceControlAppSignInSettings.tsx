import type { EnvironmentId, SourceControlSignInPrompt } from "@t3tools/contracts";
import {
  readHostCredentialSettings,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { Check, Copy } from "lucide";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { T3AppIcon } from "~/components/T3AppIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

type SignInState =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | { readonly status: "waiting"; readonly prompt: SourceControlSignInPrompt }
  | { readonly status: "failed"; readonly message: string };

const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const expiryTime = (expiresAt: number) =>
  new Date(expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function ExternalLink(props: { readonly href: string; readonly children: ReactNode }) {
  return (
    <InlineButton render={<a href={props.href} target="_blank" rel="noreferrer noopener" />}>
      {props.children}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </InlineButton>
  );
}

function AppMark(props: { readonly signedIn: boolean }) {
  return (
    <div className="relative size-10 shrink-0">
      <T3AppIcon className="size-full" />
      {props.signedIn ? (
        <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-success text-white ring-2 ring-card">
          <CheckIcon aria-hidden className="size-2.5" strokeWidth={3} />
        </span>
      ) : null}
    </div>
  );
}

/** The device code, one cell per character, as GitHub prints it. */
function DeviceCode(props: { readonly code: string }) {
  return (
    <div className="flex items-center gap-1 font-mono text-lg font-medium">
      <span className="sr-only">{props.code}</span>
      {Array.from(props.code, (char, index) =>
        char === "-" ? (
          <span key={index} aria-hidden className="px-0.5 text-muted-foreground">
            –
          </span>
        ) : (
          <span
            key={index}
            aria-hidden
            className="grid h-10 w-8 place-items-center rounded-md border border-border bg-background shadow-xs"
          >
            {char}
          </span>
        ),
      )}
    </div>
  );
}

export function SourceControlAppSignInSettings({
  environmentId,
  definition,
  appSignIn,
  account,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn;
  /** The login discovery reports, which is the signed-in account when no token overrides it. */
  readonly account: string | null;
  readonly onChanged: () => void;
}) {
  const host = appSignIn.hosts[0] ?? "";
  const { signIns, tokens } = useEnvironmentSettings(environmentId, (settings) =>
    readHostCredentialSettings(settings, definition.kind),
  );
  const signedIn = (signIns[host] ?? "").length > 0;
  const tokenOverrides = (tokens[host] ?? "").length > 0;
  const canSignIn = useAtomValue(
    sourceControlEnvironment.startSignIn.permissionAtom(environmentId),
  );
  const start = useAtomCommand(sourceControlEnvironment.startSignIn, { reportFailure: false });
  const wait = useAtomCommand(sourceControlEnvironment.waitForSignIn, { reportFailure: false });
  const cancel = useAtomCommand(sourceControlEnvironment.cancelSignIn, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: `sign out of ${appSignIn.appName}`,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "sign-in code",
  });
  const [state, setState] = useState<SignInState>({ status: "idle" });

  const signIn = async () => {
    setState({ status: "starting" });
    const input = { provider: definition.kind, host };
    const started = await start({ environmentId, input });
    if (started._tag !== "Success") {
      setState({ status: "failed", message: failureMessage(started.cause) });
      return;
    }
    const prompt = started.value;
    setState({ status: "waiting", prompt });
    const finished = await wait({ environmentId, input });
    // A newer attempt, a cancel, or a sign-out owns the state by now.
    setState((current) => {
      if (current.status !== "waiting" || current.prompt !== prompt) return current;
      return finished._tag === "Success"
        ? { status: "idle" }
        : { status: "failed", message: failureMessage(finished.cause) };
    });
    if (finished._tag === "Success") onChanged();
  };

  const signOut = async () => {
    setState({ status: "idle" });
    const result = await updateSettings({
      environmentId,
      // Send the whole map; other hosts' redaction markers preserve their sessions.
      input: {
        patch: {
          sourceControlHosts: { [definition.kind]: { signIns: { ...signIns, [host]: "" } } },
        },
      },
    });
    if (result._tag === "Success") onChanged();
  };

  const waiting = !signedIn && state.status === "waiting" ? state.prompt : null;

  let subtitle: ReactNode;
  let action: ReactNode;
  if (signedIn) {
    subtitle =
      account !== null && !tokenOverrides ? (
        <span className="flex min-w-0 items-center gap-1">
          Signed in as
          <RedactedSensitiveText
            value={account}
            ariaLabel="Signed-in GitHub account"
            revealTooltip="Show account"
            hideTooltip="Hide account"
          />
        </span>
      ) : tokenOverrides ? (
        "Signed in, but the token saved below is used until you remove it."
      ) : (
        "Signed in"
      );
    action = (
      <Button size="xs" variant="outline" disabled={!canSignIn} onClick={() => void signOut()}>
        Sign out
      </Button>
    );
  } else if (waiting !== null) {
    subtitle = "Approve the app on GitHub to finish signing in.";
    action = (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          setState({ status: "idle" });
          void cancel({ environmentId, input: { provider: definition.kind, host } });
        }}
      >
        Cancel
      </Button>
    );
  } else {
    subtitle = "A far higher GitHub API rate limit than a personal token or gh login.";
    action = (
      <Button
        size="xs"
        disabled={!canSignIn || state.status === "starting"}
        onClick={() => void signIn()}
      >
        {state.status === "starting" ? <Spinner /> : null}
        {state.status === "failed" ? "Try again" : "Sign in with GitHub"}
      </Button>
    );
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card",
        state.status === "failed" && !signedIn ? "border-destructive/40" : "border-border",
      )}
    >
      <div className="flex items-center gap-3 p-3">
        <AppMark signedIn={signedIn} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium text-foreground">{appSignIn.appName}</p>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
        <div className="shrink-0">{action}</div>
      </div>

      {waiting !== null ? (
        <div className="grid gap-4 border-t border-border bg-muted/40 px-3 py-4 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-6">
          <div className="flex items-center gap-2">
            <DeviceCode code={waiting.userCode} />
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Copy code"
              onClick={() => copyToClipboard(waiting.userCode, undefined)}
            >
              <MorphIcon className="size-3.5" icon={isCopied ? Check : Copy} />
            </Button>
          </div>
          <div className="grid gap-2 sm:justify-items-end">
            <Button
              size="sm"
              render={
                <a href={waiting.verificationUri} target="_blank" rel="noreferrer noopener" />
              }
              onClick={() => copyToClipboard(waiting.userCode, undefined)}
            >
              Copy code & open GitHub
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </Button>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span aria-hidden className="size-1.5 rounded-full bg-warning" />
              Waiting for approval · code expires at {expiryTime(waiting.expiresAt)}
            </p>
          </div>
        </div>
      ) : null}

      {signedIn ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            Reaches repositories in accounts and organizations that installed the app.
          </span>
          <ExternalLink href={appSignIn.installUrl}>Install on an organization</ExternalLink>
          <ExternalLink href={appSignIn.revokeUrl}>Manage on GitHub</ExternalLink>
        </div>
      ) : null}

      {state.status === "failed" && !signedIn ? (
        <p
          role="alert"
          className="border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
