import { useAuth, useClerk } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  type ConnectMcpApprovalCall,
  ConnectMcpApprovalUnavailableError,
} from "@t3tools/client-runtime/state/connectMcpApproval";
import { type AuthMcpApprovalDetails, EnvironmentId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../../env";
import { runConnectMcpApproval } from "../../state/connectMcpApproval";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { retryClerkLoad, useClerkLoadFailed } from "../clerk/clerkLoadFailure";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import {
  type McpApprovalAnswer,
  type McpApprovalTransport,
  McpConsent,
  readAuthorizationRequest,
} from "./ConnectAgentSurface";

const isUnavailable = Schema.is(ConnectMcpApprovalUnavailableError);

function readEnvironmentId(): EnvironmentId | null {
  const value = new URL(window.location.href).searchParams.get("environment");
  return value ? EnvironmentId.make(value) : null;
}

/** Sends each call with the owner's T3 Connect session and remembers where the environment is. */
function connectTransport(
  environmentId: EnvironmentId,
  onEnvironment: (environment: { readonly url: string; readonly label: string }) => void,
): McpApprovalTransport {
  const send = async (
    call: ConnectMcpApprovalCall,
  ): Promise<McpApprovalAnswer<AuthMcpApprovalDetails>> => {
    const result = await runConnectMcpApproval(environmentId, call);
    if (Result.isFailure(result)) {
      return {
        kind: "error",
        message: isUnavailable(result.failure)
          ? result.failure.message
          : "Could not reach this environment. Try again.",
      };
    }
    onEnvironment({
      url: result.success.environmentUrl,
      label: result.success.environmentLabel,
    });
    const { answer } = result.success;
    switch (answer.kind) {
      case "details":
        return { kind: "ok", value: answer.details };
      case "redirect":
        return { kind: "redirect", url: answer.url };
      case "refused":
        return { kind: "error", message: answer.message };
    }
  };
  return {
    load: (authorization) => send({ kind: "approval", payload: authorization }),
    decide: (authorization, decision) =>
      send({ kind: "decision", payload: { authorization, decision } }),
  };
}

/**
 * The consent screen for an agent sign-in on a T3 Connect environment: the owner signs in to
 * T3 Connect here and approves with that session, so no sign-in code is needed.
 */
export function ApproveAgentSurface() {
  const [environmentId] = useState(readEnvironmentId);
  const [authorization] = useState(readAuthorizationRequest);
  // Another site could frame this page and steer a click onto Approve.
  const [framed] = useState(() => window.top !== window.self);
  const [environment, setEnvironment] = useState<{
    readonly url: string;
    readonly label: string;
  } | null>(null);
  const [transport] = useState(() =>
    environmentId === null ? null : connectTransport(environmentId, setEnvironment),
  );
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const loadFailed = useClerkLoadFailed();
  const session = useAtomValue(managedRelaySessionAtom);
  const signInOpened = useRef(false);

  const openSignIn = () =>
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  const openSignInOnLoad = useEffectEvent(openSignIn);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens Clerk sign-in once Clerk has loaded and nobody is signed in
  useEffect(() => {
    if (!isLoaded || isSignedIn || signInOpened.current || framed) return;
    signInOpened.current = true;
    openSignInOnLoad();
  }, [framed, isLoaded, isSignedIn]);

  if (environmentId === null || transport === null) {
    return (
      <Message
        title="This sign-in link is incomplete"
        description="Close this page and start the sign-in again from your agent."
      />
    );
  }

  if (framed) {
    return (
      <Message
        title="Open this page in its own window"
        description="For your safety, agent sign-ins cannot be approved inside another site."
      />
    );
  }

  if (loadFailed) {
    return (
      <Message
        title="Could not load sign-in"
        description="T3 Connect sign-in did not load. Check your connection, then try again."
      >
        <div className="mt-6">
          <Button type="button" onClick={retryClerkLoad}>
            Retry sign-in
          </Button>
        </div>
      </Message>
    );
  }

  if (!isLoaded || (isSignedIn && session === null)) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          context="Agent sign-in"
          title="Connecting to T3 Connect"
          description="One moment while your account loads."
        />
        <Spinner className="mt-6" size="lg" tone="muted" />
      </StandalonePage>
    );
  }

  if (!isSignedIn) {
    return (
      <Message
        title="Sign in to approve"
        description="Sign in to T3 Connect with the account this environment is linked to."
      >
        <div className="mt-6">
          <Button type="button" onClick={openSignIn}>
            Sign in
          </Button>
        </div>
      </Message>
    );
  }

  const search = new URLSearchParams(window.location.search);
  search.delete("environment");
  return (
    <McpConsent
      authorization={authorization}
      transport={transport}
      requireLevelChoice
      environmentLabel={environment?.label}
      footer={
        <div className="mt-6 flex flex-wrap gap-2">
          {environment ? (
            <Button
              size="sm"
              variant="link"
              render={
                <a href={`${new URL("/connect-agent", environment.url).toString()}?${search}`} />
              }
            >
              Use a sign-in code instead
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="link"
            onClick={() => void clerk.signOut({ redirectUrl: window.location.href })}
            type="button"
          >
            Use another account
          </Button>
        </div>
      }
    />
  );
}

function Message({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <StandalonePage>
      <StandalonePageHeader context="Agent sign-in" title={title} description={description} />
      {children}
    </StandalonePage>
  );
}
