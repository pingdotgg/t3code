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
import { useTranslation } from "react-i18next";

import { isElectron } from "../../env";
import { translateDynamic } from "../../i18nCore";
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
          : translateDynamic("onboarding:connect.unreachable"),
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
  const { t } = useTranslation("onboarding");
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
    return <Message title={t("auth.incompleteTitle")} description={t("auth.startAgain")} />;
  }

  if (framed) {
    return (
      <Message title={t("auth.ownWindowTitle")} description={t("auth.ownWindowDescription")} />
    );
  }

  if (loadFailed) {
    return (
      <Message title={t("auth.loadFailedTitle")} description={t("auth.loadFailedDescription")}>
        <div className="mt-6">
          <Button type="button" onClick={retryClerkLoad}>
            {t("phone.retrySignIn")}
          </Button>
        </div>
      </Message>
    );
  }

  if (!isLoaded || (isSignedIn && session === null)) {
    return (
      <StandalonePage>
        <StandalonePageHeader
          context={t("auth.context")}
          title={t("auth.connectingTitle")}
          description={t("auth.connectingDescription")}
        />
        <Spinner className="mt-6" size="lg" tone="muted" />
      </StandalonePage>
    );
  }

  if (!isSignedIn) {
    return (
      <Message
        title={t("auth.signInToApproveTitle")}
        description={t("auth.signInToApproveDescription")}
      >
        <div className="mt-6">
          <Button type="button" onClick={openSignIn}>
            {t("auth.signIn")}
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
              {t("auth.useCodeInstead")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="link"
            onClick={() => void clerk.signOut({ redirectUrl: window.location.href })}
            type="button"
          >
            {t("auth.useAnotherAccount")}
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
  const { t } = useTranslation("onboarding");
  return (
    <StandalonePage>
      <StandalonePageHeader context={t("auth.context")} title={title} description={description} />
      {children}
    </StandalonePage>
  );
}
