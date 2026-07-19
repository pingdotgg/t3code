import { useAuth, useClerk, useUser } from "@clerk/react";
import { encodeConnectAuthCode, readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useEffect, useRef, useState } from "react";

import {
  buildConnectCliClerkAuthorizeUrl,
  readConnectCliAuthState,
  readConnectCliCallbackResult,
  rememberConnectCliAuthState,
} from "../../cloud/connectCliAuth";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";
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

const invalidLinkMessage = {
  eyebrow: "Authorization request",
  title: "This connect link is incomplete",
  description:
    "The link is missing its authorization request. Re-run `t3 connect` in your terminal and open the freshly printed URL.",
} as const;

/**
 * /connect: the URL a headless CLI prints. Waits for a Clerk session, then
 * forwards the CLI's PKCE request to Clerk's authorize endpoint.
 */
export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const signInOpened = useRef(false);
  const redirecting = useRef(false);

  useEffect(() => {
    if (!request || !isLoaded || redirecting.current) {
      return;
    }
    if (!isSignedIn) {
      if (!signInOpened.current) {
        signInOpened.current = true;
        clerk.openSignIn({ forceRedirectUrl: window.location.href });
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
  }, [clerk, isLoaded, isSignedIn, request]);

  if (!request) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage {...invalidLinkMessage} />
      </AuthSurfaceShell>
    );
  }

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow="Step 1 of 2 · Browser authorization"
        title="Connecting your terminal"
        description={
          isSignedIn
            ? "Redirecting to authorize T3 Connect for your CLI…"
            : "Sign in to continue authorizing T3 Connect for your CLI."
        }
      />
      {isLoaded && !isSignedIn ? (
        <div className="mt-6">
          <Button
            type="button"
            onClick={() => clerk.openSignIn({ forceRedirectUrl: window.location.href })}
          >
            Sign in
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
  const [result] = useState(readConnectCliCallbackResult);
  const [expectedState] = useState(readConnectCliAuthState);
  const { user } = useUser();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "authentication code" });

  if (!result) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage
          eyebrow="Step 2 of 2 · Terminal handoff"
          title="Authorization did not complete"
          description="No authorization code was returned. Re-run `t3 connect` in your terminal and try again."
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
          eyebrow="Step 2 of 2 · Terminal handoff"
          title="This code belongs to a different request"
          description="This authorization response does not match a connect request started in this browser. Re-run `t3 connect` in your terminal and open the freshly printed URL in this browser."
        />
      </AuthSurfaceShell>
    );
  }

  const accountLabel = user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null;
  const authCode = encodeConnectAuthCode(result);

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow="Step 2 of 2 · Terminal handoff"
        title="Almost connected"
        description={
          accountLabel
            ? `Enter this code in your waiting terminal to connect it as ${accountLabel}.`
            : "Enter this code in your waiting terminal to finish connecting."
        }
      />

      <div className="mt-6 overflow-hidden rounded-xl border border-border/80 bg-background/65">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
          <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            One-time authorization code
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">expires shortly</span>
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
          {isCopied ? "Copied!" : "Copy authorization code"}
        </Button>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        Only enter this code in a terminal session you started yourself. Anyone holding it can link
        their machine to your T3 Connect account while it is valid.
      </p>
    </AuthSurfaceShell>
  );
}
