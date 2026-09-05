import { useAuth, useClerk, useUser } from "@clerk/react";
import { encodeConnectAuthCode, readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
  readConnectCliAuthState,
  readConnectCliCallbackError,
  readConnectCliCallbackResult,
  rememberConnectCliAuthState,
} from "../../cloud/connectCliAuth";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { AuthSurfaceMessage, AuthSurfaceShell } from "../auth/AuthSurfaceShell";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";

function ConnectCommand() {
  return <code className="font-mono text-[0.9em] text-foreground">t3 connect</code>;
}

const terminalWaitNote = "Your terminal stops waiting 10 minutes after it printed the link.";

function useClerkAccountLabel(): string | null {
  const { user } = useUser();
  return user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null;
}

/**
 * /connect: the URL the CLI prints for both flows. Waits for a Clerk session,
 * then forwards the CLI's PKCE request to Clerk's authorize endpoint — with a
 * loopback redirect URI when the request carries a port, so the code returns
 * straight to the waiting CLI, and the hosted callback page otherwise.
 */
export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const accountLabel = useClerkAccountLabel();
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
        <AuthSurfaceMessage
          title="This link is incomplete"
          description={
            <>
              The part after # is missing. Copy the whole link, or run <ConnectCommand /> again.
            </>
          }
        />
      </AuthSurfaceShell>
    );
  }

  const finishesInTerminal = request.loopbackPort !== undefined;

  return (
    <AuthSurfaceShell>
      <AuthSurfaceMessage
        title="Connecting your terminal"
        description={
          isSignedIn ? (
            <>
              Sending you to authorize T3 Connect
              {accountLabel ? (
                <>
                  {" "}
                  as <span className="text-foreground">{accountLabel}</span>
                </>
              ) : null}
              .
            </>
          ) : (
            <>
              Your terminal ran <ConnectCommand /> and is waiting.{" "}
              {finishesInTerminal
                ? "Sign in here and it finishes on its own."
                : "Sign in here, then paste the code this page gives you into the terminal."}
            </>
          )
        }
      />
      {isLoaded && !isSignedIn ? (
        <div className="mt-6">
          <Button type="button" onClick={openSignIn}>
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
  const [callbackError] = useState(readConnectCliCallbackError);
  const [expectedState] = useState(readConnectCliAuthState);
  const clerk = useClerk();
  const accountLabel = useClerkAccountLabel();
  const [signedOut, setSignedOut] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "authentication code" });

  if (!result) {
    return (
      <AuthSurfaceShell>
        <AuthSurfaceMessage
          title={
            callbackError === "access_denied"
              ? "Sign-in was cancelled"
              : "Authorization did not complete"
          }
          description={
            <>
              {callbackError === "access_denied"
                ? "No code was issued."
                : "Sign-in did not return a code, so there is nothing to give your terminal."}{" "}
              Open the link from your terminal again to retry, or run <ConnectCommand /> if it has
              stopped waiting.
            </>
          }
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
        <AuthSurfaceMessage
          title="This code belongs to a different request"
          description={
            <>
              Sign-in finished in a different tab or browser than the one that opened the connect
              link, so this result cannot be trusted. Run <ConnectCommand /> again and stay in one
              tab from the link through sign-in.
            </>
          }
        />
      </AuthSurfaceShell>
    );
  }

  if (signedOut) {
    return (
      <AuthSurfaceShell>
        <AuthSurfaceMessage
          title="Signed out"
          description={
            <>
              Open the link from your terminal again and sign in with the account you want to
              connect. {terminalWaitNote}
            </>
          }
        />
      </AuthSurfaceShell>
    );
  }

  const authCode = encodeConnectAuthCode(result);

  return (
    <AuthSurfaceShell>
      <AuthSurfaceMessage
        title="Enter this code in your terminal"
        description={
          accountLabel ? (
            <>
              It connects your terminal to T3 Connect as{" "}
              <span className="text-foreground">{accountLabel}</span>. Not you?{" "}
              <button
                type="button"
                className="cursor-pointer text-foreground underline underline-offset-4"
                onClick={() => void clerk.signOut(() => setSignedOut(true))}
              >
                Sign out
              </button>{" "}
              and open the link from your terminal again.
            </>
          ) : (
            "Your terminal is waiting for it."
          )
        }
      />

      <div className="mt-5 rounded-lg border bg-muted/30 px-3.5 py-3">
        <code
          className="block font-mono text-sm leading-relaxed break-all select-all"
          data-testid="connect-auth-code"
        >
          {authCode}
        </code>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => copyToClipboard(authCode)}>
          {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
          {isCopied ? "Copied" : "Copy code"}
        </Button>
        <span className="text-xs text-muted-foreground">{terminalWaitNote}</span>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        Only paste it into a terminal you started. Anyone with this code can link a machine to your
        account until it expires.
      </p>
    </AuthSurfaceShell>
  );
}
