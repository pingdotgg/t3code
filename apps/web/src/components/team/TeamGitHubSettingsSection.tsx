import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  canManageTeamAutomationGitHub,
  DEFAULT_GITHUB_API_BASE_URL,
  type EnvironmentId,
  type TeamAutomationGitHubIdentity,
  type TeamGitHubAuthMethod,
  type TeamGitHubIdentity,
  type TeamMember,
  type TeamMemberId,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { BotIcon, GitBranchIcon, KeyRoundIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { m } from "~/i18n/messages";
import { teamEnvironment } from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";

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

export function TeamGitHubSettingsSection({
  environmentId,
  currentMember,
  memberById,
  myGitHubIdentity,
  automationGitHubIdentity,
}: {
  readonly environmentId: EnvironmentId;
  readonly currentMember: TeamMember | null;
  readonly memberById: ReadonlyMap<TeamMemberId, TeamMember>;
  readonly myGitHubIdentity: TeamGitHubIdentity | null;
  readonly automationGitHubIdentity: TeamAutomationGitHubIdentity | null;
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

  const canConnectMine =
    canConnectMineScope && currentMember !== null && currentMember.status === "active";
  const canDisconnectMine =
    canDisconnectMineScope && currentMember !== null && currentMember.status === "active";
  const canManageAutomation =
    canManageAutomationScope &&
    currentMember !== null &&
    currentMember.status === "active" &&
    canManageTeamAutomationGitHub(currentMember.role);
  const canClearAutomation =
    canClearAutomationScope &&
    currentMember !== null &&
    currentMember.status === "active" &&
    canManageTeamAutomationGitHub(currentMember.role);

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

  const [myTokenInput, setMyTokenInput] = useState("");
  const [myApiBaseUrlInput, setMyApiBaseUrlInput] = useState("");
  const [myGitNameInput, setMyGitNameInput] = useState("");
  const [myGitEmailInput, setMyGitEmailInput] = useState("");
  const [showMyAdvanced, setShowMyAdvanced] = useState(false);
  const [savingMine, setSavingMine] = useState(false);
  const [disconnectingMine, setDisconnectingMine] = useState(false);

  const [autoTokenInput, setAutoTokenInput] = useState("");
  const [autoApiBaseUrlInput, setAutoApiBaseUrlInput] = useState("");
  const [autoGitNameInput, setAutoGitNameInput] = useState("");
  const [autoGitEmailInput, setAutoGitEmailInput] = useState("");
  const [showAutoAdvanced, setShowAutoAdvanced] = useState(false);
  const [savingAuto, setSavingAuto] = useState(false);
  const [clearingAuto, setClearingAuto] = useState(false);

  const reportError = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? title,
    });
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
    setDisconnectingMine(true);
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
          myGitHubIdentity ? (
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
            className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2"
            data-testid="team-my-github-card"
          >
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium" data-testid="team-my-github-login">
                  @{myGitHubIdentity.githubLogin}
                </span>
                <Badge variant="outline" size="sm">
                  <KeyRoundIcon className="mr-1 size-3" />
                  {formatAuthMethodBadge(myGitHubIdentity.authMethod, gt)}
                </Badge>
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
        ) : null}

        <form
          className="mt-3 space-y-3 pb-3"
          onSubmit={(event) => void handleConnectMyGitHub(event)}
        >
          <div className="space-y-1.5">
            <label
              className="block text-xs font-medium text-foreground"
              htmlFor="team-my-github-token"
            >
              {myGitHubIdentity ? (
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
              onClick={() => setShowMyAdvanced((prev) => !prev)}
              data-testid="team-my-github-advanced-toggle"
            >
              {showMyAdvanced ? (
                <T>Hide enterprise / git author options</T>
              ) : (
                <T>Enterprise API URL & git author options</T>
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

          {showMyAdvanced ? (
            <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/15 p-3 sm:grid-cols-3">
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
        </form>
      </SettingsRow>

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
