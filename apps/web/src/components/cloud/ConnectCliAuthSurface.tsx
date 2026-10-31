import { useAuth, useClerk } from "@clerk/react";
import {
  connectAuthorizeRequestCode,
  connectLoopbackCancelUrl,
  readConnectAuthorizeRequest,
} from "@t3tools/shared/connectAuth";
import { SquareTerminalIcon } from "lucide-react";
import { useRef, useState } from "react";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
} from "../../cloud/connectCliAuth";
import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Spinner } from "../ui/spinner";
import {
  StandaloneCardHeader,
  StandaloneCardNote,
  StandalonePage,
  StandalonePageIcon,
} from "../ui/standalone-page";

function ConnectCliRequestRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: string;
}) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-35 shrink-0 text-dim-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-foreground">{children}</dd>
    </div>
  );
}

/**
 * /connect waits for approval before sending the CLI's PKCE request to Clerk.
 * Approval signs in if needed; cancellation answers through the same loopback callback.
 * Headless hosts use Clerk's device authorization page instead.
 */
export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const [redirecting, setRedirecting] = useState(false);
  const redirectingRef = useRef(false);

  const authorize = () => {
    if (!request || !isLoaded || redirectingRef.current) {
      return;
    }
    if (!isSignedIn) {
      clerk.openSignIn(
        resolveClerkSignInProps(
          connectCliSignInRedirectUrl(request, window.location.href),
          isElectron,
        ),
      );
      return;
    }
    const authorizeUrl = buildConnectCliClerkAuthorizeUrl(request);
    if (!authorizeUrl) {
      return;
    }
    redirectingRef.current = true;
    setRedirecting(true);
    window.location.assign(authorizeUrl);
  };

  const cancel = () => {
    if (!request || redirectingRef.current) {
      return;
    }
    redirectingRef.current = true;
    setRedirecting(true);
    window.location.assign(connectLoopbackCancelUrl(request));
  };

  if (!request) {
    return (
      <StandalonePage tone="plain" size="card">
        <StandalonePageIcon tone="error">
          <SquareTerminalIcon />
        </StandalonePageIcon>
        <StandaloneCardHeader
          title="This connect link is incomplete"
          description="The link is missing its authorization request. Re-run `t3 connect` in your terminal and open the freshly printed URL."
        />
      </StandalonePage>
    );
  }

  return (
    <StandalonePage tone="plain" size="card">
      <StandalonePageIcon>
        <SquareTerminalIcon />
      </StandalonePageIcon>
      <StandaloneCardHeader
        title="Connecting your terminal"
        description={
          redirecting
            ? "Redirecting to authorize T3 Connect for your CLI…"
            : isSignedIn
              ? "Authorize T3 Connect for your CLI. Check that the code matches your terminal."
              : "Sign in to continue authorizing T3 Connect for your CLI."
        }
      />

      <dl className="flex flex-col gap-1.5 rounded-lg surface-well px-3 py-2.5 text-meta">
        <ConnectCliRequestRow label="Authorization request">t3 connect login</ConnectCliRequestRow>
        {request.device ? (
          <ConnectCliRequestRow label="Device">{request.device}</ConnectCliRequestRow>
        ) : null}
        <ConnectCliRequestRow label="Code">
          {connectAuthorizeRequestCode(request.state)}
        </ConnectCliRequestRow>
      </dl>

      <form
        className="flex flex-wrap justify-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          authorize();
        }}
      >
        <Button disabled={redirecting} onClick={cancel} size="sm" type="button" variant="secondary">
          Cancel
        </Button>
        <Button autoFocus disabled={!isLoaded || redirecting} size="sm" type="submit">
          {redirecting ? <Spinner /> : null}
          {isSignedIn ? "Authorize" : "Sign in and authorize"}
          {redirecting ? null : <Kbd>⏎</Kbd>}
        </Button>
      </form>

      <StandaloneCardNote>
        Browser authorization · the terminal continues once you approve.
      </StandaloneCardNote>
    </StandalonePage>
  );
}
