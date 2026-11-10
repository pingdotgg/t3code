import { useAtomValue } from "@effect/atom-react";
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
import { useT } from "../../hooks/useI18n";
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

const noop = () => undefined;

const isLoopbackUrl = (url: string | null) => url !== null && isLoopbackHost(new URL(url).hostname);

// A loopback server can receive the provider's callback itself, unless the
// desktop shell offers to catch it on the client.
const prefersClientCallback = (local: boolean) => !local || window.desktopBridge !== undefined;

/**
 * How a sign-in started now reaches the provider. Read at use time, because a
 * sign-in can start minutes after the click that asked for it (once an install
 * finishes), and the primary environment may have connected in between.
 */
function readSignInRouting(environmentId: EnvironmentId) {
  const local = isLoopbackUrl(readPreparedConnection(environmentId)?.httpBaseUrl ?? null);
  const clientCallback = prefersClientCallback(local);
  const primaryEnvironmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  const primaryAuthEnvironmentId =
    !local &&
    primaryEnvironmentId !== null &&
    appAtomRegistry.get(environmentPresentations.presentationAtom(primaryEnvironmentId))?.connection
      .phase === "connected" &&
    isLoopbackUrl(readPreparedConnection(primaryEnvironmentId)?.httpBaseUrl ?? null) &&
    (window.desktopBridge !== undefined || isLoopbackHost(window.location.hostname))
      ? primaryEnvironmentId
      : null;
  return {
    clientCallback,
    remoteWeb: clientCallback && !window.desktopBridge,
    primaryAuthEnvironmentId,
  };
}

interface CodexSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly mode: "managed" | "existing";
  readonly enabled: boolean;
  readonly readOnly?: boolean;
  // Onboarding's "Use existing CLI" opens a terminal, which this session may not be allowed.
  readonly existingCliDisabled?: boolean;
  readonly presentation?: "settings" | "onboarding";
  readonly onModeChange: (mode: "managed" | "existing") => void;
  readonly autoStart?: boolean;
  readonly displayName?: string | undefined;
  readonly onAutoStartConsumed?: () => void;
  readonly onSignInCancelled?: (() => void) | undefined;
}

export function CodexSetupSection(props: CodexSetupSectionProps) {
  const t = useT();
  const [requested, setRequested] = useState(false);
  // A policy that owns Codex's launch settings also rules out ChatGPT's own runtime.
  const codexLocks = managedInstanceLocks(
    useManagedPolicy(props.environmentId),
    ProviderDriverKind.make("codex"),
  );
  const chatGptDenial = codexLocks?.configKeys.has("setupMode") ? codexLocks.reason : undefined;
  const existingState = getOnboardingProviderState(props.provider);
  const existingReady = props.enabled && existingState === "ready";
  const existingAuthenticated = props.provider?.auth.status === "authenticated";
  const existingChecking = existingState === "checking";
  const existingSummary = getProviderSummary(props.provider, t);
  const content =
    props.mode === "existing" && props.presentation === "onboarding" ? (
      <CodexWelcomeCard
        title={props.displayName || props.provider?.displayName || "Codex"}
        description={
          existingReady ? (
            props.provider?.auth.email?.trim() ? (
              <SignedInAs email={props.provider.auth.email.trim()} className="break-all" />
            ) : (
              t("settings.providers.codexSetup.connectedCli")
            )
          ) : existingChecking ? (
            t("settings.providers.codexSetup.checkingCli")
          ) : props.provider?.installed ? (
            existingSummary.headline
          ) : (
            t("settings.providers.codexSetup.codeWithSubscription")
          )
        }
        control={
          existingReady ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
              <CheckIcon className="size-3.5" />
              {t("settings.providers.codexSetup.ready")}
            </span>
          ) : existingChecking ? (
            <span className="text-xs text-muted-foreground">
              {t("settings.providers.codexSetup.checking")}
            </span>
          ) : existingAuthenticated ? (
            <span className="text-xs text-muted-foreground">{existingSummary.headline}</span>
          ) : (
            <ManagedControl reason={chatGptDenial}>
              <ChatGptConnectionButton
                size="sm"
                disabled={props.readOnly}
                onClick={() => {
                  setRequested(true);
                  props.onModeChange("managed");
                }}
              >
                {t("settings.providers.chatgpt.continue")}
              </ChatGptConnectionButton>
            </ManagedControl>
          )
        }
        secondaryControl={
          !existingAuthenticated && !existingReady && !existingChecking ? (
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={props.existingCliDisabled}
              onClick={() => props.onModeChange("existing")}
            >
              {t("settings.providers.codexSetup.useExistingCli")}
            </Button>
          ) : null
        }
      />
    ) : props.mode === "existing" ? null : !props.provider?.setup?.canAuthenticate ? (
      props.presentation === "onboarding" ? (
        <CodexWelcomeCard
          title={props.displayName || props.provider?.displayName || "Codex"}
          description={<CodexSignInDescription />}
          control={
            <Button size="sm" variant="outline" className="min-w-44" disabled>
              {t("settings.providers.codexSetup.openSignInPage")}
            </Button>
          }
          secondaryControl={
            <Button size="sm" variant="ghost-muted" disabled>
              {t("settings.providers.codexSetup.cancel")}
            </Button>
          }
        />
      ) : (
        <SettingsRow
          title={t("settings.providers.codexSetup.account")}
          description={t("settings.providers.codexSetup.preparingSignIn")}
        />
      )
    ) : (
      <ManagedCodexSetup
        key={`${props.environmentId}:${props.instanceId}`}
        {...props}
        autoStart={requested || props.autoStart === true}
        onAutoStartConsumed={() => {
          setRequested(false);
          props.onAutoStartConsumed?.();
        }}
      />
    );
  return content;
}

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

function ManagedCodexSetup({
  environmentId,
  instanceId,
  provider,
  enabled,
  readOnly,
  onModeChange,
  autoStart,
  onAutoStartConsumed,
  allowExistingCli = true,
  existingCliDisabled,
  presentation,
  displayName,
  onSignInCancelled,
}: CodexSetupSectionProps & {
  readonly autoStart: boolean;
  readonly onAutoStartConsumed: () => void;
  readonly allowExistingCli?: boolean;
}) {
  const t = useT();
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
  const removeAuthMethod = useAtomCommand(serverEnvironment.removeProviderAuthMethod, options);
  const canRemoveAuthMethod = useAtomValue(
    serverEnvironment.removeProviderAuthMethod.permissionAtom(environmentId),
  );
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
          setError(
            failure instanceof Error ? failure.message : t("settings.providers.codexSetup.failed"),
          );
        }
      } else {
        succeeded = true;
        onSuccess?.(result.value);
      }
    } catch {
      setError(t("settings.providers.codexSetup.failed"));
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
        ? (handoffQuery.data.state.message ?? t("settings.providers.codexSetup.signInUnfinished"))
        : t("settings.providers.codexSetup.signInInterrupted"),
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
      setError(t("settings.providers.codexSetup.localSignInFailed"));
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
      ? installation.totalBytes === null
        ? t("settings.providers.codexSetup.downloading", {
            downloaded: (installation.downloadedBytes / 1_000_000).toFixed(1),
          })
        : t("settings.providers.codexSetup.downloadingOf", {
            downloaded: (installation.downloadedBytes / 1_000_000).toFixed(1),
            total: (installation.totalBytes / 1_000_000).toFixed(1),
          })
      : installation?.phase === "extracting"
        ? t("settings.providers.codexSetup.installing")
        : installation?.phase === "verifying"
          ? t("settings.providers.codexSetup.checkingCodex")
          : installed
            ? t(
                installation?.source === "local"
                  ? installation?.installedVersion
                    ? "settings.providers.codexSetup.localVersion"
                    : "settings.providers.codexSetup.local"
                  : installation?.installedVersion
                    ? "settings.providers.codexSetup.managedVersion"
                    : "settings.providers.codexSetup.managed",
                { version: installation?.installedVersion ?? "" },
              )
            : (installation?.message ?? t("settings.providers.codexSetup.managedDefault"));
  const accountDescription = finishingSignIn ? (
    t("settings.providers.codexSetup.finishing")
  ) : installActive ? (
    runtimeDescription
  ) : authActive || auth?.phase === "failed" || auth?.phase === "cancelled" ? (
    auth?.phase === "waiting" && requestedAccountEmail ? (
      t("settings.providers.codexSetup.continueAs", { email: requestedAccountEmail })
    ) : (
      (auth?.message ?? t("settings.providers.codexSetup.finishInBrowser"))
    )
  ) : authenticated ? (
    provider?.auth.email?.trim() ? (
      <SignedInAs email={provider.auth.email.trim()} />
    ) : (
      t("settings.providers.codexSetup.signedInChatGpt")
    )
  ) : (
    (reconnectEmail ?? t("settings.providers.codexSetup.useSubscription"))
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
        ? t("settings.providers.codexSetup.finishing")
        : handoffQuery.data?.phase === "finished"
          ? transferFailed
            ? t("settings.providers.codexSetup.retryConnection")
            : t("settings.providers.codexSetup.finishing")
          : auth?.phase === "waiting"
            ? remoteWeb
              ? t("settings.providers.codexSetup.openChatGptSignIn")
              : t("settings.providers.codexSetup.openSignInPage")
            : presentation === "onboarding"
              ? t("settings.providers.codexSetup.openSignInPage")
              : t("settings.providers.codexSetup.signingIn")}
    </Button>
  );
  const callbackCompletion =
    !handoff && auth?.phase === "waiting" && url ? (
      <div className="flex w-full flex-col gap-3 text-xs leading-relaxed text-muted-foreground">
        <p>{t("settings.providers.codexSetup.callbackHelp")}</p>
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
              aria-label={t("settings.providers.codexSetup.redirectA11y")}
              type="password"
              autoComplete="off"
              placeholder={t("settings.providers.codexSetup.redirectPlaceholder")}
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
            {t("settings.providers.codexSetup.connect")}
          </Button>
        </form>
        {!remoteWeb ? (
          <div>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => void ensureLocalApi().shell.openExternal(url)}
            >
              {t("settings.providers.codexSetup.tryBrowser")}
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
        {handoffUrl ? (
          <details>
            <summary className="cursor-pointer">
              {t("settings.providers.codexSetup.otherWays")}
            </summary>
            <Button className="mt-2" size="sm" variant="outline" render={<a href={handoffUrl} />}>
              {t("settings.providers.codexSetup.useDesktop")}
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
        label={t("settings.providers.codexSetup.trouble")}
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
      disabled={unavailable || busy}
      canRemove={canRemoveAuthMethod}
      error={error}
      onRemove={(methodId) => {
        void run(() => removeAuthMethod({ environmentId, input: { instanceId, methodId } }));
      }}
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

  if (presentation === "onboarding") {
    const setupError =
      logoutWarning ??
      error ??
      (authQuery.error || installQuery.error
        ? t("settings.providers.codexSetup.statusFailed")
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
                <SignedInAs email={provider.auth.email.trim()} className="break-all" />
              ) : (
                t("settings.providers.codexSetup.connectedChatGpt")
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
              t("settings.providers.codexSetup.codeWithSubscription")
            )
          }
          control={
            authenticated && !busy ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
                <CheckIcon className="size-3.5" />
                {t("settings.providers.codexSetup.ready")}
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
                  ? t("settings.providers.codexSetup.settingUp")
                  : hasSavedAccount
                    ? t("settings.providers.codexSetup.reconnect")
                    : t("settings.providers.chatgpt.continue")}
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
                {t("settings.providers.codexSetup.cancel")}
              </Button>
            ) : !authActive && !authenticated && hasSavedAccount ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={unavailable || busy}
                onClick={() => void setup("chatgpt-change-account")}
              >
                {t("settings.providers.chatgpt.reconnect.differentAccount")}
              </Button>
            ) : !authActive && !authenticated && allowExistingCli ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={readOnly || busy || existingCliDisabled}
                onClick={() => onModeChange("existing")}
              >
                {t("settings.providers.codexSetup.useExistingCli")}
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
    <section
      aria-label={t("settings.providers.codexSetup.sectionA11y")}
      className="divide-y divide-border/50"
    >
      {accountPicker}
      <SettingsRow
        title={t("settings.providers.codexSetup.account")}
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
                    {t("settings.providers.codexSetup.cancel")}
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
                {t("settings.providers.codexSetup.cancel")}
              </Button>
            ) : authenticated ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={unavailable || busy}
                  onClick={() => setAccountPickerOpen(true)}
                >
                  {t("settings.providers.codexSetup.changeAccount")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={unavailable || busy}
                  onClick={() => void run(() => logoutAuth(target))}
                >
                  {t("settings.providers.codexSetup.disconnect")}
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
                    ? t("settings.providers.codexSetup.settingUp")
                    : hasSavedAccount
                      ? t("settings.providers.codexSetup.reconnect")
                      : t("settings.providers.chatgpt.continue")}
                </ChatGptConnectionButton>
                {hasSavedAccount ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={unavailable || busy}
                    onClick={() => void setup("chatgpt-change-account")}
                  >
                    {t("settings.providers.chatgpt.reconnect.differentAccount")}
                  </Button>
                ) : null}
                {allowExistingCli ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={readOnly || busy}
                    onClick={() => onModeChange("existing")}
                  >
                    {t("settings.providers.codexSetup.useExistingCli")}
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
              : t("settings.providers.codexSetup.codexStatusFailed"))}
        </p>
      ) : null}
    </section>
  );
}

export function CodexManagedRuntimeFields({
  environmentId,
  instanceId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
}) {
  const t = useT();
  const installation = useEnvironmentQuery(
    serverEnvironment.providerInstallState({
      environmentId,
      input: { instanceId },
    }),
  );
  const executablePath = installation.data?.executablePath ?? "";
  return (
    <>
      <SettingsRow
        title={t("settings.providers.codexSetup.binaryPath")}
        description={t("settings.providers.codexSetup.binarySelected")}
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label={t("settings.providers.codexSetup.binaryA11y")}
              value={executablePath}
              title={executablePath}
              placeholder={
                installation.error
                  ? t("settings.providers.codexSetup.pathUnreadable")
                  : t("settings.providers.codexSetup.notInstalled")
              }
              disabled
            />
          </div>
        }
      />
      <SettingsRow
        title={t("settings.providers.codexSetup.homeTitle")}
        description={t("settings.providers.codexSetup.homeDescription")}
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label={t("settings.providers.codexSetup.homeA11y")}
              value={provider?.runtimePaths?.homePath ?? ""}
              title={provider?.runtimePaths?.homePath}
              placeholder={t("settings.providers.codexSetup.unavailable")}
              disabled
            />
          </div>
        }
      />
      <SettingsRow
        title={t("settings.providers.codexSetup.shadowPath")}
        description={
          provider?.runtimePaths?.shadowHomePath
            ? t("settings.providers.codexSetup.shadowShared")
            : t("settings.providers.codexSetup.shadowDirect")
        }
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label={t("settings.providers.codexSetup.shadowA11y")}
              value={provider?.runtimePaths?.shadowHomePath ?? ""}
              title={provider?.runtimePaths?.shadowHomePath ?? undefined}
              placeholder={
                provider?.runtimePaths
                  ? t("settings.providers.codexSetup.notUsed")
                  : t("settings.providers.codexSetup.unavailable")
              }
              disabled
            />
          </div>
        }
      />
    </>
  );
}

function SignedInAs({ email, className }: { readonly email: string; readonly className?: string }) {
  const t = useT();
  const [before, after] = t("settings.providers.codexSetup.signedInAs", { email: "\u0000" }).split(
    "\u0000",
  );
  return (
    <>
      {before}
      <RedactedSensitiveText
        value={email}
        ariaLabel={t("settings.providers.auth.toggleEmail")}
        revealTooltip={t("settings.providers.auth.revealEmail")}
        hideTooltip={t("settings.providers.auth.hideEmail")}
        {...(className ? { className } : {})}
      />
      {after}
    </>
  );
}

function CodexSignInDescription({
  label,
  expanded = false,
  controls,
  onToggle,
}: {
  readonly label?: string;
  readonly expanded?: boolean;
  readonly controls?: string;
  readonly onToggle?: () => void;
}) {
  const t = useT();
  const text = label ?? t("settings.providers.codexSetup.completeInBrowser");
  if (!onToggle) return <div className="leading-relaxed">{text}</div>;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-sm text-left leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      aria-label={t("settings.providers.codexSetup.trouble")}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      {text}
      <ChevronRightIcon aria-hidden className={`size-3 shrink-0 ${expanded ? "rotate-90" : ""}`} />
    </button>
  );
}

function CodexWelcomeCard({
  title,
  description,
  control,
  secondaryControl,
  children,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly control?: ReactNode;
  readonly secondaryControl?: ReactNode;
  readonly children?: ReactNode;
}) {
  const footer = Children.toArray(children);
  return (
    <div className="rounded-lg border border-border bg-background px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <OpenAI className="size-5 shrink-0 fill-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</div>
        </div>
        {control || secondaryControl ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 has-[button]:w-full has-[button]:flex-col-reverse has-[button]:items-end sm:has-[button]:w-auto sm:has-[button]:flex-row sm:has-[button]:items-center">
            {secondaryControl}
            {control}
          </div>
        ) : null}
      </div>
      {footer.length > 0 ? (
        <div className="ml-8 mt-2 flex flex-wrap items-center gap-2">{footer}</div>
      ) : null}
    </div>
  );
}
