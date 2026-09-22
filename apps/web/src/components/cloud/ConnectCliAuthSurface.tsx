import { useAuth, useClerk, useUser } from "@clerk/react";
import { readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
} from "../../cloud/connectCliAuth";
import { isElectron } from "../../env";
import { AuthSurfaceMessage, AuthSurfaceShell } from "../auth/AuthSurfaceShell";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";

function ConnectCommand() {
  return <code className="font-mono text-[0.9em] text-foreground">t3 connect</code>;
}

function useClerkAccountLabel(): string | null {
  const { user } = useUser();
  return user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null;
}

/**
 * /connect forwards the CLI's PKCE request to Clerk with its loopback redirect.
 * Headless hosts use Clerk's device authorization page instead.
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
    window.location.assign(authorizeUrl);
  }, [isLoaded, isSignedIn, openSignIn, request]);

  if (!request) {
    return (
      <AuthSurfaceShell>
        <AuthSurfaceMessage
          title="This link is incomplete"
          description={
            <>
              The authorization request is missing or invalid. Copy the whole link, or run{" "}
              <ConnectCommand /> again.
            </>
          }
        />
      </AuthSurfaceShell>
    );
  }

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
              Your terminal ran <ConnectCommand /> and is waiting. Sign in here and it finishes on
              its own.
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
