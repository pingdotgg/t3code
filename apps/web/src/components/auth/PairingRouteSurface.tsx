import { Link2Icon, OctagonAlertIcon, UnlinkIcon, XIcon } from "lucide-react";
import type { AuthSessionState } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import React, { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";

import { connectPairing } from "../../connection/onboarding";
import {
  isPrimaryEnvironmentRequestError,
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { readHostedPairingRequest } from "../../hostedPairing";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/spinner";
import {
  StandaloneCardHeader,
  StandaloneCardNote,
  StandalonePage,
  StandalonePageIcon,
} from "../ui/standalone-page";
import { useAtomCommand } from "../../state/use-atom-command";

export function PairingPendingSurface() {
  return (
    <StandalonePage tone="plain" size="card">
      <StandalonePageIcon>
        <Link2Icon />
      </StandalonePageIcon>
      <StandaloneCardHeader
        title="Pairing with this environment"
        description="Validating the pairing link and preparing your session."
      />
      <div className="flex justify-end">
        <Button disabled size="sm">
          <Spinner />
          Pairing…
        </Button>
      </div>
    </StandalonePage>
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
  const [autoPairToken] = useState(peekPairingTokenFromUrl);
  const [credential, setCredential] = useState(autoPairToken ?? "");
  const [failure, setFailure] = useState<PairingFailure | null>(() =>
    initialErrorMessage ? { title: "Could not pair", message: initialErrorMessage } : null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const autoSubmitAttemptedRef = useRef(false);

  const submitCredential = async (nextCredential: string) => {
    setIsSubmitting(true);
    setFailure(null);

    const submitError = await submitServerAuthCredential(nextCredential).then(
      () => null,
      (error) => describePairingFailure(error),
    );

    setIsSubmitting(false);

    if (submitError) {
      setFailure(submitError);
      return;
    }

    startTransition(() => {
      onAuthenticated();
    });
  };

  const handleSubmit = async (event?: React.SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();
    await submitCredential(credential);
  };

  const autoSubmit = useEffectEvent((token: string) => {
    void submitCredential(token);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- strips the pairing token from the URL and submits it once when the route carries one
  useEffect(() => {
    if (!autoPairToken || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    autoSubmit(autoPairToken);
  }, [autoPairToken]);

  const failed = failure !== null;

  return (
    <StandalonePage tone="plain" size="card">
      <StandalonePageIcon tone={failed ? "error" : "default"}>
        {failed ? <UnlinkIcon /> : <Link2Icon />}
      </StandalonePageIcon>
      <StandaloneCardHeader
        title={failed ? "Pairing failed" : "Pair with this environment"}
        description={describeAuthGate(auth.bootstrapMethods)}
      />

      <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
        {failure ? (
          <Alert variant="error" controlAlignment="first-line">
            <OctagonAlertIcon />
            <AlertTitle>{failure.title}</AlertTitle>
            <AlertDescription>{failure.message}</AlertDescription>
            <AlertAction>
              <Button
                aria-label="Dismiss"
                onClick={() => setFailure(null)}
                size="icon-xs"
                variant="ghost-muted"
              >
                <XIcon />
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        <Input
          id="pairing-token"
          aria-label="Pairing token"
          font="mono"
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

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={isSubmitting}
            onClick={() => window.location.reload()}
            size="sm"
            variant="secondary"
          >
            Reload app
          </Button>
          <Button disabled={isSubmitting} size="sm" type="submit">
            {isSubmitting ? <Spinner /> : null}
            {isSubmitting ? "Pairing…" : failed ? "Try again" : "Continue"}
            {isSubmitting ? null : <Kbd>⏎</Kbd>}
          </Button>
        </div>
      </form>

      <StandaloneCardNote>{describeSupportedMethods(auth.bootstrapMethods)}</StandaloneCardNote>
    </StandalonePage>
  );
}

export function HostedPairingRouteSurface() {
  const connectPairingEnvironment = useAtomCommand(connectPairing, {
    reportFailure: false,
  });
  const [request] = useState(readHostedPairingRequest);
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(
    request ? "pairing" : "error",
  );
  const [message, setMessage] = useState(
    request
      ? "Connecting to this backend."
      : "This pairing link is missing its backend host or token.",
  );
  const [errorTitle, setErrorTitle] = useState("Pairing link incomplete");
  const [canRetry, setCanRetry] = useState(false);
  const submitAttemptedRef = useRef(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = async () => {
    if (!request) {
      setStatus("error");
      setErrorTitle("Pairing link incomplete");
      setMessage("This pairing link is missing its backend host or token.");
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) {
      setStatus("error");
      setErrorTitle("Token already used");
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
    setErrorTitle("Could not pair");
    setCanRetry(true);
    setMessage(
      `${errorMessageFromUnknown(squashAtomCommandFailure(result))} If the backend accepted this one-time token, request a new pairing link before retrying.`,
    );
  };

  const submitOnMount = useEffectEvent(() => {
    void submitHostedPairingRequest();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- strips the pairing token from the URL and submits the hosted pairing request once on mount
  useEffect(() => {
    if (submitAttemptedRef.current) {
      return;
    }
    submitAttemptedRef.current = true;

    stripPairingTokenFromUrl();
    submitOnMount();
  }, []);

  return (
    <StandalonePage tone="plain" size="card">
      <StandalonePageIcon tone={status === "error" ? "error" : "default"}>
        {status === "error" ? <UnlinkIcon /> : <Link2Icon />}
      </StandalonePageIcon>
      <StandaloneCardHeader
        title={
          status === "paired"
            ? "Backend paired"
            : status === "error"
              ? "Pairing failed"
              : "Pairing backend"
        }
        description={status === "error" ? "This browser could not pair with the backend." : message}
      />

      {status === "error" ? (
        <Alert variant="error" controlAlignment="first-line">
          <OctagonAlertIcon />
          <AlertTitle>{errorTitle}</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}

      {request ? (
        <div className="rounded-control surface-well px-3 py-2.5 text-meta leading-relaxed text-muted-foreground">
          Host: <span className="font-mono text-foreground">{request.host}</span>
        </div>
      ) : null}

      {status === "pairing" || canRetry || status === "paired" ? (
        <div className="flex flex-wrap justify-end gap-2">
          {status === "pairing" ? (
            <Button disabled size="sm">
              <Spinner />
              Pairing…
            </Button>
          ) : canRetry ? (
            <Button size="sm" onClick={() => void submitHostedPairingRequest()}>
              Try again
            </Button>
          ) : null}
          {status === "paired" ? (
            <Button size="sm" variant="secondary" onClick={() => (window.location.href = "/")}>
              Open app
            </Button>
          ) : null}
        </div>
      ) : null}

      {status === "error" && canRetry ? (
        <StandaloneCardNote>
          Verify the backend is reachable from this browser, supports CORS for hosted clients, and
          is served over HTTPS when opening this page from HTTPS.
        </StandaloneCardNote>
      ) : null}
    </StandalonePage>
  );
}

interface PairingFailure {
  readonly title: string;
  readonly message: string;
}

/** Names the failure the user can act on; the server reports expired and used tokens alike. */
function describePairingFailure(error: unknown): PairingFailure {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : null;
  switch (tag) {
    case "PrimaryEnvironmentPairingCredentialRejectedError":
      return {
        title: "Token not accepted",
        message:
          "This token is invalid, expired, or already used. Request a new pairing link and try again.",
      };
    case "PrimaryEnvironmentPairingCredentialRequiredError":
      return { title: "Token required", message: "Paste a pairing token to continue." };
    case "PrimaryEnvironmentAuthSessionTimeoutError":
      return {
        title: "Session did not start",
        message: "The server accepted the token but the session did not start. Reload the app.",
      };
    case "PrimaryEnvironmentRequestError":
      return isPrimaryEnvironmentRequestError(error) && error.responded
        ? {
            title: `Server error (HTTP ${error.status})`,
            message: "This T3 Code server answered with an error. Try again, or check its logs.",
          }
        : {
            title: "Server unreachable",
            message:
              "Could not reach this T3 Code server. Check that it is running and reachable from this browser.",
          };
    default:
      return { title: "Could not pair", message: errorMessageFromUnknown(error) };
  }
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
