import type { CodexSetupSectionProps } from "./CodexSetupSection";
import { isLoopbackUrl, prefersClientCallback, readSignInRouting } from "./codexSetupRouting";

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
import { CodexSignInDescription, CodexWelcomeCard } from "./CodexSetupCards.tsx";

type ManagedCodexSetupStateProps = CodexSetupSectionProps & {
  readonly autoStart: boolean;
  readonly onAutoStartConsumed: () => void;
  readonly allowExistingCli?: boolean;
};

/**
 * Everything `ManagedCodexSetup` derives before it paints: the auth/install
 * queries, the sign-in state machine and the strings those feed.
 */
export function useManagedCodexSetupState(props: ManagedCodexSetupStateProps) {
  const {
    environmentId,
    instanceId,
    provider,
    enabled,
    readOnly,
    onModeChange,
    autoStart,
    onAutoStartConsumed,
    allowExistingCli = true,
    presentation,
    displayName,
    onSignInCancelled,
  } = props;

  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const installQuery = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const [handoff, setHandoff] = useState<{
    environmentId: EnvironmentId;
    input: ChatGptHandoffInput;
  } | null>(null);
  const handoffQuery = useEnvironmentQuery(
    handoff ? serverEnvironment.chatGptHandoffState(handoff) : null,
  );
  const auth = handoffQuery.data?.phase === "auth" ? handoffQuery.data.state : authQuery.data;
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [requestedMethodId, setRequestedMethodId] = useState("chatgpt");
  const reconnectEmail = auth?.methods?.find((method) => method.id === "chatgpt")?.accountEmail;
  const requestedAccountEmail = auth?.methods?.find(
    (method) => method.id === requestedMethodId,
  )?.accountEmail;
  const hasSavedAccount = auth?.methods?.some((method) => method.id.startsWith("chatgpt-profile:"));
  const url = auth?.interaction?.type === "browser" ? auth.interaction.url : auth?.authorizationUrl;
  const installation = installQuery.data;
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const local = isLoopbackUrl(httpBaseUrl);
  const options = { reportFailure: false, reportDefect: false };
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, options);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, options);
  const completeAuth = useAtomCommand(serverEnvironment.completeProviderAuth, options);
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, options);
  const logoutAuth = useAtomCommand(serverEnvironment.logoutProviderAuth, options);
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, options);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, options);
  const reconnectProfile = useAtomCommand(serverEnvironment.chatGptReconnectProfile, options);
  const importProfile = useAtomCommand(serverEnvironment.chatGptImportProfile, options);
  const clientCallback = !handoff && prefersClientCallback(local);
  const remoteWeb = clientCallback && !window.desktopBridge;
  const returnUrl = new URL(window.location.href);
  if (returnUrl.pathname === "/welcome") returnUrl.hash = `agents:${environmentId}`;
  if (returnUrl.pathname === "/settings/providers")
    returnUrl.searchParams.set("instanceId", instanceId);
  const needsManualCallback = remoteWeb;
  const callbackHelpId = useId();
  const [callbackHelpOpen, setCallbackHelpOpen] = useState(false);
  const [callbackDraft, setCallbackDraft] = useState({ flowId: "", value: "" });
  const callbackUrl = callbackDraft.flowId === auth?.flowId ? callbackDraft.value : "";
  const [pending, setPending] = useState(false);
  const [awaitingProvider, setAwaitingProvider] = useState<"sign-in" | "handoff" | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // The setup or sign-in this client started. Its follow-up steps (sign in
  // once the install lands, open the page once the flow waits) belong to it
  // alone, so Cancel, a new attempt, or unmounting abort them.
  const operation = useRef<AbortController | null>(null);
  const beginOperation = () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    return controller.signal;
  };
  const abortOperation = () => operation.current?.abort();
  // Once the card unmounts, nothing may start a sign-in or open a page on its behalf.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the in-flight setup or sign-in AbortController on unmount
  useEffect(() => () => operation.current?.abort(), []);
  const [autoStartHandled, setAutoStartHandled] = useState(false);
  const installed = installation?.installedVersion != null;
  const authenticated = provider?.auth.status === "authenticated";
  const updateAvailable =
    installed &&
    installation?.source !== "local" &&
    installation?.version != null &&
    installation.version !== installation.installedVersion;
  const finishingSignIn =
    awaitingProvider !== null &&
    !authenticated &&
    (auth?.phase === "succeeded" || awaitingProvider === "handoff");
  if (
    awaitingProvider !== null &&
    (authenticated || auth?.phase === "failed" || auth?.phase === "cancelled")
  ) {
    setAwaitingProvider(null);
  }
  // The server does not refresh the provider snapshot when a sign-in flow
  // succeeds, and the flow can finish elsewhere (callback, pasted redirect URL).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to refresh the provider snapshot once the sign-in flow succeeds
  useEffect(() => {
    if (awaitingProvider && auth?.phase === "succeeded") {
      void refreshProviders({ environmentId, input: { instanceId } });
    }
  }, [awaitingProvider, auth?.phase, refreshProviders, environmentId, instanceId]);
  const startingAutomatically = autoStart && !autoStartHandled;
  const waitingForAuthState =
    awaitingProvider === "sign-in" && !authenticated && (auth === null || auth.phase === "idle");
  const authInProgress =
    finishingSignIn ||
    waitingForAuthState ||
    handoff !== null ||
    auth?.phase === "starting" ||
    auth?.phase === "waiting" ||
    auth?.phase === "verifying";
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const authActive = startingAutomatically || authInProgress || (pending && !installActive);
  const unavailable =
    readOnly || !enabled || pending || authQuery.error !== null || installQuery.error !== null;
  const busy = pending || authInProgress || installActive;

  const run = async <A, E>(
    request: () => Promise<AtomCommandResult<A, E>>,
    onSuccess?: (value: A) => void,
  ) => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    let succeeded = false;
    try {
      const result = await request();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Codex setup failed. Try again.");
        }
      } else {
        succeeded = true;
        onSuccess?.(result.value);
      }
    } catch {
      setError("Codex setup failed. Try again.");
    }
    pendingRef.current = false;
    setPending(false);
    return succeeded;
  };

  const handoffId = useId();
  const handoffSequence = useRef(0);
  const importedAttempt = useRef<string | null>(null);
  const [transferFailed, setTransferFailed] = useState(false);
  const transferProfile = async (profile: ChatGptTransferredProfile) => {
    const succeeded = await run(() =>
      importProfile({ environmentId, input: { instanceId, profile } }),
    );
    if (succeeded) {
      setAwaitingProvider("handoff");
      setHandoff(null);
    }
    setTransferFailed(!succeeded);
  };
  const transferFinishedProfile = useEffectEvent((profile: ChatGptTransferredProfile) =>
    transferProfile(profile),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- imports the finished handoff profile to the server once per attempt when the handoff query completes
  useEffect(() => {
    if (!handoff || handoffQuery.data?.phase !== "finished") return;
    const attemptId = handoff.input.attemptId;
    if (importedAttempt.current === attemptId) return;
    importedAttempt.current = attemptId;
    void transferFinishedProfile(handoffQuery.data.profile);
  }, [handoff, handoffQuery.data]);
  if (
    handoff &&
    (handoffQuery.error ||
      (handoffQuery.data?.phase === "auth" &&
        ["failed", "cancelled"].includes(handoffQuery.data.state.phase)))
  ) {
    setError(
      handoffQuery.data?.phase === "auth"
        ? (handoffQuery.data.state.message ?? "ChatGPT sign-in could not finish. Try again.")
        : "ChatGPT sign-in on the primary environment was interrupted. Try again.",
    );
    setHandoff(null);
  }
  const cancelSignIn = () => {
    setAwaitingProvider(null);
    if (handoff) {
      setHandoff(null);
      return Promise.resolve();
    }
    return run(() => cancelAuth({ environmentId, input: { instanceId, flowId: auth!.flowId! } }));
  };

  const receivingCallback = useRef<string | null>(null);
  const openPage = async (
    authorizationUrl: string,
    flowId: string | null,
    viaClientCallback: boolean,
  ) => {
    try {
      const receive = window.desktopBridge?.receiveProviderAuthCallback;
      if (receive && viaClientCallback && flowId) {
        if (receivingCallback.current === authorizationUrl) {
          await ensureLocalApi().shell.openExternal(authorizationUrl);
          return;
        }
        receivingCallback.current = authorizationUrl;
        const callbackUrl = await receive(authorizationUrl);
        if (receivingCallback.current !== authorizationUrl) return;
        receivingCallback.current = null;
        await run(() =>
          completeAuth({ environmentId, input: { instanceId, flowId, callbackUrl } }),
        );
      } else {
        await ensureLocalApi().shell.openExternal(authorizationUrl);
      }
    } catch {
      setError(
        "Could not finish sign-in on this computer. Try again or paste the redirect URL below.",
      );
    }
  };

  const signIn = async (methodId: string, signal: AbortSignal) => {
    if (pendingRef.current) return;
    setTransferFailed(false);
    setRequestedMethodId(methodId);
    const returnUrl = new URL(window.location.href);
    if (returnUrl.pathname === "/welcome") returnUrl.hash = `agents:${environmentId}`;
    if (returnUrl.pathname === "/settings/providers")
      returnUrl.searchParams.set("instanceId", instanceId);
    const { clientCallback, remoteWeb, primaryAuthEnvironmentId } =
      readSignInRouting(environmentId);
    if (primaryAuthEnvironmentId) {
      const attemptId = `${handoffId}:${++handoffSequence.current}`;
      await run(
        () => reconnectProfile({ environmentId, input: { instanceId, methodId } }),
        (profile) => {
          const nextHandoff = {
            environmentId: primaryAuthEnvironmentId,
            input: {
              instanceId,
              environmentId,
              attemptId,
              returnUrl: returnUrl.toString(),
              profile,
            },
          };
          setHandoff(nextHandoff);
          void waitForQuerySettled({
            registry: appAtomRegistry,
            atom: serverEnvironment.chatGptHandoffState(nextHandoff),
            settle: settleHandoffAuthorizationPage,
            signal,
          }).then((page) => {
            if (page && !signal.aborted) void openPage(page, null, false);
          });
        },
      );
      return;
    }
    await run(
      () =>
        startAuth({
          environmentId,
          input: {
            instanceId,
            methodId,
            returnUrl: returnUrl.toString(),
            callbackMode: clientCallback ? "client" : "server",
          },
        }),
      (started) => {
        setAwaitingProvider("sign-in");
        const startedFlowId = started.flowId;
        // A remote browser cannot receive the callback, so the user opens the page from the card.
        if (remoteWeb || startedFlowId === null) return;
        const startedPage = settleAuthorizationPage(started, startedFlowId);
        void (
          startedPage !== undefined
            ? Promise.resolve(startedPage)
            : waitForQuerySettled({
                registry: appAtomRegistry,
                atom: serverEnvironment.providerAuthState(target),
                settle: (state) => settleAuthorizationPage(state, startedFlowId),
                signal,
              })
        ).then((page) => {
          if (page && !signal.aborted) void openPage(page, startedFlowId, clientCallback);
        });
      },
    );
  };

  const setup = async (methodId = "chatgpt") => {
    if (unavailable || busy) return;
    const signal = beginOperation();
    if (installed && !updateAvailable) {
      await signIn(methodId, signal);
      return;
    }
    await run(
      () => startInstall({ environmentId, input: { instanceId } }),
      (started) => {
        void waitForQuerySettled({
          registry: appAtomRegistry,
          atom: serverEnvironment.providerInstallState(target),
          settle: (current) => settleProviderInstall(started, current),
          signal,
        }).then((ready) => {
          if (ready && !signal.aborted) void signIn(methodId, signal);
        });
      },
    );
  };

  if (
    autoStart &&
    !autoStartHandled &&
    !unavailable &&
    !busy &&
    installation !== null &&
    provider?.setup?.canInstall
  ) {
    setAutoStartHandled(true);
  }
  const startAutomatically = useEffectEvent(() => {
    onAutoStartConsumed();
    void setup();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dispatches the automatic setup server command after the auto-start flag commits
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Starting setup dispatches a server command, which marks itself pending before it awaits.
    if (autoStartHandled) startAutomatically();
  }, [autoStartHandled]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the desktop bridge provider auth callback when the URL changes or the card unmounts
  useEffect(() => {
    if (!clientCallback || !url || !window.desktopBridge) return;
    return () => {
      if (receivingCallback.current === url) receivingCallback.current = null;
      void window.desktopBridge?.cancelProviderAuthCallback(url).catch(() => undefined);
    };
  }, [clientCallback, url]);

  const runtimeDescription =
    installation?.phase === "downloading"
      ? `Downloading ${(installation.downloadedBytes / 1_000_000).toFixed(1)}${installation.totalBytes === null ? "" : ` of ${(installation.totalBytes / 1_000_000).toFixed(1)}`} MB.`
      : installation?.phase === "extracting"
        ? "Installing Codex."
        : installation?.phase === "verifying"
          ? "Checking Codex."
          : installed
            ? `${installation?.source === "local" ? "Using your installed Codex" : "Managed by T3 Code"}${installation?.installedVersion ? ` · v${installation.installedVersion}` : ""}.`
            : (installation?.message ?? "T3 Code downloads and manages Codex for you.");
  const accountDescription = finishingSignIn ? (
    "Finishing sign-in..."
  ) : installActive ? (
    runtimeDescription
  ) : authActive || auth?.phase === "failed" || auth?.phase === "cancelled" ? (
    auth?.phase === "waiting" && requestedAccountEmail ? (
      `Continue as ${requestedAccountEmail} on OpenAI.`
    ) : (
      (auth?.message ?? "Finish signing in in your browser.")
    )
  ) : authenticated ? (
    provider?.auth.email?.trim() ? (
      <>
        Signed in as{" "}
        <RedactedSensitiveText
          value={provider.auth.email.trim()}
          ariaLabel="Toggle account email visibility"
          revealTooltip="Click to reveal email"
          hideTooltip="Click to hide email"
        />
        .
      </>
    ) : (
      "Signed in with ChatGPT."
    )
  ) : (
    (reconnectEmail ?? "Use your ChatGPT subscription.")
  );

  const handoffUrl =
    needsManualCallback && url && auth?.flowId && providerAuthReturnUrl(returnUrl.toString())
      ? codexAuthHandoffUrl(
          {
            authorizationUrl: url,
            returnUrl: returnUrl.toString(),
            environmentId,
            instanceId,
            flowId: auth.flowId,
          },
          import.meta.env.DEV,
        )
      : null;
  const waitingControl = (
    <Button
      size="sm"
      variant={remoteWeb ? "default" : "outline"}
      className={presentation === "onboarding" ? "min-w-44" : undefined}
      disabled={
        handoffQuery.data?.phase === "finished"
          ? pending || !transferFailed
          : !url || auth?.phase !== "waiting"
      }
      onClick={() => {
        if (handoffQuery.data?.phase === "finished")
          void transferProfile(handoffQuery.data.profile);
        else if (url) void openPage(url, auth?.flowId ?? null, clientCallback);
      }}
    >
      {finishingSignIn
        ? "Finishing sign-in..."
        : handoffQuery.data?.phase === "finished"
          ? transferFailed
            ? "Retry connection"
            : "Finishing sign-in..."
          : auth?.phase === "waiting"
            ? remoteWeb
              ? "Open ChatGPT sign-in"
              : "Open sign-in page"
            : presentation === "onboarding"
              ? "Open sign-in page"
              : "Signing in..."}
    </Button>
  );
  const callbackCompletion =
    !handoff && auth?.phase === "waiting" && url ? (
      <div className="flex w-full flex-col gap-3 text-xs leading-relaxed text-muted-foreground">
        <p>If sign-in doesn't return to T3 Code, paste the URL from the final localhost page.</p>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            if (!auth.flowId || !callbackUrl.trim()) return;
            const value = callbackUrl.trim();
            const submittedFlowId = auth.flowId;
            void run(() =>
              completeAuth({
                environmentId,
                input: { instanceId, flowId: submittedFlowId, callbackUrl: value },
              }),
            ).then((connected) => {
              if (connected) setCallbackDraft({ flowId: submittedFlowId, value: "" });
            });
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              aria-label="ChatGPT sign-in redirect URL"
              type="password"
              autoComplete="off"
              placeholder="Paste the URL from the sign-in tab"
              value={callbackUrl}
              maxLength={16_384}
              disabled={pending || readOnly}
              onChange={(event) =>
                setCallbackDraft({ flowId: auth.flowId ?? "", value: event.target.value })
              }
            />
          </div>
          <Button
            variant="outline"
            type="submit"
            disabled={pending || readOnly || !callbackUrl.trim()}
          >
            Connect
          </Button>
        </form>
        {!remoteWeb ? (
          <div>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => void ensureLocalApi().shell.openExternal(url)}
            >
              Try sign-in in your browser
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
        {handoffUrl ? (
          <details>
            <summary className="cursor-pointer">Other ways to connect</summary>
            <Button className="mt-2" size="sm" variant="outline" render={<a href={handoffUrl} />}>
              Use T3 desktop for automatic return
            </Button>
          </details>
        ) : null}
      </div>
    ) : null;
  const callbackHelpContent =
    callbackCompletion && callbackHelpOpen ? (
      <div id={callbackHelpId} className="w-full border-t border-border/50 pt-3">
        {callbackCompletion}
      </div>
    ) : null;
  const callbackFallback = needsManualCallback ? (
    callbackCompletion
  ) : callbackCompletion ? (
    <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
      <CodexSignInDescription
        label="Having trouble signing in?"
        expanded={callbackHelpOpen}
        controls={callbackHelpId}
        onToggle={() => setCallbackHelpOpen((open) => !open)}
      />
      {callbackHelpContent}
    </div>
  ) : null;

  const accountPicker = (
    <ChatGptAccountPicker
      open={accountPickerOpen}
      methods={auth?.methods ?? []}
      onClose={() => setAccountPickerOpen(false)}
      onSelect={(methodId) => {
        setAccountPickerOpen(false);
        void setup(
          auth?.methods?.some((method) => method.id === methodId)
            ? methodId
            : "chatgpt-change-account",
        );
      }}
    />
  );

  const logoutWarning =
    auth?.phase === "idle" && auth.message?.startsWith("Signed out locally.") ? auth.message : null;


  return {
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
  };
}
