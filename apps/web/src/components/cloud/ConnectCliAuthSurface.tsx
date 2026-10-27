import { useAuth, useClerk } from "@clerk/react";
import { readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
} from "../../cloud/connectCliAuth";
import { isElectron } from "../../env";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";

const invalidLinkMessage = {
  context: "Authorization request",
  title: "This connect link is incomplete",
  description:
    "The link is missing its authorization request. Re-run `t3 connect` in your terminal and open the freshly printed URL.",
} as const;

export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const signInOpened = useRef(false);
  const redirecting = useRef(false);

  const openSignIn = () => {
    if (!request) {
      return;
    }
    clerk.openSignIn(
      resolveClerkSignInProps(
        connectCliSignInRedirectUrl(request, window.location.href),
        isElectron,
      ),
    );
  };
  const openSignInOnLoad = useEffectEvent(openSignIn);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens Clerk sign-in or navigates the window to the authorize URL once Clerk has loaded
  useEffect(() => {
    if (!request || !isLoaded || redirecting.current) {
      return;
    }
    if (!isSignedIn) {
      if (!signInOpened.current) {
        signInOpened.current = true;
        openSignInOnLoad();
      }
      return;
    }
    const authorizeUrl = buildConnectCliClerkAuthorizeUrl(request);
    if (!authorizeUrl) {
      return;
    }
    redirecting.current = true;
    window.location.assign(authorizeUrl);
  }, [isLoaded, isSignedIn, request]);

  if (!request) {
    return (
      <StandalonePage>
        <StandalonePageHeader {...invalidLinkMessage} />
      </StandalonePage>
    );
  }

  return (
    <StandalonePage>
      <StandalonePageHeader
        context="Browser authorization"
        title="Connecting your terminal"
        description={
          isSignedIn
            ? "Redirecting to authorize T3 Connect for your CLI…"
            : "Sign in to continue authorizing T3 Connect for your CLI."
        }
      />
      {isLoaded && !isSignedIn ? (
        <div className="mt-6">
          <Button type="button" onClick={openSignIn}>
            Sign in
          </Button>
        </div>
      ) : null}
    </StandalonePage>
  );
}
