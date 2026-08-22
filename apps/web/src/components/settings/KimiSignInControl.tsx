import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, ExternalLinkIcon, LoaderIcon, LogOutIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

/**
 * "Sign in with Kimi" affordance for Kimi provider instances.
 *
 * Runs the server-side OAuth device flow (`kimiAuth.signIn`) and renders its
 * progress inline: a start button, then the verification link and user code
 * while the server polls for approval, then a brief confirmation. The server
 * refreshes the provider probe on success, so the surrounding card flips to
 * authenticated on its own.
 */
export function KimiSignInControl({
  authenticated,
  environmentId,
  instanceId,
}: {
  readonly authenticated: boolean;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const signInState = useAtomValue(
    serverEnvironment.kimiSignInStateAtom(environmentId, instanceId),
  );
  const kimiSignIn = useAtomCommand(serverEnvironment.kimiSignIn, { reportFailure: false });
  const kimiSignOut = useAtomCommand(serverEnvironment.kimiSignOut, { reportFailure: false });
  const [isDispatching, setIsDispatching] = useState(false);
  const dispatchingRef = useRef(false);

  const startSignIn = useCallback(() => {
    if (dispatchingRef.current) return;
    dispatchingRef.current = true;
    setIsDispatching(true);
    void kimiSignIn({ environmentId, input: { instanceId } }).finally(() => {
      dispatchingRef.current = false;
      setIsDispatching(false);
    });
  }, [environmentId, instanceId, kimiSignIn]);
  const startSignOut = useCallback(() => {
    if (dispatchingRef.current) return;
    dispatchingRef.current = true;
    setIsDispatching(true);
    void kimiSignOut({ environmentId, input: { instanceId } }).finally(() => {
      dispatchingRef.current = false;
      setIsDispatching(false);
    });
  }, [environmentId, instanceId, kimiSignOut]);

  if (authenticated) {
    return (
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={isDispatching}
        onClick={startSignOut}
      >
        {isDispatching ? <LoaderIcon className="animate-spin" /> : <LogOutIcon />}
        Sign out
      </Button>
    );
  }

  if (signInState.status === "waiting") {
    return (
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.45]"
        role="status"
        aria-live="polite"
      >
        <LoaderIcon className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        <a
          className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
          href={signInState.verificationUri}
          rel="noreferrer"
          target="_blank"
        >
          Approve sign-in in your browser <ExternalLinkIcon className="size-3" />
        </a>
        {signInState.userCode ? (
          <span className="text-muted-foreground">
            Code:{" "}
            <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-xs text-foreground">
              {signInState.userCode}
            </code>
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={isDispatching || signInState.status === "starting"}
        onClick={startSignIn}
      >
        {isDispatching || signInState.status === "starting" ? (
          <LoaderIcon className="animate-spin" />
        ) : signInState.status === "completed" ? (
          <CheckIcon />
        ) : null}
        Sign in with Kimi
      </Button>
      {signInState.status === "failed" ? (
        <span
          className="text-[13px] leading-[1.45] text-destructive"
          role="status"
          aria-live="polite"
        >
          {signInState.message}
        </span>
      ) : null}
    </div>
  );
}
