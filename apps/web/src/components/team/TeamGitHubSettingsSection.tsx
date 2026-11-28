import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canManageTeamAutomationGitHub,
  canManageTeamGitHubAppConfig,
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_OAUTH_SCOPES,
  DEFAULT_GITHUB_WEB_BASE_URL,
  type EnvironmentId,
  type TeamAutomationGitHubIdentity,
  type TeamGitHubAppConfig,
  type TeamGitHubAuthMethod,
  type TeamGitHubIdentity,
  type TeamGitHubOAuthMode,
  type TeamMember,
  type TeamMemberId,
  type TeamStartGitHubDeviceFlowResult,
} from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { m } from "~/i18n/messages";
import { ensureLocalApi } from "~/localApi";
import { teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { confirmTeamDestructiveAction } from "./confirmTeamDestructiveAction";

const GITHUB_OAUTH_CALLBACK_PATH = "/api/team/github/oauth/callback";

function formatAuthMethodBadge(method: TeamGitHubAuthMethod, gt: ReturnType<typeof useGT>): string {
  switch (method) {
    case "pat":
      return gt("PAT");
    case "oauth":
      return gt("OAuth");
    case "github_app":
      return gt("GitHub App");
  }
}

function formatOAuthModeLabel(mode: TeamGitHubOAuthMode, gt: ReturnType<typeof useGT>): string {
  return mode === "github_app" ? gt("GitHub App (auto-refreshing tokens)") : gt("GitHub OAuth App");
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function TeamGitHubSettingsSection({
  environmentId,
  serverBaseUrl,
  currentMember,
  memberById,
  myGitHubIdentity,
  automationGitHubIdentity,
  githubAppConfig,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverBaseUrl: string;
  readonly currentMember: TeamMember | null;
  readonly memberById: ReadonlyMap<TeamMemberId, TeamMember>;
  readonly myGitHubIdentity: TeamGitHubIdentity | null;
  readonly automationGitHubIdentity: TeamAutomationGitHubIdentity | null;
  readonly githubAppConfig: TeamGitHubAppConfig | null;
}) {
  const gt = useGT();
  const canConnectMineScope = useAtomValue(
    teamEnvironment.connectMyGitHub.permissionAtom(environmentId),
  );
  const canDisconnectMineScope = useAtomValue(
    teamEnvironment.disconnectMyGitHub.permissionAtom(environmentId),
  );
  const canManageAutomationScope = useAtomValue(
    teamEnvironment.setAutomationGitHub.permissionAtom(environmentId),
  );
  const canClearAutomationScope = useAtomValue(
    teamEnvironment.clearAutomationGitHub.permissionAtom(environmentId),
  );
  const canSetAppConfigScope = useAtomValue(
    teamEnvironment.setGitHubAppConfig.permissionAtom(environmentId),
  );
  const canClearAppConfigScope = useAtomValue(
    teamEnvironment.clearGitHubAppConfig.permissionAtom(environmentId),
  );
  const canStartOAuthScope = useAtomValue(
    teamEnvironment.startGitHubOAuth.permissionAtom(environmentId),
  );
  const canStartDeviceFlowScope = useAtomValue(
    teamEnvironment.startGitHubDeviceFlow.permissionAtom(environmentId),
  );

  const isActiveMember = currentMember !== null && currentMember.status === "active";
  const canConnectMine = canConnectMineScope && isActiveMember;
  const canDisconnectMine = canDisconnectMineScope && isActiveMember;
  const canStartOAuth = canStartOAuthScope && isActiveMember;
  const canStartDeviceFlow = canStartDeviceFlowScope && isActiveMember;
  const canManageAutomation =
    canManageAutomationScope && isActiveMember && canManageTeamAutomationGitHub(currentMember.role);
  const canClearAutomation =
    canClearAutomationScope && isActiveMember && canManageTeamAutomationGitHub(currentMember.role);
  const canManageAppConfig =
    canSetAppConfigScope && isActiveMember && canManageTeamGitHubAppConfig(currentMember.role);
  const canClearAppConfig =
    canClearAppConfigScope && isActiveMember && canManageTeamGitHubAppConfig(currentMember.role);

  const runConnectMyGitHub = useAtomCommand(teamEnvironment.connectMyGitHub, {
    reportFailure: false,
  });
  const runDisconnectMyGitHub = useAtomCommand(teamEnvironment.disconnectMyGitHub, {
    reportFailure: false,
  });
  const runSetAutomationGitHub = useAtomCommand(teamEnvironment.setAutomationGitHub, {
    reportFailure: false,
  });
  const runClearAutomationGitHub = useAtomCommand(teamEnvironment.clearAutomationGitHub, {
    reportFailure: false,
  });
  const runSetGitHubAppConfig = useAtomCommand(teamEnvironment.setGitHubAppConfig, {
    reportFailure: false,
  });
  const runClearGitHubAppConfig = useAtomCommand(teamEnvironment.clearGitHubAppConfig, {
    reportFailure: false,
  });
  const runStartGitHubOAuth = useAtomCommand(teamEnvironment.startGitHubOAuth, {
    reportFailure: false,
  });
  const runCompleteGitHubOAuth = useAtomCommand(teamEnvironment.completeGitHubOAuth, {
    reportFailure: false,
  });
  const runStartGitHubDeviceFlow = useAtomCommand(teamEnvironment.startGitHubDeviceFlow, {
    reportFailure: false,
  });
  const runPollGitHubDeviceFlow = useAtomCommand(teamEnvironment.pollGitHubDeviceFlow, {
    reportFailure: false,
  });
  const runCancelGitHubDeviceFlow = useAtomCommand(teamEnvironment.cancelGitHubDeviceFlow, {
    reportFailure: false,
  });

  // Member PAT & author overrides state
  const [myTokenInput, setMyTokenInput] = useState("");
  const [myApiBaseUrlInput, setMyApiBaseUrlInput] = useState("");
  const [myGitNameInput, setMyGitNameInput] = useState("");
  const [myGitEmailInput, setMyGitEmailInput] = useState("");
  const [showMyAuthorOverrides, setShowMyAuthorOverrides] = useState(false);
  const [showMyPatSection, setShowMyPatSection] = useState(false);
  const [showMyEnterpriseApi, setShowMyEnterpriseApi] = useState(false);
  const [savingMine, setSavingMine] = useState(false);
  const [disconnectingMine, setDisconnectingMine] = useState(false);

  // Member OAuth & Device flow state
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [completingOAuth, setCompletingOAuth] = useState(false);
  const [oauthConfirmationCode, setOAuthConfirmationCode] = useState("");
  const [pendingOAuth, setPendingOAuth] = useState<{
    readonly authorizeUrl: string;
    readonly state: string;
    readonly connectedUpdatedAtBefore: string | null;
  } | null>(null);
  const [startingDeviceFlow, setStartingDeviceFlow] = useState(false);
  const [activeDeviceFlow, setActiveDeviceFlow] = useState<TeamStartGitHubDeviceFlowResult | null>(
    null,
  );
  const devicePollAbortRef = useRef<AbortController | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Aborts any active RFC 8628 device-flow poll timer when the settings section unmounts.
  useEffect(
    () => () => {
      devicePollAbortRef.current?.abort();
    },
    [],
  );

  // Admin GitHub OAuth / GitHub App configuration state (drafts fall back to server config)
  const [appModeDraft, setAppModeDraft] = useState<TeamGitHubOAuthMode | null>(null);
  const [appClientIdDraft, setAppClientIdDraft] = useState<string | null>(null);
  const [appClientSecretInput, setAppClientSecretInput] = useState("");
  const [appClearClientSecret, setAppClearClientSecret] = useState(false);
  const [appWebBaseUrlDraft, setAppWebBaseUrlDraft] = useState<string | null>(null);
  const [appApiBaseUrlDraft, setAppApiBaseUrlDraft] = useState<string | null>(null);
  const [appScopesDraft, setAppScopesDraft] = useState<string | null>(null);
  const [appEnabledDraft, setAppEnabledDraft] = useState<boolean | null>(null);
  const [showAppAdvanced, setShowAppAdvanced] = useState(false);
  const [savingAppConfig, setSavingAppConfig] = useState(false);
  const [clearingAppConfig, setClearingAppConfig] = useState(false);

  // Admin Automation PAT state
  const [autoTokenInput, setAutoTokenInput] = useState("");
  const [autoApiBaseUrlInput, setAutoApiBaseUrlInput] = useState("");
  const [autoGitNameInput, setAutoGitNameInput] = useState("");
  const [autoGitEmailInput, setAutoGitEmailInput] = useState("");
  const [showAutoAdvanced, setShowAutoAdvanced] = useState(false);
  const [savingAuto, setSavingAuto] = useState(false);
  const [clearingAuto, setClearingAuto] = useState(false);

  const { copyToClipboard: copyCallbackUrl, isCopied: callbackUrlCopied } = useCopyToClipboard({
    target: {
      target: "GitHub OAuth callback URL",
      unavailableMessage: msg("Clipboard API is unavailable while copying the callback URL."),
      failureMessage: msg("Failed to copy the GitHub OAuth callback URL."),
    },
  });
  const { copyToClipboard: copyDeviceCode, isCopied: deviceCodeCopied } = useCopyToClipboard({
    target: {
      target: "GitHub device code",
      unavailableMessage: msg("Clipboard API is unavailable while copying the device code."),
      failureMessage: msg("Failed to copy the GitHub device code."),
    },
  });
  const { copyToClipboard: copyOAuthUrl, isCopied: oauthUrlCopied } = useCopyToClipboard({
    target: {
      target: "GitHub sign-in link",
      unavailableMessage: msg("Clipboard API is unavailable while copying the sign-in link."),
      failureMessage: msg("Failed to copy the GitHub sign-in link."),
    },
  });

  const effectiveAppMode: TeamGitHubOAuthMode =
    appModeDraft ?? githubAppConfig?.mode ?? "github_app";
  const effectiveAppClientId = appClientIdDraft ?? githubAppConfig?.clientId ?? "";
  const effectiveAppWebBaseUrl =
    appWebBaseUrlDraft ??
    (githubAppConfig && githubAppConfig.webBaseUrl !== DEFAULT_GITHUB_WEB_BASE_URL
      ? githubAppConfig.webBaseUrl
      : "");
  const effectiveAppApiBaseUrl =
    appApiBaseUrlDraft ??
    (githubAppConfig && githubAppConfig.apiBaseUrl !== DEFAULT_GITHUB_API_BASE_URL
      ? githubAppConfig.apiBaseUrl
      : "");
  const effectiveAppScopes = appScopesDraft ?? githubAppConfig?.scopes ?? "";
  const effectiveAppEnabled = appEnabledDraft ?? githubAppConfig?.enabled ?? true;

  const callbackUrl =
    serverBaseUrl.trim().length > 0
      ? `${serverBaseUrl.trim().replace(/\/+$/, "")}${GITHUB_OAUTH_CALLBACK_PATH}`
      : "";

  // Auto-hide the waiting OAuth banner as soon as the live identity stream delivers the new connection.
  const showPendingOAuth =
    pendingOAuth !== null &&
    (myGitHubIdentity === null ||
      myGitHubIdentity.needsReconnect === true ||
      myGitHubIdentity.updatedAt === pendingOAuth.connectedUpdatedAtBefore);

  const reportError = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? title,
    });
  };

  const resetAppConfigDrafts = () => {
    setAppModeDraft(null);
    setAppClientIdDraft(null);
    setAppClientSecretInput("");
    setAppClearClientSecret(false);
    setAppWebBaseUrlDraft(null);
    setAppApiBaseUrlDraft(null);
    setAppScopesDraft(null);
    setAppEnabledDraft(null);
  };

  const handleSaveAppConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clientId = effectiveAppClientId.trim();
    if (clientId.length === 0) {
      reportError(
        gt("Could not save GitHub OAuth configuration"),
        new Error(gt("Enter the GitHub App or OAuth App Client ID.")),
      );
      return;
    }
    setSavingAppConfig(true);
    const result = await runSetGitHubAppConfig({
      environmentId,
      input: {
        mode: effectiveAppMode,
        clientId,
        enabled: effectiveAppEnabled,
        ...(appClearClientSecret
          ? { clearClientSecret: true }
          : appClientSecretInput.trim().length > 0
            ? { clientSecret: appClientSecretInput.trim() }
            : {}),
        ...(effectiveAppWebBaseUrl.trim().length > 0
          ? { webBaseUrl: effectiveAppWebBaseUrl.trim() }
          : { webBaseUrl: null }),
        ...(effectiveAppApiBaseUrl.trim().length > 0
          ? { apiBaseUrl: effectiveAppApiBaseUrl.trim() }
          : { apiBaseUrl: null }),
        ...(effectiveAppMode === "github_app"
          ? {}
          : appScopesDraft !== null
            ? { scopes: appScopesDraft.trim() }
            : githubAppConfig !== null && githubAppConfig.mode === "oauth"
              ? { scopes: githubAppConfig.scopes }
              : {}),
      },
    });
    setSavingAppConfig(false);
    if (result._tag === "Success") {
      resetAppConfigDrafts();
      toastManager.add({
        type: "success",
        title: gt("GitHub OAuth configuration saved"),
        description: result.value.enabled
          ? gt("Team members can now sign in with GitHub in one click.")
          : gt("GitHub OAuth sign-in is saved but currently disabled."),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(
        gt("Could not save GitHub OAuth configuration"),
        squashAtomCommandFailure(result),
      );
    }
  };

  const handleClearAppConfig = async () => {
    const confirmed = await confirmTeamDestructiveAction(
      [
        gt("Remove GitHub OAuth / GitHub App configuration?"),
        gt(
          "One-click GitHub sign-in will be disabled for this team. Members can still connect using personal access tokens.",
        ),
      ].join("\n"),
    );
    if (!confirmed) return;

    setClearingAppConfig(true);
    const result = await runClearGitHubAppConfig({
      environmentId,
      input: {},
    });
    setClearingAppConfig(false);
    if (result._tag === "Success") {
      resetAppConfigDrafts();
      toastManager.add({
        type: "success",
        title: gt("GitHub OAuth configuration removed"),
        description: gt("Members can still connect using fine-grained personal access tokens."),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(
        gt("Could not remove GitHub OAuth configuration"),
        squashAtomCommandFailure(result),
      );
    }
  };

  const handleStartBrowserOAuth = async () => {
    setStartingOAuth(true);
    // Reserve a browser tab synchronously before awaiting the RPC so browsers do not block the popup.
    const pendingWindow =
      typeof window !== "undefined" && !window.desktopBridge ? window.open("", "_blank") : null;
    if (pendingWindow) {
      pendingWindow.opener = null;
    }
    const result = await runStartGitHubOAuth({
      environmentId,
      input: {
        ...(serverBaseUrl.trim().length > 0 ? { redirectBaseUrl: serverBaseUrl.trim() } : {}),
        ...(myGitNameInput.trim().length > 0 ? { githubName: myGitNameInput.trim() } : {}),
        ...(myGitEmailInput.trim().length > 0 ? { githubEmail: myGitEmailInput.trim() } : {}),
      },
    });
    setStartingOAuth(false);
    if (result._tag === "Success") {
      const authorizeUrl = result.value.authorizeUrl;
      setOAuthConfirmationCode("");
      setPendingOAuth({
        authorizeUrl,
        state: result.value.state,
        connectedUpdatedAtBefore: myGitHubIdentity?.updatedAt ?? null,
      });
      try {
        if (pendingWindow) {
          pendingWindow.location.href = authorizeUrl;
        } else {
          await ensureLocalApi().shell.openExternal(authorizeUrl);
        }
      } catch {
        pendingWindow?.close();
        toastManager.add({
          type: "info",
          title: gt("Open GitHub to finish sign-in"),
          description: gt("Use the sign-in link below to authorize in your browser."),
        });
      }
      return;
    }
    pendingWindow?.close();
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not start GitHub sign-in"), squashAtomCommandFailure(result));
    }
  };

  const handleCompleteBrowserOAuth = async (event: FormEvent) => {
    event.preventDefault();
    if (!pendingOAuth) return;
    const confirmationCode = oauthConfirmationCode.trim();
    if (confirmationCode.length === 0) return;
    setCompletingOAuth(true);
    const result = await runCompleteGitHubOAuth({
      environmentId,
      input: {
        state: pendingOAuth.state,
        confirmationCode,
      },
    });
    setCompletingOAuth(false);
    if (result._tag === "Success") {
      setPendingOAuth(null);
      setOAuthConfirmationCode("");
      toastManager.add({
        type: "success",
        title: gt("GitHub identity connected"),
        description: gt("Turns you start will authenticate and commit as @{login}.", {
          login: result.value.githubLogin,
        }),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      if (
        typeof failure === "object" &&
        failure !== null &&
        "code" in failure &&
        failure.code === "github_oauth_state_invalid"
      ) {
        setPendingOAuth(null);
        setOAuthConfirmationCode("");
      }
      reportError(gt("Could not finish GitHub sign-in"), failure);
    }
  };

  const stopDevicePolling = () => {
    devicePollAbortRef.current?.abort();
    devicePollAbortRef.current = null;
  };

  const handleStartDeviceFlow = async () => {
    stopDevicePolling();
    setStartingDeviceFlow(true);
    const result = await runStartGitHubDeviceFlow({
      environmentId,
      input: {
        ...(myGitNameInput.trim().length > 0 ? { githubName: myGitNameInput.trim() } : {}),
        ...(myGitEmailInput.trim().length > 0 ? { githubEmail: myGitEmailInput.trim() } : {}),
      },
    });
    setStartingDeviceFlow(false);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        reportError(gt("Could not start GitHub device sign-in"), squashAtomCommandFailure(result));
      }
      return;
    }
    const flow = result.value;
    setActiveDeviceFlow(flow);
    const abortController = new AbortController();
    devicePollAbortRef.current = abortController;

    void (async () => {
      let intervalSeconds = Math.max(1, flow.intervalSeconds);
      let consecutiveTransportFailures = 0;
      while (!abortController.signal.aborted) {
        const shouldContinue = await waitAbortable(intervalSeconds * 1_000, abortController.signal);
        if (!shouldContinue || abortController.signal.aborted) return;

        const pollResult = await runPollGitHubDeviceFlow({
          environmentId,
          input: { deviceFlowId: flow.deviceFlowId },
        });
        if (abortController.signal.aborted) return;
        if (pollResult._tag !== "Success") {
          const failure = squashAtomCommandFailure(pollResult);
          const isDomainError =
            typeof failure === "object" &&
            failure !== null &&
            "_tag" in failure &&
            (failure._tag === "TeamOperationError" ||
              failure._tag === "EnvironmentAuthorizationError");
          if (!isDomainError && !isAtomCommandInterrupted(pollResult)) {
            consecutiveTransportFailures += 1;
            if (consecutiveTransportFailures < 3) {
              continue;
            }
          }
          setActiveDeviceFlow(null);
          if (!isAtomCommandInterrupted(pollResult)) {
            reportError(gt("GitHub device sign-in failed"), failure);
          }
          return;
        }
        consecutiveTransportFailures = 0;
        const outcome = pollResult.value;
        intervalSeconds = Math.max(1, outcome.intervalSeconds);
        if (outcome.status === "pending") {
          continue;
        }
        setActiveDeviceFlow(null);
        if (outcome.status === "completed") {
          toastManager.add({
            type: "success",
            title: gt("GitHub identity connected"),
            description: outcome.identity
              ? gt("Turns you start will authenticate and commit as @{login}.", {
                  login: outcome.identity.githubLogin,
                })
              : gt("Your GitHub account is connected."),
          });
        } else {
          toastManager.add({
            type: "error",
            title: gt("GitHub device sign-in did not complete"),
            description:
              outcome.errorMessage ??
              (outcome.status === "expired"
                ? gt("The device code expired. Please try again.")
                : gt("GitHub authorization was cancelled or denied.")),
          });
        }
        return;
      }
    })();
  };

  const handleCancelDeviceFlow = async () => {
    const flow = activeDeviceFlow;
    stopDevicePolling();
    setActiveDeviceFlow(null);
    if (flow) {
      await runCancelGitHubDeviceFlow({
        environmentId,
        input: { deviceFlowId: flow.deviceFlowId },
      });
    }
  };

  const handleConnectMyGitHub = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = myTokenInput.trim();
    if (token.length === 0) {
      reportError(
        gt("Could not connect GitHub"),
        new Error(gt("Enter a GitHub personal access token.")),
      );
      return;
    }
    setSavingMine(true);
    const result = await runConnectMyGitHub({
      environmentId,
      input: {
        authMethod: "pat",
        token,
        ...(myApiBaseUrlInput.trim().length > 0 ? { apiBaseUrl: myApiBaseUrlInput.trim() } : {}),
        ...(myGitNameInput.trim().length > 0 ? { githubName: myGitNameInput.trim() } : {}),
        ...(myGitEmailInput.trim().length > 0 ? { githubEmail: myGitEmailInput.trim() } : {}),
      },
    });
    setSavingMine(false);
    if (result._tag === "Success") {
      setMyTokenInput("");
      setPendingOAuth(null);
      stopDevicePolling();
      setActiveDeviceFlow(null);
      toastManager.add({
        type: "success",
        title: gt("GitHub identity connected"),
        description: gt("Turns you start will authenticate and commit as @{login}.", {
          login: result.value.githubLogin,
        }),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not connect GitHub"), squashAtomCommandFailure(result));
    }
  };

  const handleDisconnectMyGitHub = async () => {
    const confirmed = await confirmTeamDestructiveAction(
      [
        gt("Disconnect your GitHub identity?"),
        gt("Your stored token will be removed and any active turn leases will be revoked."),
      ].join("\n"),
    );
    if (!confirmed) return;

    setDisconnectingMine(true);
    stopDevicePolling();
    setActiveDeviceFlow(null);
    setPendingOAuth(null);
    const result = await runDisconnectMyGitHub({
      environmentId,
      input: {},
    });
    setDisconnectingMine(false);
    if (result._tag === "Success") {
      setMyTokenInput("");
      setMyApiBaseUrlInput("");
      setMyGitNameInput("");
      setMyGitEmailInput("");
      toastManager.add({
        type: "success",
        title: gt("GitHub identity disconnected"),
        description: gt("Your stored token was removed and any active turn leases were revoked."),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not disconnect GitHub"), squashAtomCommandFailure(result));
    }
  };

  const handleSetAutomationGitHub = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = autoTokenInput.trim();
    if (token.length === 0) {
      reportError(
        gt("Could not save team automation GitHub account"),
        new Error(gt("Enter a GitHub personal access token for team automation.")),
      );
      return;
    }
    setSavingAuto(true);
    const result = await runSetAutomationGitHub({
      environmentId,
      input: {
        authMethod: "pat",
        token,
        ...(autoApiBaseUrlInput.trim().length > 0
          ? { apiBaseUrl: autoApiBaseUrlInput.trim() }
          : {}),
        ...(autoGitNameInput.trim().length > 0 ? { githubName: autoGitNameInput.trim() } : {}),
        ...(autoGitEmailInput.trim().length > 0 ? { githubEmail: autoGitEmailInput.trim() } : {}),
      },
    });
    setSavingAuto(false);
    if (result._tag === "Success") {
      setAutoTokenInput("");
      toastManager.add({
        type: "success",
        title: gt("Team automation GitHub account saved"),
        description: gt("Scheduled automation runs will authenticate as @{login}.", {
          login: result.value.githubLogin,
        }),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(
        gt("Could not save team automation GitHub account"),
        squashAtomCommandFailure(result),
      );
    }
  };

  const handleClearAutomationGitHub = async () => {
    const confirmed = await confirmTeamDestructiveAction(
      [
        gt("Remove the team automation GitHub account?"),
        gt("Scheduled automation runs will execute without GitHub credentials."),
      ].join("\n"),
    );
    if (!confirmed) return;

    setClearingAuto(true);
    const result = await runClearAutomationGitHub({
      environmentId,
      input: {},
    });
    setClearingAuto(false);
    if (result._tag === "Success") {
      setAutoTokenInput("");
      setAutoApiBaseUrlInput("");
      setAutoGitNameInput("");
      setAutoGitEmailInput("");
      toastManager.add({
        type: "success",
        title: gt("Team automation GitHub account removed"),
        description: gt("Scheduled automation runs will now run with no GitHub credentials."),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(
        gt("Could not remove team automation GitHub account"),
        squashAtomCommandFailure(result),
      );
    }
  };

  const automationUpdaterPseudo = automationGitHubIdentity
    ? (memberById.get(automationGitHubIdentity.updatedByMemberId)?.pseudo ?? "admin")
    : null;

  const isOAuthEnabled = githubAppConfig !== null && githubAppConfig.enabled;
  const needsReconnect = myGitHubIdentity?.needsReconnect === true;

  return (
    <SettingsSection
      id="teams-github"
      title={gt("GitHub identity")}
      icon={<GitBranchIcon className="size-4" />}
    >
      <SettingsRow
        title={gt("Your GitHub identity")}
        description={gt(
          "Stored encrypted for your member account only and never shared with colleagues. Forwarded dynamically per turn via a local credential broker (never as a static GH_TOKEN) and revoked immediately when a turn ends, is interrupted, or is steered.",
        )}
        control={
          needsReconnect ? (
            <Badge variant="warning" size="sm" data-testid="team-my-github-status">
              <AlertTriangleIcon className="mr-1 size-3" />
              <T>Reconnect required</T>
            </Badge>
          ) : myGitHubIdentity ? (
            <Badge variant="success" size="sm" data-testid="team-my-github-status">
              <ShieldCheckIcon className="mr-1 size-3" />
              <T>Connected</T>
            </Badge>
          ) : (
            <Badge variant="outline" size="sm" data-testid="team-my-github-status">
              <T>Not connected</T>
            </Badge>
          )
        }
      >
        {myGitHubIdentity ? (
          <div
            className="mt-2 space-y-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2"
            data-testid="team-my-github-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium" data-testid="team-my-github-login">
                    @{myGitHubIdentity.githubLogin}
                  </span>
                  <Badge variant="outline" size="sm" data-testid="team-my-github-method-badge">
                    <KeyRoundIcon className="mr-1 size-3" />
                    {formatAuthMethodBadge(myGitHubIdentity.authMethod, gt)}
                  </Badge>
                  {needsReconnect ? (
                    <Badge variant="warning" size="sm" data-testid="team-my-github-reconnect-badge">
                      <AlertTriangleIcon className="mr-1 size-3" />
                      <T>Reconnect required</T>
                    </Badge>
                  ) : myGitHubIdentity.hasRefreshToken ? (
                    <Badge variant="info" size="sm" data-testid="team-my-github-autorefresh-badge">
                      <RefreshCwIcon className="mr-1 size-3" />
                      <T>Auto-refresh</T>
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground" data-testid="team-my-github-author">
                  {myGitHubIdentity.githubName ?? myGitHubIdentity.githubLogin}
                  {myGitHubIdentity.githubEmail ? ` <${myGitHubIdentity.githubEmail}>` : ""}
                  {myGitHubIdentity.apiBaseUrl !== DEFAULT_GITHUB_API_BASE_URL
                    ? ` · ${myGitHubIdentity.apiBaseUrl}`
                    : ""}
                </p>
              </div>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={disconnectingMine || !canDisconnectMine}
                onClick={() => void handleDisconnectMyGitHub()}
                data-testid="team-my-github-disconnect"
              >
                {disconnectingMine ? <Spinner /> : <Trash2Icon />}
                <T>Disconnect</T>
              </Button>
            </div>
            {needsReconnect ? (
              <p
                className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning-foreground"
                data-testid="team-my-github-reconnect-banner"
                role="alert"
              >
                {myGitHubIdentity.reconnectReason ??
                  gt(
                    "Your GitHub authorization expired or was revoked. Sign in again to restore per-turn GitHub access.",
                  )}
              </p>
            ) : null}
          </div>
        ) : null}

        {isOAuthEnabled ? (
          <div
            className="mt-3 space-y-2.5 rounded-lg border border-border/70 bg-muted/15 p-3"
            data-testid="team-my-github-oauth-actions"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <p className="text-xs font-medium text-foreground">
                  {githubAppConfig.mode === "github_app" ? (
                    <T>Sign in with your team&apos;s GitHub App</T>
                  ) : (
                    <T>Sign in with your team&apos;s GitHub OAuth App</T>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {githubAppConfig.mode === "github_app" ? (
                    <T>
                      One-click browser sign-in with automatic short-lived token refresh on the Team
                      Server, or use a device code on LAN/Tailscale networks.
                    </T>
                  ) : (
                    <T>
                      One-click browser sign-in, or use a device code when the Team Server does not
                      have a public callback URL.
                    </T>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={startingOAuth || !canStartOAuth}
                  onClick={() => void handleStartBrowserOAuth()}
                  data-testid="team-my-github-oauth-signin"
                >
                  {startingOAuth ? <Spinner /> : <ExternalLinkIcon />}
                  {needsReconnect ? <T>Reconnect with GitHub</T> : <T>Sign in with GitHub</T>}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={startingDeviceFlow || !canStartDeviceFlow}
                  onClick={() => void handleStartDeviceFlow()}
                  data-testid="team-my-github-device-signin"
                >
                  {startingDeviceFlow ? <Spinner /> : <SmartphoneIcon />}
                  <T>Use device code</T>
                </Button>
              </div>
            </div>

            {showPendingOAuth && pendingOAuth ? (
              <div
                className="space-y-2 rounded-md border border-border/60 bg-background/60 p-2.5 text-xs"
                data-testid="team-my-github-oauth-pending"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    <Spinner />
                    <T>Waiting for GitHub sign-in to complete in your browser…</T>
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setPendingOAuth(null)}
                  >
                    <T>Dismiss</T>
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      void ensureLocalApi().shell.openExternal(pendingOAuth.authorizeUrl)
                    }
                    data-testid="team-my-github-oauth-open-link"
                  >
                    <ExternalLinkIcon />
                    <T>Open sign-in link</T>
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => copyOAuthUrl(pendingOAuth.authorizeUrl)}
                  >
                    {oauthUrlCopied ? <CheckIcon /> : <CopyIcon />}
                    {oauthUrlCopied ? gt("Copied") : gt("Copy link")}
                  </Button>
                </div>
                <form
                  className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-2"
                  onSubmit={(event) => void handleCompleteBrowserOAuth(event)}
                  data-testid="team-my-github-oauth-confirm-form"
                >
                  <Input
                    size="sm"
                    className="max-w-44"
                    value={oauthConfirmationCode}
                    onChange={(event) => setOAuthConfirmationCode(event.target.value)}
                    placeholder={gt("Confirmation code")}
                    disabled={completingOAuth}
                    data-testid="team-my-github-oauth-confirm-input"
                  />
                  <Button
                    type="submit"
                    size="xs"
                    variant="secondary"
                    disabled={completingOAuth || oauthConfirmationCode.trim().length === 0}
                    data-testid="team-my-github-oauth-confirm-submit"
                  >
                    {completingOAuth ? <Spinner /> : <CheckIcon />}
                    <T>Confirm sign-in</T>
                  </Button>
                  <span className="text-2xs text-muted-foreground">
                    <T>Only needed if the callback page shows a one-time confirmation code.</T>
                  </span>
                </form>
              </div>
            ) : null}

            {activeDeviceFlow ? (
              <div
                className="space-y-2.5 rounded-md border border-border/60 bg-background/60 p-3"
                data-testid="team-my-github-device-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <p className="text-xs font-medium text-foreground">
                      <T>Enter this code on GitHub to authorize</T>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <T>
                        Open <Var>{activeDeviceFlow.verificationUri}</Var> and enter the one-time
                        code below.
                      </T>
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => void handleCancelDeviceFlow()}
                    data-testid="team-my-github-device-cancel"
                  >
                    <T>Cancel</T>
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <code
                    className="rounded-md border border-border bg-muted px-3 py-1.5 font-mono text-base font-semibold tracking-widest text-foreground"
                    data-testid="team-my-github-device-code"
                  >
                    {activeDeviceFlow.userCode}
                  </code>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => copyDeviceCode(activeDeviceFlow.userCode)}
                    data-testid="team-my-github-device-copy"
                  >
                    {deviceCodeCopied ? <CheckIcon /> : <CopyIcon />}
                    {deviceCodeCopied ? gt("Copied") : gt("Copy code")}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      void ensureLocalApi().shell.openExternal(
                        activeDeviceFlow.verificationUriComplete ??
                          activeDeviceFlow.verificationUri,
                      )
                    }
                    data-testid="team-my-github-device-open"
                  >
                    <ExternalLinkIcon />
                    <T>Open GitHub</T>
                  </Button>
                </div>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Spinner />
                  <T>Waiting for GitHub authorization…</T>
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-3 space-y-2 pb-1">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setShowMyAuthorOverrides((prev) => !prev)}
            data-testid="team-my-github-author-toggle"
          >
            {showMyAuthorOverrides ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
            <T>Git commit author overrides (optional)</T>
          </Button>
          {showMyAuthorOverrides ? (
            <div
              className="grid gap-3 rounded-lg border border-border/60 bg-muted/15 p-3 sm:grid-cols-2"
              data-testid="team-my-github-author-fields"
            >
              <div className="space-y-1.5">
                <label
                  className="block text-xs font-medium text-foreground"
                  htmlFor="team-my-github-name"
                >
                  <T>Git author name (optional)</T>
                </label>
                <Input
                  id="team-my-github-name"
                  data-testid="team-my-github-name-input"
                  value={myGitNameInput}
                  onChange={(event) => setMyGitNameInput(event.currentTarget.value)}
                  placeholder={gt("From GitHub profile")}
                  disabled={savingMine || !canConnectMine}
                />
              </div>
              <div className="space-y-1.5">
                <label
                  className="block text-xs font-medium text-foreground"
                  htmlFor="team-my-github-email"
                >
                  <T>Git author email (optional)</T>
                </label>
                <Input
                  id="team-my-github-email"
                  data-testid="team-my-github-email-input"
                  value={myGitEmailInput}
                  onChange={(event) => setMyGitEmailInput(event.currentTarget.value)}
                  placeholder={gt("From GitHub profile")}
                  disabled={savingMine || !canConnectMine}
                />
              </div>
            </div>
          ) : null}
        </div>

        {isOAuthEnabled ? (
          <div className="mt-2 pb-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setShowMyPatSection((prev) => !prev)}
              data-testid="team-my-github-pat-disclosure"
            >
              {showMyPatSection ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
              <T>Use a Personal Access Token instead</T>
            </Button>
          </div>
        ) : null}

        {!isOAuthEnabled || showMyPatSection ? (
          <form
            className="mt-2 space-y-3 pb-3"
            onSubmit={(event) => void handleConnectMyGitHub(event)}
          >
            <div className="space-y-1.5">
              <label
                className="block text-xs font-medium text-foreground"
                htmlFor="team-my-github-token"
              >
                {isOAuthEnabled ? (
                  <T>Fine-grained personal access token</T>
                ) : myGitHubIdentity ? (
                  <T>Rotate fine-grained personal access token</T>
                ) : (
                  <T>Fine-grained personal access token</T>
                )}
              </label>
              <Input
                id="team-my-github-token"
                data-testid="team-my-github-token-input"
                type="password"
                autoComplete="off"
                value={myTokenInput}
                onChange={(event) => setMyTokenInput(event.currentTarget.value)}
                placeholder={gt("github_pat_…")}
                disabled={savingMine || !canConnectMine}
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setShowMyEnterpriseApi((prev) => !prev)}
                data-testid="team-my-github-advanced-toggle"
              >
                {showMyEnterpriseApi ? (
                  <T>Hide GitHub Enterprise API URL</T>
                ) : (
                  <T>GitHub Enterprise API URL</T>
                )}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={savingMine || !canConnectMine || myTokenInput.trim().length === 0}
                data-testid="team-my-github-save"
              >
                {savingMine ? (
                  <>
                    <Spinner />
                    <T>Verifying…</T>
                  </>
                ) : myGitHubIdentity ? (
                  <T>Update token</T>
                ) : (
                  <T>Connect GitHub</T>
                )}
              </Button>
            </div>

            {showMyEnterpriseApi ? (
              <div className="rounded-lg border border-border/60 bg-muted/15 p-3">
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-my-github-api-url"
                  >
                    <T>GitHub API base URL</T>
                  </label>
                  <Input
                    id="team-my-github-api-url"
                    data-testid="team-my-github-api-url-input"
                    value={myApiBaseUrlInput}
                    onChange={(event) => setMyApiBaseUrlInput(event.currentTarget.value)}
                    placeholder={DEFAULT_GITHUB_API_BASE_URL}
                    disabled={savingMine || !canConnectMine}
                  />
                </div>
              </div>
            ) : null}
          </form>
        ) : null}
      </SettingsRow>

      {currentMember !== null && canManageTeamGitHubAppConfig(currentMember.role) ? (
        <SettingsRow
          id="teams-github-oauth-app"
          title={gt("GitHub OAuth / GitHub App sign-in")}
          description={gt(
            "Configure a team GitHub App (recommended for short-lived auto-refreshing user tokens) or OAuth App so members can sign in with one click or a device code. Client secrets are stored encrypted on the Team Server and never sent to clients.",
          )}
          control={
            githubAppConfig?.enabled ? (
              <Badge variant="success" size="sm" data-testid="team-github-app-status">
                <T>Enabled</T>
              </Badge>
            ) : githubAppConfig ? (
              <Badge variant="outline" size="sm" data-testid="team-github-app-status">
                <T>Disabled</T>
              </Badge>
            ) : (
              <Badge variant="outline" size="sm" data-testid="team-github-app-status">
                <T>Not configured</T>
              </Badge>
            )
          }
        >
          <form
            className="mt-3 space-y-3 pb-3"
            onSubmit={(event) => void handleSaveAppConfig(event)}
            data-testid="team-github-app-form"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  className="block text-xs font-medium text-foreground"
                  htmlFor="team-github-app-mode"
                >
                  <T>App type</T>
                </label>
                <Select
                  value={effectiveAppMode}
                  disabled={savingAppConfig || !canManageAppConfig}
                  onValueChange={(value) => {
                    if (value === "github_app" || value === "oauth") {
                      setAppModeDraft(value);
                    }
                  }}
                >
                  <SelectTrigger
                    id="team-github-app-mode"
                    size="sm"
                    data-testid="team-github-app-mode-select"
                  >
                    <SelectValue>{formatOAuthModeLabel(effectiveAppMode, gt)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="github_app">
                      {formatOAuthModeLabel("github_app", gt)}
                    </SelectItem>
                    <SelectItem value="oauth">{formatOAuthModeLabel("oauth", gt)}</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex items-end justify-between rounded-lg border border-border/60 bg-muted/15 px-3 py-2">
                <span className="text-xs font-medium text-foreground">
                  <T>Enable member sign-in</T>
                </span>
                <Switch
                  checked={effectiveAppEnabled}
                  onCheckedChange={(checked) => setAppEnabledDraft(checked)}
                  disabled={savingAppConfig || !canManageAppConfig}
                  data-testid="team-github-app-enabled-switch"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label
                  className="block text-xs font-medium text-foreground"
                  htmlFor="team-github-app-client-id"
                >
                  <T>Client ID</T>
                </label>
                <Input
                  id="team-github-app-client-id"
                  data-testid="team-github-app-client-id-input"
                  value={effectiveAppClientId}
                  onChange={(event) => setAppClientIdDraft(event.currentTarget.value)}
                  placeholder={gt("Iv1.… or Ov23li…")}
                  disabled={savingAppConfig || !canManageAppConfig}
                />
              </div>
              <div className="space-y-1.5">
                <label
                  className="block text-xs font-medium text-foreground"
                  htmlFor="team-github-app-client-secret"
                >
                  <T>Client Secret</T>
                </label>
                <Input
                  id="team-github-app-client-secret"
                  data-testid="team-github-app-client-secret-input"
                  type="password"
                  autoComplete="off"
                  value={appClientSecretInput}
                  onChange={(event) => {
                    setAppClientSecretInput(event.currentTarget.value);
                    if (appClearClientSecret) setAppClearClientSecret(false);
                  }}
                  placeholder={
                    githubAppConfig?.hasClientSecret && !appClearClientSecret
                      ? gt("Configured (leave blank to keep existing)")
                      : gt("Optional for PKCE / Device Flow")
                  }
                  disabled={savingAppConfig || !canManageAppConfig}
                />
              </div>
            </div>

            {callbackUrl ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  <T>Authorization callback URL (paste into GitHub App / OAuth App settings)</T>
                </p>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <Input
                      value={callbackUrl}
                      readOnly
                      data-testid="team-github-app-callback-url"
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => copyCallbackUrl(callbackUrl)}
                    data-testid="team-github-app-callback-copy"
                  >
                    {callbackUrlCopied ? <CheckIcon /> : <CopyIcon />}
                    {callbackUrlCopied ? gt("Copied") : gt("Copy")}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setShowAppAdvanced((prev) => !prev)}
                  data-testid="team-github-app-advanced-toggle"
                >
                  {effectiveAppMode === "oauth" ? (
                    showAppAdvanced ? (
                      <T>Hide enterprise URLs &amp; scopes</T>
                    ) : (
                      <T>Enterprise URLs &amp; scopes</T>
                    )
                  ) : showAppAdvanced ? (
                    <T>Hide enterprise URLs</T>
                  ) : (
                    <T>Enterprise URLs</T>
                  )}
                </Button>
                {githubAppConfig?.hasClientSecret && !appClearClientSecret ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setAppClearClientSecret(true);
                      setAppClientSecretInput("");
                    }}
                    disabled={savingAppConfig || !canManageAppConfig}
                  >
                    <T>Clear saved secret</T>
                  </Button>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {githubAppConfig ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={clearingAppConfig || !canClearAppConfig}
                    onClick={() => void handleClearAppConfig()}
                    data-testid="team-github-app-clear"
                  >
                    {clearingAppConfig ? <Spinner /> : <Trash2Icon />}
                    <T>Remove</T>
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    savingAppConfig ||
                    !canManageAppConfig ||
                    effectiveAppClientId.trim().length === 0
                  }
                  data-testid="team-github-app-save"
                >
                  {savingAppConfig ? (
                    <>
                      <Spinner />
                      <T>Saving…</T>
                    </>
                  ) : (
                    <T>Save configuration</T>
                  )}
                </Button>
              </div>
            </div>

            {showAppAdvanced ? (
              <div
                className={
                  effectiveAppMode === "oauth"
                    ? "grid gap-3 rounded-lg border border-border/60 bg-muted/15 p-3 sm:grid-cols-3"
                    : "grid gap-3 rounded-lg border border-border/60 bg-muted/15 p-3 sm:grid-cols-2"
                }
              >
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-github-app-web-url"
                  >
                    <T>GitHub web base URL</T>
                  </label>
                  <Input
                    id="team-github-app-web-url"
                    data-testid="team-github-app-web-url-input"
                    value={effectiveAppWebBaseUrl}
                    onChange={(event) => setAppWebBaseUrlDraft(event.currentTarget.value)}
                    placeholder={DEFAULT_GITHUB_WEB_BASE_URL}
                    disabled={savingAppConfig || !canManageAppConfig}
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-github-app-api-url"
                  >
                    <T>GitHub API base URL</T>
                  </label>
                  <Input
                    id="team-github-app-api-url"
                    data-testid="team-github-app-api-url-input"
                    value={effectiveAppApiBaseUrl}
                    onChange={(event) => setAppApiBaseUrlDraft(event.currentTarget.value)}
                    placeholder={DEFAULT_GITHUB_API_BASE_URL}
                    disabled={savingAppConfig || !canManageAppConfig}
                  />
                </div>
                {effectiveAppMode === "oauth" ? (
                  <div className="space-y-1.5">
                    <label
                      className="block text-xs font-medium text-foreground"
                      htmlFor="team-github-app-scopes"
                    >
                      <T>OAuth scopes</T>
                    </label>
                    <Input
                      id="team-github-app-scopes"
                      data-testid="team-github-app-scopes-input"
                      value={effectiveAppScopes}
                      onChange={(event) => setAppScopesDraft(event.currentTarget.value)}
                      placeholder={DEFAULT_GITHUB_OAUTH_SCOPES}
                      disabled={savingAppConfig || !canManageAppConfig}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </form>
        </SettingsRow>
      ) : null}

      {currentMember !== null && canManageTeamAutomationGitHub(currentMember.role) ? (
        <SettingsRow
          id="teams-github-automation"
          title={gt("Team automation GitHub account (optional)")}
          description={gt(
            "Dedicated GitHub account used by team scheduled-task runs. Scheduled tasks never borrow a human member's token; when unconfigured, automation runs cleanly with no GitHub credentials.",
          )}
          control={
            automationGitHubIdentity ? (
              <Badge variant="info" size="sm" data-testid="team-automation-github-status">
                <BotIcon className="mr-1 size-3" />
                <T>Configured</T>
              </Badge>
            ) : (
              <Badge variant="outline" size="sm" data-testid="team-automation-github-status">
                <T>None</T>
              </Badge>
            )
          }
        >
          {automationGitHubIdentity ? (
            <div
              className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2"
              data-testid="team-automation-github-card"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium" data-testid="team-automation-github-login">
                    @{automationGitHubIdentity.githubLogin}
                  </span>
                  <Badge variant="outline" size="sm">
                    {formatAuthMethodBadge(automationGitHubIdentity.authMethod, gt)}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {automationGitHubIdentity.githubName ?? automationGitHubIdentity.githubLogin}
                  {automationGitHubIdentity.githubEmail
                    ? ` <${automationGitHubIdentity.githubEmail}>`
                    : ""}
                  {automationUpdaterPseudo ? (
                    <>
                      {" · "}
                      <T>
                        Updated by <Var>{automationUpdaterPseudo}</Var>
                      </T>
                    </>
                  ) : null}
                </p>
              </div>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={clearingAuto || !canClearAutomation}
                onClick={() => void handleClearAutomationGitHub()}
                data-testid="team-automation-github-clear"
              >
                {clearingAuto ? <Spinner /> : <Trash2Icon />}
                <T>Remove</T>
              </Button>
            </div>
          ) : null}

          <form
            className="mt-3 space-y-3 pb-3"
            onSubmit={(event) => void handleSetAutomationGitHub(event)}
          >
            <div className="space-y-1.5">
              <label
                className="block text-xs font-medium text-foreground"
                htmlFor="team-automation-github-token"
              >
                {automationGitHubIdentity ? (
                  <T>Rotate automation personal access token</T>
                ) : (
                  <T>Automation personal access token</T>
                )}
              </label>
              <Input
                id="team-automation-github-token"
                data-testid="team-automation-github-token-input"
                type="password"
                autoComplete="off"
                value={autoTokenInput}
                onChange={(event) => setAutoTokenInput(event.currentTarget.value)}
                placeholder={gt("github_pat_…")}
                disabled={savingAuto || !canManageAutomation}
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setShowAutoAdvanced((prev) => !prev)}
                data-testid="team-automation-github-advanced-toggle"
              >
                {showAutoAdvanced ? (
                  <T>Hide enterprise / git author options</T>
                ) : (
                  <T>Enterprise API URL & git author options</T>
                )}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={savingAuto || !canManageAutomation || autoTokenInput.trim().length === 0}
                data-testid="team-automation-github-save"
              >
                {savingAuto ? (
                  <>
                    <Spinner />
                    <T>Verifying…</T>
                  </>
                ) : automationGitHubIdentity ? (
                  <T>Update automation account</T>
                ) : (
                  <T>Save automation account</T>
                )}
              </Button>
            </div>

            {showAutoAdvanced ? (
              <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/15 p-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-automation-github-api-url"
                  >
                    <T>GitHub API base URL</T>
                  </label>
                  <Input
                    id="team-automation-github-api-url"
                    data-testid="team-automation-github-api-url-input"
                    value={autoApiBaseUrlInput}
                    onChange={(event) => setAutoApiBaseUrlInput(event.currentTarget.value)}
                    placeholder={DEFAULT_GITHUB_API_BASE_URL}
                    disabled={savingAuto || !canManageAutomation}
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-automation-github-name"
                  >
                    <T>Git author name (optional)</T>
                  </label>
                  <Input
                    id="team-automation-github-name"
                    data-testid="team-automation-github-name-input"
                    value={autoGitNameInput}
                    onChange={(event) => setAutoGitNameInput(event.currentTarget.value)}
                    placeholder={gt("From GitHub profile")}
                    disabled={savingAuto || !canManageAutomation}
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-automation-github-email"
                  >
                    <T>Git author email (optional)</T>
                  </label>
                  <Input
                    id="team-automation-github-email"
                    data-testid="team-automation-github-email-input"
                    value={autoGitEmailInput}
                    onChange={(event) => setAutoGitEmailInput(event.currentTarget.value)}
                    placeholder={gt("From GitHub profile")}
                    disabled={savingAuto || !canManageAutomation}
                  />
                </div>
              </div>
            ) : null}
          </form>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
