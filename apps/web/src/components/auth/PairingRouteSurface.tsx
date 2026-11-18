import { Link2Icon, OctagonAlertIcon, UnlinkIcon, XIcon } from "lucide-react";
import type { AuthSessionState } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { msg, T, useGT, useMessages, Var } from "gt-react";
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
import { m, type MessageResolver } from "../../i18n/messages";

export function PairingPendingSurface() {
  const gt = useGT();
  return (
    <StandalonePage size="card">
      <StandalonePageIcon>
        <Link2Icon />
      </StandalonePageIcon>
      <StandaloneCardHeader
        title={gt("Pairing with this environment")}
        description={gt("Validating the pairing link and preparing your session.")}
      />
      <div className="flex justify-end">
        <Button disabled size="standard">
          <Spinner />
          <T>Pairing…</T>
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
  const gt = useGT();
  const messages = useMessages();
  const [autoPairToken] = useState(peekPairingTokenFromUrl);
  const [credential, setCredential] = useState(autoPairToken ?? "");
  const [failure, setFailure] = useState<PairingFailure | null>(() =>
    initialErrorMessage ? { title: m(msg("Could not pair")), message: initialErrorMessage } : null,
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
    <StandalonePage size="card">
      <StandalonePageIcon tone={failed ? "error" : "default"}>
        {failed ? <UnlinkIcon /> : <Link2Icon />}
      </StandalonePageIcon>
      <StandaloneCardHeader
        title={failed ? gt("Pairing failed") : gt("Pairing backend")}
        description={describeAuthGate(auth.bootstrapMethods, messages)}
      />

      <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
        {failure ? (
          <Alert variant="error" controlAlignment="first-line">
            <OctagonAlertIcon />
            <AlertTitle>{failure.title}</AlertTitle>
            <AlertDescription>{failure.message}</AlertDescription>
            <AlertAction>
              <Button
                aria-label={gt("Dismiss")}
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
          aria-label={gt("Pairing token")}
          font="mono"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          disabled={isSubmitting}
          nativeInput
          onChange={(event) => setCredential(event.currentTarget.value)}
          placeholder={gt("Paste a one-time token or pairing secret")}
          spellCheck={false}
          value={credential}
        />

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={isSubmitting}
            onClick={() => window.location.reload()}
            size="standard"
            variant="secondary"
          >
            <T>Reload app</T>
          </Button>
          <Button disabled={isSubmitting} size="standard" type="submit">
            {isSubmitting ? <Spinner /> : null}
            {isSubmitting ? gt("Pairing…") : failed ? gt("Try again") : gt("Continue")}
            {isSubmitting ? null : <Kbd>⏎</Kbd>}
          </Button>
        </div>
      </form>

      <StandaloneCardNote>
        {describeSupportedMethods(auth.bootstrapMethods, messages)}
      </StandaloneCardNote>
    </StandalonePage>
  );
}

export function HostedPairingRouteSurface() {
  const connectPairingEnvironment = useAtomCommand(connectPairing, {
    reportFailure: false,
  });
  const [request] = useState(readHostedPairingRequest);
  const gt = useGT();
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(
    request ? "pairing" : "error",
  );
  const [message, setMessage] = useState(() =>
    request
      ? m(msg("Connecting to this backend."))
      : m(msg("This pairing link is missing its backend host or token.")),
  );
  const [errorTitle, setErrorTitle] = useState(() => m(msg("Pairing link incomplete")));
  const [canRetry, setCanRetry] = useState(false);
  const submitAttemptedRef = useRef(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = async () => {
    if (!request) {
      setStatus("error");
      setErrorTitle(gt("Pairing link incomplete"));
      setMessage(gt("This pairing link is missing its backend host or token."));
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) {
      setStatus("error");
      setErrorTitle(gt("Token already used"));
      setMessage(
        gt("This one-time pairing token was already submitted. Request a new pairing link."),
      );
      setCanRetry(false);
      return;
    }

    setStatus("pairing");
    setMessage(gt("Connecting to this backend."));
    setCanRetry(false);
    tokenSubmittedRef.current = true;

    const result = await connectPairingEnvironment({
      host: request.host,
      pairingCode: request.token,
    });
    if (result._tag === "Success") {
      setStatus("paired");
      setMessage(
        request.label
          ? gt("{environment} is saved in this browser.", { environment: request.label })
          : gt("The environment is saved in this browser."),
      );
      return;
    }

    tokenSubmittedRef.current = false;
    setStatus("error");
    setErrorTitle(gt("Could not pair"));
    setCanRetry(true);
    setMessage(
      gt(
        "{error} If the backend accepted this one-time token, request a new pairing link before retrying.",
        { error: errorMessageFromUnknown(squashAtomCommandFailure(result)) },
      ),
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
    <StandalonePage size="card">
      <StandalonePageIcon tone={status === "error" ? "error" : "default"}>
        {status === "error" ? <UnlinkIcon /> : <Link2Icon />}
      </StandalonePageIcon>
      <StandaloneCardHeader
        title={
          status === "paired"
            ? gt("Backend paired")
            : status === "error"
              ? gt("Pairing failed")
              : gt("Pairing backend")
        }
        description={
          status === "error" ? gt("This browser could not pair with the backend.") : message
        }
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
          <T>
            Host:{" "}
            <span className="font-mono text-foreground">
              <Var>{request.host}</Var>
            </span>
          </T>
        </div>
      ) : null}

      {status === "pairing" || canRetry || status === "paired" ? (
        <div className="flex flex-wrap justify-end gap-2">
          {status === "pairing" ? (
            <Button disabled size="standard">
              <Spinner />
              <T>Pairing…</T>
            </Button>
          ) : canRetry ? (
            <Button size="standard" onClick={() => void submitHostedPairingRequest()}>
              <T>Try again</T>
            </Button>
          ) : null}
          {status === "paired" ? (
            <Button
              size="standard"
              variant="secondary"
              onClick={() => (window.location.href = "/")}
            >
              <T>Open app</T>
            </Button>
          ) : null}
        </div>
      ) : null}

      {status === "error" && canRetry ? (
        <StandaloneCardNote>
          <T>
            Verify the backend is reachable from this browser, supports CORS for hosted clients,
            and is served over HTTPS when opening this page from HTTPS.
          </T>
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
        title: m(msg("Token not accepted")),
        message: m(
          msg(
            "This token is invalid, expired, or already used. Request a new pairing link and try again.",
          ),
        ),
      };
    case "PrimaryEnvironmentPairingCredentialRequiredError":
      return {
        title: m(msg("Token required")),
        message: m(msg("Paste a pairing token to continue.")),
      };
    case "PrimaryEnvironmentAuthSessionTimeoutError":
      return {
        title: m(msg("Session did not start")),
        message: m(
          msg("The server accepted the token but the session did not start. Reload the app."),
        ),
      };
    case "PrimaryEnvironmentRequestError":
      return isPrimaryEnvironmentRequestError(error) && error.responded
        ? {
            title: m(msg("Server error (HTTP {status})", { status: error.status })),
            message: m(
              msg("This T3 Code server answered with an error. Try again, or check its logs."),
            ),
          }
        : {
            title: m(msg("Server unreachable")),
            message: m(
              msg(
                "Could not reach this T3 Code server. Check that it is running and reachable from this browser.",
              ),
            ),
          };
    default:
      return { title: m(msg("Could not pair")), message: errorMessageFromUnknown(error) };
  }
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return m(msg("Authentication failed."));
}

function describeAuthGate(
  bootstrapMethods: ReadonlyArray<string>,
  resolve: MessageResolver,
): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return resolve(
      msg("This environment expects a trusted pairing credential before the app can connect."),
    );
  }

  return resolve(msg("Enter a pairing token to start a session with this environment."));
}

function describeSupportedMethods(
  bootstrapMethods: ReadonlyArray<string>,
  resolve: MessageResolver,
): string {
  if (
    bootstrapMethods.includes("desktop-bootstrap") &&
    bootstrapMethods.includes("one-time-token")
  ) {
    return resolve(
      msg(
        "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.",
      ),
    );
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return resolve(
      msg(
        "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.",
      ),
    );
  }

  return resolve(
    msg(
      "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.",
    ),
  );
}
