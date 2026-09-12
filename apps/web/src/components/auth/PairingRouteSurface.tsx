import type { AuthSessionState } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import React, { startTransition, useEffect, useRef, useState, useCallback } from "react";

import { connectPairing } from "../../connection/onboarding";
import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { readHostedPairingRequest } from "../../hostedPairing";
import {
  StandaloneSurface,
  StandaloneSurfaceHeading,
  StandaloneSurfacePanel,
} from "../StandaloneSurface";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useAtomCommand } from "../../state/use-atom-command";

export function PairingPendingSurface() {
  return (
    <StandaloneSurface>
      <StandaloneSurfaceHeading
        title="Pairing with this environment"
        description="Validating the pairing link and preparing your session."
      />
    </StandaloneSurface>
  );
}

export function PairingRouteSurface({
  auth,
  initialErrorMessage,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  initialErrorMessage?: string;
  onAuthenticated: () => void;
}) {
  const autoPairTokenRef = useRef<string | null>(peekPairingTokenFromUrl());
  const [credential, setCredential] = useState(() => autoPairTokenRef.current ?? "");
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const autoSubmitAttemptedRef = useRef(false);

  const submitCredential = useCallback(
    async (nextCredential: string) => {
      setIsSubmitting(true);
      setErrorMessage("");

      const submitError = await submitServerAuthCredential(nextCredential).then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      setIsSubmitting(false);

      if (submitError) {
        setErrorMessage(submitError);
        return;
      }

      startTransition(() => {
        onAuthenticated();
      });
    },
    [onAuthenticated],
  );

  const handleSubmit = useCallback(
    async (event?: React.SubmitEvent<HTMLFormElement>) => {
      event?.preventDefault();
      await submitCredential(credential);
    },
    [submitCredential, credential],
  );

  useEffect(() => {
    const token = autoPairTokenRef.current;
    if (!token || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    void submitCredential(token);
  }, [submitCredential]);

  return (
    <StandaloneSurface>
      <StandaloneSurfaceHeading
        title="Pair with this environment"
        description={describeAuthGate(auth.bootstrapMethods)}
      />

      <form onSubmit={(event) => void handleSubmit(event)}>
        <StandaloneSurfacePanel>
          <div className="space-y-2 p-4">
            <label className="text-[13px] font-medium" htmlFor="pairing-token">
              Pairing token
            </label>
            <Input
              id="pairing-token"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setCredential(event.currentTarget.value)}
              placeholder="Paste a one-time token or pairing secret"
              spellCheck={false}
              value={credential}
            />
            {errorMessage ? (
              <p className="text-[13px] leading-relaxed text-destructive">{errorMessage}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <Button disabled={isSubmitting} size="sm" type="submit">
                {isSubmitting ? "Pairing..." : "Continue"}
              </Button>
              <Button
                disabled={isSubmitting}
                onClick={() => window.location.reload()}
                size="sm"
                variant="ghost"
              >
                Reload app
              </Button>
            </div>
          </div>
        </StandaloneSurfacePanel>
      </form>

      <p className="mt-4 px-1 text-xs leading-relaxed text-muted-foreground">
        {describeSupportedMethods(auth.bootstrapMethods)}
      </p>
    </StandaloneSurface>
  );
}

export function HostedPairingRouteSurface() {
  const connectPairingEnvironment = useAtomCommand(connectPairing, {
    reportFailure: false,
  });
  const hostedPairingRequestRef = useRef(readHostedPairingRequest());
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(() =>
    hostedPairingRequestRef.current ? "pairing" : "error",
  );
  const [message, setMessage] = useState(() =>
    hostedPairingRequestRef.current
      ? "Connecting to this backend."
      : "This pairing link is missing its backend host or token.",
  );
  const [canRetry, setCanRetry] = useState(false);
  const submitAttemptedRef = useRef(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = useCallback(async () => {
    const request = hostedPairingRequestRef.current;

    if (!request) {
      setStatus("error");
      setMessage("This pairing link is missing its backend host or token.");
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) {
      setStatus("error");
      setMessage("This one-time pairing token was already submitted. Request a new pairing link.");
      setCanRetry(false);
      return;
    }

    setStatus("pairing");
    setMessage("Connecting to this backend.");
    setCanRetry(false);
    tokenSubmittedRef.current = true;

    const result = await connectPairingEnvironment({
      host: request.host,
      pairingCode: request.token,
    });
    if (result._tag === "Success") {
      setStatus("paired");
      setMessage(`${request.label || "The environment"} is saved in this browser.`);
      return;
    }

    tokenSubmittedRef.current = false;
    setStatus("error");
    setCanRetry(true);
    setMessage(
      `${errorMessageFromUnknown(squashAtomCommandFailure(result))} If the backend accepted this one-time token, request a new pairing link before retrying.`,
    );
  }, [connectPairingEnvironment]);

  useEffect(() => {
    if (submitAttemptedRef.current) {
      return;
    }
    submitAttemptedRef.current = true;

    stripPairingTokenFromUrl();
    void submitHostedPairingRequest();
  }, [submitHostedPairingRequest]);

  const request = hostedPairingRequestRef.current;

  return (
    <StandaloneSurface>
      <StandaloneSurfaceHeading
        title={
          status === "paired"
            ? "Backend paired"
            : status === "error"
              ? "Pairing failed"
              : "Pairing backend"
        }
        description={message}
      />

      <StandaloneSurfacePanel>
        {request ? (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="text-[13px]">Host</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{request.host}</span>
          </div>
        ) : null}
        {status === "error" ? (
          <p className="px-4 py-3 text-[13px] leading-relaxed text-destructive">
            Verify the backend is reachable from this browser, supports CORS for hosted clients, and
            is served over HTTPS when opening this page from HTTPS.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          {status === "pairing" ? (
            <Button disabled size="sm">
              Pairing...
            </Button>
          ) : canRetry ? (
            <Button size="sm" onClick={() => void submitHostedPairingRequest()}>
              Try again
            </Button>
          ) : null}
          {status === "paired" ? (
            <Button size="sm" onClick={() => (window.location.href = "/")}>
              Open app
            </Button>
          ) : null}
        </div>
      </StandaloneSurfacePanel>
    </StandaloneSurface>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}

function describeAuthGate(bootstrapMethods: ReadonlyArray<string>): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment expects a trusted pairing credential before the app can connect.";
  }

  return "Enter a pairing token to start a session with this environment.";
}

function describeSupportedMethods(bootstrapMethods: ReadonlyArray<string>): string {
  if (
    bootstrapMethods.includes("desktop-bootstrap") &&
    bootstrapMethods.includes("one-time-token")
  ) {
    return "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.";
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.";
  }

  return "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.";
}
