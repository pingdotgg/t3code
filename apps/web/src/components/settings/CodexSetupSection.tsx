import { AuthProvidersManageScope, ProviderDriverKind } from "@t3tools/contracts";
import { readPreparedConnection, useEnvironmentScope } from "../../state/session";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ChatGptHandoffInput,
  ChatGptTransferredProfile,
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { codexAuthHandoffUrl } from "@t3tools/shared/codexAuthHandoff";
import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import {
  Children,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ensureLocalApi } from "../../localApi";
import { managedInstanceLocks, useManagedPolicy } from "../../state/managedPolicy";
import { ManagedControl } from "../ManagedPolicy";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { waitForQuerySettled } from "../../state/waitForQuerySettled";
import { Button } from "../ui/button";
import { ChatGptConnectionButton } from "./ChatGptConnectionButton";
import { ChatGptUsageButton } from "./ChatGptUsageButton";
import { ChatGptAccountPicker } from "./ChatGptAccountPicker";
import { Input } from "../ui/input";
import { OpenAI } from "../Icons";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow } from "./settingsLayout";
import { AddCodexAccountDialog } from "./AddCodexAccountDialog";
import { getOnboardingProviderState } from "../../onboarding/providerReadiness.logic";
import { getProviderSummary } from "./providerStatus";
import {
  settleAuthorizationPage,
  settleHandoffAuthorizationPage,
  settleProviderInstall,
} from "./CodexSetupSection.logic";
import { CodexSetupSection } from "./CodexSetupSectionParts";
import { noop } from "./codexSetupRouting";
import { useManagedCodexSetupState } from "./useManagedCodexSetupState";
import { CodexSignInDescription, CodexWelcomeCard } from "./CodexSetupCards.tsx";
export function AddManagedCodexAccountDialog({
  environmentId,
  onClose,
  onAccountCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onAccountCreated?:
    | ((instanceId: ProviderInstanceId, displayName: string) => void)
    | undefined;
}) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  return (
    <AddCodexAccountDialog
      environmentId={environmentId}
      onClose={onClose}
      onAccountCreated={onAccountCreated}
      renderSetup={(instanceId, provider) => (
        <ManagedCodexSetup
          key={instanceId}
          environmentId={environmentId}
          instanceId={instanceId}
          provider={provider}
          mode="managed"
          enabled
          readOnly={!canManageProviders}
          autoStart
          onAutoStartConsumed={noop}
          onModeChange={noop}
          onSignInCancelled={onClose}
          allowExistingCli={false}
        />
      )}
    />
  );
}

export * from "./CodexSetupCards";

export interface CodexSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly mode: "managed" | "existing";
  readonly enabled: boolean;
  readonly readOnly?: boolean;
  readonly presentation?: "settings" | "onboarding";
  readonly onModeChange: (mode: "managed" | "existing") => void;
  readonly autoStart?: boolean;
  readonly displayName?: string | undefined;
  readonly onAutoStartConsumed?: () => void;
  readonly onSignInCancelled?: (() => void) | undefined;
}

export function ManagedCodexSetup(
  props: CodexSetupSectionProps & {
    readonly autoStart: boolean;
    readonly onAutoStartConsumed: () => void;
    readonly allowExistingCli?: boolean;
  },
) {
  const {
    environmentId,
    instanceId,
    displayName,
    presentation,
    readOnly,
    enabled,
    mode,
    provider,
    onModeChange,
    onSignInCancelled,
    allowExistingCli,
  } = props;
  const {
    abortOperation,
    accountDescription,
    accountPicker,
    accountPickerOpen,
    auth,
    authActive,
    authInProgress,
    authQuery,
    authenticated,
    autoStartHandled,
    awaitingProvider,
    beginOperation,
    busy,
    callbackCompletion,
    callbackDraft,
    callbackFallback,
    callbackHelpContent,
    callbackHelpId,
    callbackHelpOpen,
    callbackUrl,
    cancelAuth,
    cancelInstall,
    cancelSignIn,
    clientCallback,
    completeAuth,
    error,
    finishingSignIn,
    handoff,
    handoffId,
    handoffQuery,
    handoffSequence,
    handoffUrl,
    hasSavedAccount,
    httpBaseUrl,
    importProfile,
    importedAttempt,
    installActive,
    installQuery,
    installation,
    installed,
    local,
    logoutAuth,
    logoutWarning,
    needsManualCallback,
    openPage,
    operation,
    options,
    pending,
    pendingRef,
    receivingCallback,
    reconnectEmail,
    reconnectProfile,
    refreshProviders,
    remoteWeb,
    requestedAccountEmail,
    requestedMethodId,
    returnUrl,
    run,
    runtimeDescription,
    setAccountPickerOpen,
    setAutoStartHandled,
    setAwaitingProvider,
    setCallbackDraft,
    setCallbackHelpOpen,
    setError,
    setHandoff,
    setPending,
    setRequestedMethodId,
    setTransferFailed,
    setup,
    signIn,
    startAuth,
    startAutomatically,
    startInstall,
    startingAutomatically,
    target,
    transferFailed,
    transferFinishedProfile,
    transferProfile,
    unavailable,
    updateAvailable,
    url,
    waitingControl,
    waitingForAuthState,
  } = useManagedCodexSetupState(props);

  if (presentation === "onboarding") {
    const setupError =
      logoutWarning ??
      error ??
      (authQuery.error || installQuery.error
        ? "Could not read setup status. Reconnect and try again."
        : installation?.phase === "failed"
          ? installation.message
          : null);
    return (
      <>
        {accountPicker}
        <CodexWelcomeCard
          title={displayName || provider?.displayName || "Codex"}
          description={
            installActive ? (
              runtimeDescription
            ) : authenticated ? (
              provider?.auth.email?.trim() ? (
                <>
                  Signed in as{" "}
                  <RedactedSensitiveText
                    value={provider.auth.email.trim()}
                    ariaLabel="Toggle account email visibility"
                    revealTooltip="Click to reveal email"
                    hideTooltip="Click to hide email"
                    className="break-all"
                  />
                  .
                </>
              ) : (
                "Connected to ChatGPT."
              )
            ) : callbackCompletion && !needsManualCallback ? (
              <CodexSignInDescription
                expanded={callbackHelpOpen}
                controls={callbackHelpId}
                onToggle={() => setCallbackHelpOpen((open) => !open)}
              />
            ) : startingAutomatically ||
              waitingForAuthState ||
              auth?.phase === "starting" ||
              auth?.phase === "waiting" ||
              (pending && !installActive) ? (
              <CodexSignInDescription />
            ) : authActive || auth?.phase === "failed" || auth?.phase === "cancelled" ? (
              accountDescription
            ) : (
              "Code with your ChatGPT subscription."
            )
          }
          control={
            authenticated && !busy ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
                <CheckIcon className="size-3.5" />
                Ready
              </span>
            ) : authActive ? (
              waitingControl
            ) : (
              <ChatGptConnectionButton
                size="sm"
                disabled={
                  unavailable ||
                  busy ||
                  (!installed ? !provider?.setup?.canInstall : !provider?.setup?.canAuthenticate)
                }
                onClick={() => {
                  if (hasSavedAccount) setAccountPickerOpen(true);
                  else void setup();
                }}
              >
                {installActive || pending
                  ? "Setting up..."
                  : hasSavedAccount
                    ? "Reconnect account"
                    : "Continue with ChatGPT"}
              </ChatGptConnectionButton>
            )
          }
          secondaryControl={
            (authActive && !finishingSignIn) || installActive ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={pending || readOnly}
                onClick={() => {
                  abortOperation();
                  if (handoff || (authActive && auth?.flowId)) void cancelSignIn();
                  else if (installation?.operationId)
                    void run(() =>
                      cancelInstall({
                        environmentId,
                        input: { instanceId, operationId: installation.operationId! },
                      }),
                    );
                }}
              >
                Cancel
              </Button>
            ) : !authActive && !authenticated && hasSavedAccount ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={unavailable || busy}
                onClick={() => void setup("chatgpt-change-account")}
              >
                Use a different account
              </Button>
            ) : !authActive && !authenticated && allowExistingCli ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={readOnly || busy}
                onClick={() => onModeChange("existing")}
              >
                Use existing CLI
              </Button>
            ) : null
          }
        >
          {needsManualCallback ? callbackFallback : callbackHelpContent}
          {setupError ? (
            <p role="alert" className="text-xs text-destructive">
              {setupError}
            </p>
          ) : null}
        </CodexWelcomeCard>
      </>
    );
  }

  return (
    <section aria-label="Codex setup" className="divide-y divide-border/50">
      {accountPicker}
      <SettingsRow
        title="ChatGPT account"
        description={accountDescription}
        control={
          <div className="flex max-w-88 flex-wrap items-center justify-end gap-2">
            {authActive ? (
              <>
                {waitingControl}
                {!finishingSignIn && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending || readOnly}
                    onClick={() => {
                      if (!handoff && !auth?.flowId) return;
                      abortOperation();
                      void cancelSignIn();
                      onSignInCancelled?.();
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </>
            ) : installActive ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending || readOnly}
                onClick={() => {
                  if (!installation?.operationId) return;
                  abortOperation();
                  void run(() =>
                    cancelInstall({
                      environmentId,
                      input: { instanceId, operationId: installation.operationId! },
                    }),
                  );
                }}
              >
                Cancel
              </Button>
            ) : authenticated ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={unavailable || busy}
                  onClick={() => setAccountPickerOpen(true)}
                >
                  Change account
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={unavailable || busy}
                  onClick={() => void run(() => logoutAuth(target))}
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <>
                <ChatGptConnectionButton
                  size="sm"
                  disabled={
                    unavailable ||
                    busy ||
                    (!installed ? !provider?.setup?.canInstall : !provider?.setup?.canAuthenticate)
                  }
                  onClick={() => {
                    if (hasSavedAccount) setAccountPickerOpen(true);
                    else void setup();
                  }}
                >
                  {pending
                    ? "Setting up..."
                    : hasSavedAccount
                      ? "Reconnect account"
                      : "Continue with ChatGPT"}
                </ChatGptConnectionButton>
                {hasSavedAccount ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={unavailable || busy}
                    onClick={() => void setup("chatgpt-change-account")}
                  >
                    Use a different account
                  </Button>
                ) : null}
                {allowExistingCli ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={readOnly || busy}
                    onClick={() => onModeChange("existing")}
                  >
                    Use existing CLI
                  </Button>
                ) : null}
              </>
            )}
          </div>
        }
      />
      {authenticated ? (
        <div className="flex justify-end px-3 py-1 sm:px-4">
          <ChatGptUsageButton />
        </div>
      ) : null}
      {logoutWarning ? (
        <p role="alert" className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          {logoutWarning}
        </p>
      ) : null}
      {callbackFallback ? <div className="px-3 py-3 sm:px-4">{callbackFallback}</div> : null}
      {error || authQuery.error || installQuery.error || installation?.phase === "failed" ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive sm:px-4">
          {error ??
            (installation?.phase === "failed"
              ? installation.message
              : "Could not read Codex setup status. Reconnect and try again.")}
        </p>
      ) : null}
    </section>
  );
}

export * from "./CodexSetupSectionParts";
