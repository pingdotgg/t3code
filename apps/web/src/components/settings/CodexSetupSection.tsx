import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
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
import { T, useGT, useMessages } from "gt-react";

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
  const gt = useGT();
  const m = useMessages();
  const [requested, setRequested] = useState(false);
  // A policy that owns Codex's launch settings also rules out ChatGPT's own runtime.
  const codexLocks = managedInstanceLocks(
    useManagedPolicy(props.environmentId),
    ProviderDriverKind.make("codex"),
    m,
  );
  const chatGptDenial = codexLocks?.configKeys.has("setupMode") ? codexLocks.reason : undefined;
  const existingState = getOnboardingProviderState(props.provider);
  const existingReady = props.enabled && existingState === "ready";
  const existingAuthenticated = props.provider?.auth.status === "authenticated";
  const existingChecking = existingState === "checking";
  const existingSummary = getProviderSummary(props.provider, m);
  const content =
    props.mode === "existing" && props.presentation === "onboarding" ? (
      <CodexWelcomeCard
        title={props.displayName || props.provider?.displayName || "Codex"}
        description={
          existingReady ? (
            props.provider?.auth.email?.trim() ? (
              <>
                <T>
                  Signed in as{" "}
                  <RedactedSensitiveText
                    value={props.provider.auth.email.trim()}
                    ariaLabel={gt("Toggle account email visibility")}
                    revealTooltip={gt("Click to reveal email")}
                    hideTooltip={gt("Click to hide email")}
                    className="break-all"
                  />
                  .
                </T>
              </>
            ) : (
              gt("Connected with your Codex CLI.")
            )
          ) : existingChecking ? (
            gt("Checking your Codex CLI...")
          ) : props.provider?.installed ? (
            existingSummary.headline
          ) : (
            gt("Code with your ChatGPT subscription.")
          )
        }
        control={
          existingReady ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
              <CheckIcon className="size-3.5" />
              <T>Ready</T>
            </span>
          ) : existingChecking ? (
            <span className="text-xs text-muted-foreground">
              <T>Checking...</T>
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
                <T>Continue with ChatGPT</T>
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
              <T>Use existing CLI</T>
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
              <T>Open sign-in page</T>
            </Button>
          }
          secondaryControl={
            <Button size="sm" variant="ghost-muted" disabled>
              <T>Cancel</T>
            </Button>
          }
        />
      ) : (
        <SettingsRow title={gt("ChatGPT account")} description={gt("Preparing sign-in.")} />
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
  const gt = useGT();
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target), useMessages());
  const installQuery = useEnvironmentQuery(
    serverEnvironment.providerInstallState(target),
    useMessages(),
  );
  const [handoff, setHandoff] = useState<{
    environmentId: EnvironmentId;
    input: ChatGptHandoffInput;
  } | null>(null);
  const handoffQuery = useEnvironmentQuery(
    handoff ? serverEnvironment.chatGptHandoffState(handoff) : null,
    useMessages(),
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
            failure instanceof Error
              ? (thrownErrorMessage(failure, resolveMessage) ?? failure.message)
              : gt("Codex setup failed. Try again."),
          );
        }
      } else {
        succeeded = true;
        onSuccess?.(result.value);
      }
    } catch {
      setError(gt("Codex setup failed. Try again."));
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
        ? (handoffQuery.data.state.message ?? gt("ChatGPT sign-in could not finish. Try again."))
        : gt("ChatGPT sign-in on the primary environment was interrupted. Try again."),
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
      setError(gt("Could not finish sign-in on this computer. Try again."));
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
        ? gt("Downloading {downloaded} MB.", {
            downloaded: (installation.downloadedBytes / 1_000_000).toFixed(1),
          })
        : gt("Downloading {downloaded} of {total} MB.", {
            downloaded: (installation.downloadedBytes / 1_000_000).toFixed(1),
            total: (installation.totalBytes / 1_000_000).toFixed(1),
          })
      : installation?.phase === "extracting"
        ? gt("Installing Codex.")
        : installation?.phase === "verifying"
          ? gt("Checking Codex.")
          : installed
            ? installation?.installedVersion
              ? installation?.source === "local"
                ? gt("Using your installed Codex · v{version}.", {
                    version: installation.installedVersion,
                  })
                : gt("Managed by T3 Code · v{version}.", { version: installation.installedVersion })
              : installation?.source === "local"
                ? gt("Using your installed Codex.")
                : gt("Managed by T3 Code.")
            : (installation?.message ?? gt("T3 Code downloads and manages Codex for you."));
  const accountDescription = finishingSignIn ? (
    gt("Finishing sign-in...")
  ) : installActive ? (
    runtimeDescription
  ) : authActive || auth?.phase === "failed" || auth?.phase === "cancelled" ? (
    auth?.phase === "waiting" && requestedAccountEmail ? (
      gt("Continue as {email} on OpenAI.", { email: requestedAccountEmail })
    ) : (
      (auth?.message ?? gt("Finish signing in in your browser."))
    )
  ) : authenticated ? (
    provider?.auth.email?.trim() ? (
      <>
        <T>
          Signed in as{" "}
          <RedactedSensitiveText
            value={provider.auth.email.trim()}
            ariaLabel={gt("Toggle account email visibility")}
            revealTooltip={gt("Click to reveal email")}
            hideTooltip={gt("Click to hide email")}
          />
          .
        </T>
      </>
    ) : (
      gt("Signed in with ChatGPT.")
    )
  ) : (
    (reconnectEmail ?? gt("Use your ChatGPT subscription."))
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
        ? gt("Finishing sign-in...")
        : handoffQuery.data?.phase === "finished"
          ? transferFailed
            ? gt("Retry connection")
            : gt("Finishing sign-in...")
          : auth?.phase === "waiting"
            ? remoteWeb
              ? gt("Open ChatGPT sign-in")
              : gt("Open sign-in page")
            : presentation === "onboarding"
              ? gt("Open sign-in page")
              : gt("Signing in...")}
    </Button>
  );
  const callbackCompletion =
    !handoff && auth?.phase === "waiting" && url ? (
      <div className="flex w-full flex-col gap-3 text-xs leading-relaxed text-muted-foreground">
        <p>
          <T>If sign-in doesn't return to T3 Code, paste the URL from the final localhost page.</T>
        </p>
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
              aria-label={gt("ChatGPT sign-in redirect URL")}
              type="password"
              autoComplete="off"
              placeholder={gt("Paste the URL from the sign-in tab")}
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
            <T>Connect</T>
          </Button>
        </form>
        {!remoteWeb ? (
          <div>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => void ensureLocalApi().shell.openExternal(url)}
            >
              <T>Try sign-in in your browser</T>
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
        {handoffUrl ? (
          <details>
            <summary className="cursor-pointer">
              <T>Other ways to connect</T>
            </summary>
            <Button className="mt-2" size="sm" variant="outline" render={<a href={handoffUrl} />}>
              <T>Use T3 desktop for automatic return</T>
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
        label={gt("Having trouble signing in?")}
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
        ? gt("Could not read setup status. Reconnect and try again.")
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
                  <T>
                    Signed in as{" "}
                    <RedactedSensitiveText
                      value={provider.auth.email.trim()}
                      ariaLabel={gt("Toggle account email visibility")}
                      revealTooltip={gt("Click to reveal email")}
                      hideTooltip={gt("Click to hide email")}
                      className="break-all"
                    />
                    .
                  </T>
                </>
              ) : (
                gt("Connected to ChatGPT.")
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
              gt("Code with your ChatGPT subscription.")
            )
          }
          control={
            authenticated && !busy ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
                <CheckIcon className="size-3.5" />
                <T>Ready</T>
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
                  ? gt("Setting up...")
                  : hasSavedAccount
                    ? gt("Reconnect account")
                    : gt("Continue with ChatGPT")}
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
                <T>Cancel</T>
              </Button>
            ) : !authActive && !authenticated && hasSavedAccount ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={unavailable || busy}
                onClick={() => void setup("chatgpt-change-account")}
              >
                <T>Use a different account</T>
              </Button>
            ) : !authActive && !authenticated && allowExistingCli ? (
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={readOnly || busy || existingCliDisabled}
                onClick={() => onModeChange("existing")}
              >
                <T>Use existing CLI</T>
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
    <section aria-label={gt("Codex setup")} className="divide-y divide-border/50">
      {accountPicker}
      <SettingsRow
        title={gt("ChatGPT account")}
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
                    <T>Cancel</T>
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
                <T>Cancel</T>
              </Button>
            ) : authenticated ? (
              <>
                {updateAvailable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={unavailable || busy}
                    onClick={() =>
                      void run(() => startInstall({ environmentId, input: { instanceId } }))
                    }
                  >
                    <T>Update Codex</T>
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={unavailable || busy}
                  onClick={() => setAccountPickerOpen(true)}
                >
                  <T>Change account</T>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={unavailable || busy}
                  onClick={() => void run(() => logoutAuth(target))}
                >
                  <T>Disconnect</T>
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
                    ? gt("Setting up...")
                    : hasSavedAccount
                      ? gt("Reconnect account")
                      : gt("Continue with ChatGPT")}
                </ChatGptConnectionButton>
                {hasSavedAccount ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={unavailable || busy}
                    onClick={() => void setup("chatgpt-change-account")}
                  >
                    <T>Use a different account</T>
                  </Button>
                ) : null}
                {allowExistingCli ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={readOnly || busy}
                    onClick={() => onModeChange("existing")}
                  >
                    <T>Use existing CLI</T>
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
              : gt("Could not read Codex setup status. Reconnect and try again."))}
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
  const gt = useGT();
  const installation = useEnvironmentQuery(
    serverEnvironment.providerInstallState({
      environmentId,
      input: { instanceId },
    }),
    useMessages(),
  );
  const executablePath = installation.data?.executablePath ?? "";
  return (
    <>
      <SettingsRow
        title={gt("Binary path")}
        description={gt("Selected by T3 Code.")}
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label={gt("Codex binary path")}
              value={executablePath}
              title={executablePath}
              placeholder={
                installation.error ? gt("Could not read runtime path") : gt("Not installed")
              }
              disabled
            />
          </div>
        }
      />
      <SettingsRow
        title={gt("CODEX_HOME path")}
        description={gt("Shared Codex config, sessions, and state.")}
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label={gt("Codex home path")}
              value={provider?.runtimePaths?.homePath ?? ""}
              title={provider?.runtimePaths?.homePath}
              placeholder={gt("Unavailable", { $context: "path cannot be read" })}
              disabled
            />
          </div>
        }
      />
      <SettingsRow
        title={gt("Shadow home path")}
        description={
          provider?.runtimePaths?.shadowHomePath
            ? gt("Account-specific home sharing the Codex state above.")
            : gt("This instance uses the shared Codex home directly.")
        }
        control={
          <div className="w-full sm:w-80">
            <Input
              aria-label={gt("Codex shadow home path")}
              value={provider?.runtimePaths?.shadowHomePath ?? ""}
              title={provider?.runtimePaths?.shadowHomePath ?? undefined}
              placeholder={
                provider?.runtimePaths
                  ? gt("Not used")
                  : gt("Unavailable", { $context: "path cannot be read" })
              }
              disabled
            />
          </div>
        }
      />
    </>
  );
}

function CodexSignInDescription({
  label: labelOverride,
  expanded = false,
  controls,
  onToggle,
}: {
  readonly label?: string;
  readonly expanded?: boolean;
  readonly controls?: string;
  readonly onToggle?: () => void;
}) {
  const gt = useGT();
  const label = labelOverride ?? gt("Complete sign-in in your browser.");
  if (!onToggle) return <div className="leading-relaxed">{label}</div>;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-sm text-left leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      aria-label={gt("Having trouble signing in?")}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
    >
      {label}
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
