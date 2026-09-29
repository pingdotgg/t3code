import type { AuthSessionState } from "@t3tools/contracts";
import type { TFunction } from "@t3tools/i18n";
import { useTranslation } from "@t3tools/i18n/react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import React, { startTransition, useEffect, useRef, useState, useCallback } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { connectPairing } from "../../connection/onboarding";
import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { readHostedPairingRequest } from "../../hostedPairing";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { useAtomCommand } from "../../state/use-atom-command";

export function PairingPendingSurface() {
  const { t } = useTranslation("onboarding");
  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title={t("pendingPairingTitle")}
        description={t("validatingPairingLink")}
      />
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
  const { t } = useTranslation("onboarding");
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
        (error) => errorMessageFromUnknown(error, t("authenticationFailed")),
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
    [onAuthenticated, t],
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
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title={t("pairWithEnvironment")}
        description={describeAuthGate(auth.bootstrapMethods, t)}
      />

      <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="pairing-token">
            {t("pairingToken")}
          </label>
          <Input
            id="pairing-token"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => setCredential(event.currentTarget.value)}
            placeholder={t("pasteOneTimeTokenOrSecret")}
            spellCheck={false}
            value={credential}
          />
        </div>

        {errorMessage ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={isSubmitting} size="sm" type="submit">
            {isSubmitting ? t("pairing") : t("continue")}
          </Button>
          <Button
            disabled={isSubmitting}
            onClick={() => window.location.reload()}
            size="sm"
            variant="outline"
          >
            {t("reloadApp")}
          </Button>
        </div>
      </form>

      <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        {describeSupportedMethods(auth.bootstrapMethods, t)}
      </div>
    </StandalonePage>
  );
}

export function HostedPairingRouteSurface() {
  const { t } = useTranslation("onboarding");
  const connectPairingEnvironment = useAtomCommand(connectPairing, {
    reportFailure: false,
  });
  const hostedPairingRequestRef = useRef(readHostedPairingRequest());
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(() =>
    hostedPairingRequestRef.current ? "pairing" : "error",
  );
  const [message, setMessage] = useState<string>(() =>
    hostedPairingRequestRef.current ? t("connectingBackend") : t("missingBackendAndToken"),
  );
  const [canRetry, setCanRetry] = useState(false);
  const submitAttemptedRef = useRef(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = useCallback(async () => {
    const request = hostedPairingRequestRef.current;

    if (!request) {
      setStatus("error");
      setMessage(t("missingBackendAndToken"));
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) {
      setStatus("error");
      setMessage(t("pairingTokenAlreadySubmitted"));
      setCanRetry(false);
      return;
    }

    setStatus("pairing");
    setMessage(t("connectingBackend"));
    setCanRetry(false);
    tokenSubmittedRef.current = true;

    const result = await connectPairingEnvironment({
      host: request.host,
      pairingCode: request.token,
    });
    if (result._tag === "Success") {
      setStatus("paired");
      setMessage(
        t("environmentSavedInBrowser", {
          environment: request.label || t("theEnvironment"),
        }),
      );
      return;
    }

    tokenSubmittedRef.current = false;
    setStatus("error");
    setCanRetry(true);
    setMessage(
      t("hostedPairingFailure", {
        error: errorMessageFromUnknown(squashAtomCommandFailure(result), t("authenticationFailed")),
      }),
    );
  }, [connectPairingEnvironment, t]);

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
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title={
          status === "paired"
            ? t("backendPaired")
            : status === "error"
              ? t("pairingFailedTitle")
              : t("pairingBackend")
        }
        description={message}
      />

      {request ? (
        <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          {t("host")}: <span className="font-mono text-foreground/80">{request.host}</span>
        </div>
      ) : null}

      {status === "error" ? (
        <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
          {t("backendReachabilityHelp")}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2">
        {status === "pairing" ? (
          <Button disabled size="sm">
            {t("pairing")}
          </Button>
        ) : canRetry ? (
          <Button size="sm" onClick={() => void submitHostedPairingRequest()}>
            {t("tryAgain")}
          </Button>
        ) : null}
        {status === "paired" ? (
          <Button size="sm" variant="outline" onClick={() => (window.location.href = "/")}>
            {t("openApp")}
          </Button>
        ) : null}
      </div>
    </StandalonePage>
  );
}

function errorMessageFromUnknown(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return fallback;
}

function describeAuthGate(
  bootstrapMethods: ReadonlyArray<string>,
  t: TFunction<"onboarding">,
): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return t("trustedPairingCredentialRequired");
  }

  return t("enterPairingToken");
}

function describeSupportedMethods(
  bootstrapMethods: ReadonlyArray<string>,
  t: TFunction<"onboarding">,
): string {
  if (
    bootstrapMethods.includes("desktop-bootstrap") &&
    bootstrapMethods.includes("one-time-token")
  ) {
    return t("bothPairingMethodsAccepted");
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return t("desktopManagedPairingInfo");
  }

  return t("oneTimePairingInfo");
}
