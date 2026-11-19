import { useAuth, useClerk } from "@clerk/react";
import {
  connectAuthorizeRequestCode,
  connectLoopbackCancelUrl,
  readConnectAuthorizeRequest,
} from "@t3tools/shared/connectAuth";
import { T, useGT } from "gt-react";
import { SquareTerminalIcon } from "lucide-react";
import { useState } from "react";

import {
  buildConnectCliClerkAuthorizeUrl,
  connectCliSignInRedirectUrl,
} from "../../cloud/connectCliAuth";
import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { retryClerkLoad, useClerkLoadFailed } from "../clerk/clerkLoadFailure";
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
  const gt = useGT();
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const loadFailed = useClerkLoadFailed();
  const [redirecting, setRedirecting] = useState(false);

  const authorize = () => {
    if (!request || !isLoaded || redirecting) {
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
    setRedirecting(true);
    window.location.assign(authorizeUrl);
  };

  const cancel = () => {
    if (!request || redirecting) {
      return;
    }
    setRedirecting(true);
    window.location.assign(connectLoopbackCancelUrl(request));
  };

  if (!request) {
    return (
      <StandalonePage size="card">
        <StandalonePageIcon tone="error">
          <SquareTerminalIcon />
        </StandalonePageIcon>
        <StandaloneCardHeader
          title={gt("This connect link is incomplete")}
          description={gt(
            "The link is missing its authorization request. Re-run `t3 connect` in your terminal and open the freshly printed URL.",
          )}
        />
      </StandalonePage>
    );
  }

  return (
    <StandalonePage size="card">
      <StandalonePageIcon>
        <SquareTerminalIcon />
      </StandalonePageIcon>
      <StandaloneCardHeader
        title={gt("Connecting your terminal")}
        description={
          redirecting
            ? gt("Redirecting to authorize T3 Connect for your CLI…")
            : isSignedIn
              ? gt("Authorize T3 Connect for your CLI. Check that the code matches your terminal.")
              : gt("Sign in to continue authorizing T3 Connect for your CLI.")
        }
      />

      <dl className="flex flex-col gap-1.5 rounded-lg surface-well px-3 py-2.5 text-meta">
        <ConnectCliRequestRow label={gt("Authorization request")}>
          {/* oxlint-disable-next-line t3code/no-untranslated-copy -- CLI command */}
          {"t3 connect login"}
        </ConnectCliRequestRow>
        {request.device ? (
          <ConnectCliRequestRow
            label={gt("Device", { $context: "the device requesting CLI login" })}
          >
            {request.device}
          </ConnectCliRequestRow>
        ) : null}
        <ConnectCliRequestRow
          label={gt("Code", { $context: "authorization code shown in the terminal" })}
        >
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
          <T>Cancel</T>
        </Button>
        {loadFailed ? (
          <Button size="sm" type="button" onClick={retryClerkLoad}>
            <T>Retry sign-in</T>
          </Button>
        ) : (
          <Button autoFocus disabled={!isLoaded || redirecting} size="sm" type="submit">
            {redirecting ? <Spinner /> : null}
            {isSignedIn
              ? gt("Authorize", { $context: "verb, approves the CLI login" })
              : gt("Sign in and authorize")}
            {redirecting ? null : <Kbd>⏎</Kbd>}
          </Button>
        )}
      </form>

      <StandaloneCardNote>
        <T>The terminal continues once you approve.</T>
      </StandaloneCardNote>
    </StandalonePage>
  );
}
