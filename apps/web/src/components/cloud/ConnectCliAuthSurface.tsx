import { useAuth, useClerk, useUser } from "@clerk/react";
import { encodeConnectAuthCode, readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
  readConnectCliAuthState,
  readConnectCliCallbackResult,
  rememberConnectCliAuthState,
} from "../../cloud/connectCliAuth";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useI18n } from "../../i18n";
import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";

function ConnectCliAuthMessage({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <>
      {eyebrow ? (
        <p className="text-[10px] font-semibold tracking-[0.18em] text-blue-600 uppercase dark:text-blue-400">
          {eyebrow}
        </p>
      ) : null}
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

/**
 * /connect: the URL the CLI prints for both flows. Waits for a Clerk session,
 * then forwards the CLI's PKCE request to Clerk's authorize endpoint — with a
 * loopback redirect URI when the request carries a port, so the code returns
 * straight to the waiting CLI, and the hosted callback page otherwise.
 */
export function ConnectCliAuthorizeSurface() {
  const { t } = useI18n();
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const signInOpened = useRef(false);
  const redirecting = useRef(false);

  const openSignIn = useCallback(() => {
    if (!request) {
      return;
    }
    // Clerk redirects to the authorize endpoint itself once sign-in completes,
    // so the callback's state check has to be armed before handing off.
    rememberConnectCliAuthState(request.state);
    clerk.openSignIn(
      resolveClerkSignInProps(
        connectCliSignInRedirectUrl(request, window.location.href),
        isElectron,
      ),
    );
  }, [clerk, request]);

  useEffect(() => {
    if (!request || !isLoaded || redirecting.current) {
      return;
    }
    if (!isSignedIn) {
      if (!signInOpened.current) {
        signInOpened.current = true;
        openSignIn();
      }
      return;
    }
    const authorizeUrl = buildConnectCliClerkAuthorizeUrl(request);
    if (!authorizeUrl) {
      return;
    }
    redirecting.current = true;
    rememberConnectCliAuthState(request.state);
    window.location.assign(authorizeUrl);
  }, [isLoaded, isSignedIn, openSignIn, request]);

  if (!request) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage
          eyebrow={t("cloud.cli.authorizationRequest")}
          title={t("cloud.cli.incompleteTitle")}
          description={t("cloud.cli.incompleteDescription")}
        />
      </AuthSurfaceShell>
    );
  }

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow={
          request.loopbackPort === undefined
            ? t("cloud.cli.step1BrowserAuthorization")
            : t("cloud.cli.browserAuthorization")
        }
        title={t("cloud.cli.connectingTerminal")}
        description={isSignedIn ? t("cloud.cli.redirecting") : t("cloud.cli.signInDescription")}
      />
      {isLoaded && !isSignedIn ? (
        <div className="mt-6">
          <Button type="button" onClick={openSignIn}>
            {t("auth.signIn")}
          </Button>
        </div>
      ) : null}
    </AuthSurfaceShell>
  );
}

/**
 * /connect/callback: Clerk's redirect target. Shows the one-time code the
 * user enters in the waiting terminal.
 */
export function ConnectCliCallbackSurface() {
  const { t } = useI18n();
  const [result] = useState(readConnectCliCallbackResult);
  const [expectedState] = useState(readConnectCliAuthState);
  const { user } = useUser();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: t("cloud.cli.authorizationCode"),
  });

  if (!result) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage
          eyebrow={t("cloud.cli.step2TerminalHandoff")}
          title={t("cloud.cli.incompleteAuthTitle")}
          description={t("cloud.cli.incompleteAuthDescription")}
        />
      </AuthSurfaceShell>
    );
  }

  // Fail closed: the legitimate callback always lands in the same browser
  // that visited /connect (which recorded the state), so a missing or
  // mismatched state means this page was reached some other way — the CSRF
  // shape the state parameter exists to stop. Refuse to display a code.
  if (expectedState === null || expectedState !== result.state) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage
          eyebrow={t("cloud.cli.step2TerminalHandoff")}
          title={t("cloud.cli.mismatchedTitle")}
          description={t("cloud.cli.mismatchedDescription")}
        />
      </AuthSurfaceShell>
    );
  }

  const accountLabel = user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null;
  const authCode = encodeConnectAuthCode(result);

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow={t("cloud.cli.step2TerminalHandoff")}
        title={t("cloud.cli.almostConnected")}
        description={
          accountLabel
            ? t("cloud.cli.enterCodeAccount", { account: accountLabel })
            : t("cloud.cli.enterCode")
        }
      />

      <div className="mt-6 overflow-hidden rounded-xl border border-border/80 bg-background/65">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
          <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            {t("cloud.cli.oneTimeCode")}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {t("cloud.cli.expiresSoon")}
          </span>
        </div>
        <code
          className="block p-4 font-mono text-sm leading-relaxed break-all select-all"
          data-testid="connect-auth-code"
        >
          {authCode}
        </code>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button type="button" onClick={() => copyToClipboard(authCode)}>
          {isCopied ? t("cloud.cli.copied") : t("cloud.cli.copyCode")}
        </Button>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        {t("cloud.cli.safetyNotice")}
      </p>
    </AuthSurfaceShell>
  );
}
