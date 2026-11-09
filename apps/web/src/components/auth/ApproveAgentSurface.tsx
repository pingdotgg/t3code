import { useAuth, useClerk } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { ConnectApprovalCodeError } from "@t3tools/client-runtime/state/peerPairingCode";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { approvedReturnUrl, readApproveAgentRequest } from "../../cloud/connectAgentApproval";
import { isElectron } from "../../env";
import { mintConnectMcpApprovalCode } from "../../state/peerPairingCode";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

const isConnectApprovalCodeError = Schema.is(ConnectApprovalCodeError);

/** Signs in to T3 Connect, mints an app approval code, and returns it to the sign-in page. */
export function ApproveAgentSurface() {
  const [request] = useState(() => readApproveAgentRequest(new URL(window.location.href)));
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const session = useAtomValue(managedRelaySessionAtom);
  const [failure, setFailure] = useState<string | null>(null);
  const signInOpened = useRef(false);
  const started = useRef(false);

  const openSignIn = () =>
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  const openSignInOnLoad = useEffectEvent(openSignIn);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens Clerk sign-in, then mints the code once the relay session is ready and navigates the window back
  useEffect(() => {
    if (!request || !isLoaded) return;
    if (!isSignedIn) {
      if (!signInOpened.current) {
        signInOpened.current = true;
        openSignInOnLoad();
      }
      return;
    }
    if (session === null || started.current) return;
    started.current = true;
    void mintConnectMcpApprovalCode({
      environmentId: request.environmentId,
      pageOrigin: request.returnTo.origin,
      access: request.access,
    }).then((result) => {
      if (Result.isSuccess(result)) {
        window.location.replace(approvedReturnUrl(request, result.success));
        return;
      }
      setFailure(
        isConnectApprovalCodeError(result.failure)
          ? result.failure.message
          : "Could not approve the sign-in. Try again from the app.",
      );
    });
  }, [isLoaded, isSignedIn, request, session]);

  if (!request) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          context="Agent sign-in"
          title="This sign-in link is incomplete"
          description="Close this page and start the sign-in again from your agent."
        />
      </StandalonePage>
    );
  }

  if (failure !== null) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          context="Agent sign-in"
          title="This sign-in cannot continue"
          description={failure}
        />
        <p className="mt-4 text-sm text-muted-foreground">
          You can still go back and paste a sign-in code instead.
        </p>
        <div className="mt-6">
          <Button
            type="button"
            variant="outline"
            onClick={() => void clerk.signOut({ redirectUrl: window.location.href })}
          >
            Use another account
          </Button>
        </div>
      </StandalonePage>
    );
  }

  return (
    <StandalonePage>
      <StandalonePageHeader
        context="Agent sign-in"
        title={`Approving on ${request.returnTo.host}`}
        description={
          isLoaded && !isSignedIn
            ? "Sign in to T3 Connect with the account this environment is linked to."
            : "Checking that this environment belongs to your account…"
        }
      />
      {isLoaded && !isSignedIn ? (
        <div className="mt-6">
          <Button type="button" onClick={openSignIn}>
            Sign in
          </Button>
        </div>
      ) : (
        <Spinner className="mt-6" size="lg" tone="muted" />
      )}
    </StandalonePage>
  );
}
