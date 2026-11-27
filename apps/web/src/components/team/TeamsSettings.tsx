import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  assignableTeamRoles,
  buildTeamJoinDeepLink,
  buildTeamJoinWebUrl,
  canAssignTeamRole,
  canManageTeamDisplayName,
  canManageTeamInvites,
  normalizeTeamPseudo,
  parseTeamJoinLink,
  type EnvironmentId,
  type TeamInviteCreatedResult,
  type TeamRole,
} from "@t3tools/contracts";
import { msg, T, useGT, Var } from "gt-react";
import { CheckIcon, CopyIcon, LinkIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { isElectron } from "~/env";
import { configuredHostedAppUrl } from "~/hostedPairing";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useNowMinute } from "~/hooks/useNowMinute";
import { m } from "~/i18n/messages";
import {
  useEnvironmentHttpBaseUrl,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import {
  setShowColleaguesThreads,
  teamEnvironment,
  useShowColleaguesThreads,
  useTeamEnvironmentState,
  useTeamStatesByEnvironment,
} from "~/state/team";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { formatTeamRoleLabel } from "./TeamJoinForm";
import { openTeamJoinDialog } from "./teamJoinDialogState";
import { TeamEnvironmentsSettingsSection } from "./TeamEnvironmentsSettingsSection";
import { TeamGitHubSettingsSection } from "./TeamGitHubSettingsSection";
import { TeamMembersSettingsSection } from "./TeamMembersSettingsSection";
import { TeamMobileCompatSection } from "./TeamMobileCompatSection";
import { TeamNotificationSoundRow } from "./TeamNotificationSoundSettings";
import { TeamProvidersSettingsSection } from "./TeamProvidersSettingsSection";
import { TeamSkillsAndPrepromptsSettingsSection } from "./TeamSkillsAndPrepromptsSettingsSection";
import { TeamViewsSettingsSection } from "./TeamViewsSettingsSection";

function CopyableLinkRow({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}) {
  const gt = useGT();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "team invite link",
      unavailableMessage: msg("Clipboard API is unavailable while copying team invite link."),
      failureMessage: msg("Failed to copy team invite link to the clipboard."),
    },
  });

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input value={value} readOnly data-testid={testId} />
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => copyToClipboard(value)}>
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? gt("Copied") : gt("Copy")}
        </Button>
      </div>
    </div>
  );
}

interface GeneratedInviteBanner {
  readonly environmentId: EnvironmentId;
  readonly serverBaseUrl: string;
  readonly result: TeamInviteCreatedResult;
}

function resolveShareableWebAppBaseUrl(): string {
  if (typeof window === "undefined" || isElectron) {
    return configuredHostedAppUrl();
  }
  const { protocol, hostname, origin } = window.location;
  const isLoopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
  if ((protocol === "https:" || protocol === "http:") && !isLoopback) {
    return origin;
  }
  return configuredHostedAppUrl();
}

export function TeamsSettings() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const teamStates = useTeamStatesByEnvironment();
  const showColleagues = useShowColleaguesThreads();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);

  const connectedEnvironments = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const firstTeamEnvironment =
    connectedEnvironments.find(
      (environment) => teamStates.get(environment.environmentId)?.team != null,
    ) ?? null;

  const [selectedEnvironmentIdOverride, setSelectedEnvironmentIdOverride] =
    useState<EnvironmentId | null>(null);
  const selectedEnvironment =
    connectedEnvironments.find(
      (environment) => environment.environmentId === selectedEnvironmentIdOverride,
    ) ??
    firstTeamEnvironment ??
    connectedEnvironments.find(
      (environment) => environment.environmentId === primaryEnvironmentId,
    ) ??
    connectedEnvironments[0] ??
    null;

  const selectedEnvironmentId = selectedEnvironment?.environmentId ?? null;
  const teamState = useTeamEnvironmentState(selectedEnvironmentId);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(selectedEnvironmentId);
  const serverBaseUrl =
    environmentHttpBaseUrl ??
    selectedEnvironment?.displayUrl ??
    (typeof window !== "undefined" ? window.location.origin : "");

  const canInitialize = useAtomValue(
    teamEnvironment.initialize.permissionAtom(selectedEnvironmentId),
  );
  const canUpdateDisplayName = useAtomValue(
    teamEnvironment.updateDisplayName.permissionAtom(selectedEnvironmentId),
  );
  const canUpdatePseudo = useAtomValue(
    teamEnvironment.updateMyPseudo.permissionAtom(selectedEnvironmentId),
  );
  const canCreateInviteScope = useAtomValue(
    teamEnvironment.createInvite.permissionAtom(selectedEnvironmentId),
  );
  const canRevokeInviteScope = useAtomValue(
    teamEnvironment.revokeInvite.permissionAtom(selectedEnvironmentId),
  );

  const runInitialize = useAtomCommand(teamEnvironment.initialize, { reportFailure: false });
  const runUpdateDisplayName = useAtomCommand(teamEnvironment.updateDisplayName, {
    reportFailure: false,
  });
  const runUpdateMyPseudo = useAtomCommand(teamEnvironment.updateMyPseudo, {
    reportFailure: false,
  });
  const runCreateInvite = useAtomCommand(teamEnvironment.createInvite, { reportFailure: false });
  const runRevokeInvite = useAtomCommand(teamEnvironment.revokeInvite, { reportFailure: false });

  const [teamNameInput, setTeamNameInput] = useState("");
  const [teamDisplayNameInput, setTeamDisplayNameInput] = useState("");
  const [ownerPseudoInput, setOwnerPseudoInput] = useState("");
  const [initializing, setInitializing] = useState(false);

  const [displayNameDraft, setDisplayNameDraft] = useState<string | null>(null);
  const [savingDisplayName, setSavingDisplayName] = useState(false);

  const [myPseudoDraft, setMyPseudoDraft] = useState<string | null>(null);
  const [savingPseudo, setSavingPseudo] = useState(false);

  const [inviteRole, setInviteRole] = useState<TeamRole>("regular");
  const [invitePseudo, setInvitePseudo] = useState("");
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [latestInvite, setLatestInvite] = useState<GeneratedInviteBanner | null>(null);
  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);

  const [joinLinkInput, setJoinLinkInput] = useState("");
  const [joinLinkError, setJoinLinkError] = useState<string | null>(null);

  const currentMember = teamState.currentMember;
  const activeDisplayNameValue =
    displayNameDraft ?? teamState.team?.displayName ?? teamState.team?.name ?? "";
  const activePseudoValue = myPseudoDraft ?? currentMember?.pseudo ?? "";
  const assignableRoles = currentMember ? assignableTeamRoles(currentMember.role) : [];
  const effectiveInviteRole = assignableRoles.includes(inviteRole)
    ? inviteRole
    : (assignableRoles[assignableRoles.length - 1] ?? "regular");

  const reportError = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? title,
    });
  };

  const handleInitializeTeam = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedEnvironmentId === null) return;
    const trimmedName = teamNameInput.trim();
    const trimmedDisplayName = teamDisplayNameInput.trim();
    const normalizedPseudo = normalizeTeamPseudo(ownerPseudoInput);
    if (trimmedName.length === 0) {
      reportError(gt("Could not create team"), new Error(gt("Enter a team name.")));
      return;
    }
    if (normalizedPseudo.length < 2) {
      reportError(
        gt("Could not create team"),
        new Error(gt("Choose a pseudo with at least 2 characters.")),
      );
      return;
    }
    setInitializing(true);
    const result = await runInitialize({
      environmentId: selectedEnvironmentId,
      input: {
        name: trimmedName,
        ...(trimmedDisplayName.length > 0 ? { displayName: trimmedDisplayName } : {}),
        ownerPseudo: normalizedPseudo,
      },
    });
    setInitializing(false);
    if (result._tag === "Success") {
      setTeamNameInput("");
      setTeamDisplayNameInput("");
      setOwnerPseudoInput("");
      setDisplayNameDraft(null);
      setMyPseudoDraft(null);
      toastManager.add({
        type: "success",
        title: gt("Team initialized"),
        description: gt("You are now the owner of {teamName} as {pseudo}.", {
          teamName: result.value.team.name,
          pseudo: result.value.owner.pseudo,
        }),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not create team"), squashAtomCommandFailure(result));
    }
  };

  const handleSaveDisplayName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedEnvironmentId === null) return;
    const trimmed = activeDisplayNameValue.trim();
    if (trimmed.length === 0) {
      reportError(gt("Could not update display name"), new Error(gt("Enter a team display name.")));
      return;
    }
    setSavingDisplayName(true);
    const result = await runUpdateDisplayName({
      environmentId: selectedEnvironmentId,
      input: { displayName: trimmed },
    });
    setSavingDisplayName(false);
    if (result._tag === "Success") {
      setDisplayNameDraft(null);
      toastManager.add({
        type: "success",
        title: gt("Team display name updated"),
        description: gt("Team automation threads now display as {displayName}.", {
          displayName: result.value.displayName,
        }),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not update display name"), squashAtomCommandFailure(result));
    }
  };

  const handleSaveMyPseudo = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedEnvironmentId === null) return;
    const normalized = normalizeTeamPseudo(activePseudoValue);
    if (normalized.length < 2) {
      reportError(
        gt("Could not update pseudo"),
        new Error(gt("Choose a pseudo with at least 2 characters.")),
      );
      return;
    }
    setSavingPseudo(true);
    const result = await runUpdateMyPseudo({
      environmentId: selectedEnvironmentId,
      input: { pseudo: normalized },
    });
    setSavingPseudo(false);
    if (result._tag === "Success") {
      setMyPseudoDraft(null);
      toastManager.add({
        type: "success",
        title: gt("Pseudo updated"),
        description: gt("Your threads now display as {pseudo}.", {
          pseudo: result.value.pseudo,
        }),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not update pseudo"), squashAtomCommandFailure(result));
    }
  };

  const handleCreateInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedEnvironmentId === null) return;
    const targetEnvironmentId = selectedEnvironmentId;
    const targetServerBaseUrl = serverBaseUrl;
    const trimmedPseudo = invitePseudo.trim();
    setCreatingInvite(true);
    const result = await runCreateInvite({
      environmentId: targetEnvironmentId,
      input: {
        role: effectiveInviteRole,
        ...(trimmedPseudo.length > 0
          ? { prefilledPseudo: normalizeTeamPseudo(trimmedPseudo) }
          : {}),
        maxUses: 1,
      },
    });
    setCreatingInvite(false);
    if (result._tag === "Success") {
      setLatestInvite({
        environmentId: targetEnvironmentId,
        serverBaseUrl: targetServerBaseUrl,
        result: result.value,
      });
      setInvitePseudo("");
      toastManager.add({
        type: "success",
        title: gt("Invite link generated"),
        description: gt("Share the deep link or web link with your teammate."),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not create invite"), squashAtomCommandFailure(result));
    }
  };

  const handleRevokeInvite = async (inviteId: (typeof teamState.invites)[number]["id"]) => {
    if (selectedEnvironmentId === null) return;
    const targetEnvironmentId = selectedEnvironmentId;
    setRevokingInviteId(inviteId);
    const result = await runRevokeInvite({
      environmentId: targetEnvironmentId,
      input: { inviteId },
    });
    setRevokingInviteId(null);
    if (result._tag === "Success") {
      setLatestInvite((current) =>
        current &&
        current.environmentId === targetEnvironmentId &&
        current.result.invite.id === inviteId
          ? null
          : current,
      );
      toastManager.add({
        type: "success",
        title: gt("Invite revoked"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not revoke invite"), squashAtomCommandFailure(result));
    }
  };

  const handleOpenJoinLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseTeamJoinLink(joinLinkInput);
    if (parsed === null) {
      setJoinLinkError(
        gt("Paste a valid team invite link (t3code://team/join?... or .../team/join?...)."),
      );
      return;
    }
    setJoinLinkError(null);
    setJoinLinkInput("");
    openTeamJoinDialog({
      serverUrl: parsed.serverUrl,
      token: parsed.token,
      prefilledPseudo: parsed.prefilledPseudo,
    });
  };

  const activeLatestInvite =
    latestInvite !== null &&
    latestInvite.environmentId === selectedEnvironmentId &&
    latestInvite.serverBaseUrl.length > 0
      ? latestInvite
      : null;

  const latestDeepLink = activeLatestInvite
    ? buildTeamJoinDeepLink({
        serverUrl: activeLatestInvite.serverBaseUrl,
        token: activeLatestInvite.result.token,
        ...(activeLatestInvite.result.invite.prefilledPseudo
          ? { prefilledPseudo: activeLatestInvite.result.invite.prefilledPseudo }
          : {}),
      })
    : null;

  const latestWebLink = activeLatestInvite
    ? buildTeamJoinWebUrl({
        appBaseUrl: resolveShareableWebAppBaseUrl(),
        serverUrl: activeLatestInvite.serverBaseUrl,
        token: activeLatestInvite.result.token,
        ...(activeLatestInvite.result.invite.prefilledPseudo
          ? { prefilledPseudo: activeLatestInvite.result.invite.prefilledPseudo }
          : {}),
      })
    : null;

  return (
    <SettingsPageContainer>
      {connectedEnvironments.length > 1 && selectedEnvironment !== null ? (
        <SettingsSection title={gt("Team server")} icon={<UsersIcon className="size-4" />}>
          <SettingsRow
            title={gt("Active server")}
            description={gt("Choose which connected server to configure as a team workspace.")}
            control={
              <Select
                value={selectedEnvironment.environmentId}
                onValueChange={(value) => {
                  if (typeof value === "string") {
                    setSelectedEnvironmentIdOverride(value as EnvironmentId);
                    setDisplayNameDraft(null);
                    setMyPseudoDraft(null);
                  }
                }}
              >
                <SelectTrigger size="sm" data-testid="team-server-select">
                  <SelectValue>{selectedEnvironment.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {connectedEnvironments.map((environment) => {
                    const envTeam = teamStates.get(environment.environmentId)?.team;
                    return (
                      <SelectItem key={environment.environmentId} value={environment.environmentId}>
                        {envTeam ? `${environment.label} (${envTeam.name})` : environment.label}
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      ) : null}

      {selectedEnvironment === null ? (
        <SettingsSection title={gt("Teams")} icon={<UsersIcon className="size-4" />}>
          <SettingsRow
            title={gt("No connected server")}
            description={gt(
              "Connect to a local or remote T3 server, or paste a team invite link below to join a shared server.",
            )}
          />
        </SettingsSection>
      ) : teamState.team === null ? (
        <SettingsSection
          id="teams-initialize"
          title={gt("Create a team")}
          icon={<UsersIcon className="size-4" />}
        >
          <SettingsRow
            title={gt("Initialize team workspace")}
            description={gt(
              "Turn {server} into a shared team server. You will become the initial owner and can invite teammates with role-scoped links.",
              { server: selectedEnvironment.label },
            )}
          >
            <form
              className="mt-3 space-y-3 pb-3"
              onSubmit={(event) => void handleInitializeTeam(event)}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-init-name"
                  >
                    <T>Team name</T>
                  </label>
                  <Input
                    id="team-init-name"
                    data-testid="team-init-name"
                    value={teamNameInput}
                    onChange={(event) => setTeamNameInput(event.currentTarget.value)}
                    placeholder={gt("e.g. Core Engineering")}
                    disabled={initializing || !canInitialize}
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-init-pseudo"
                  >
                    <T>Your pseudo</T>
                  </label>
                  <Input
                    id="team-init-pseudo"
                    data-testid="team-init-pseudo"
                    value={ownerPseudoInput}
                    onChange={(event) => setOwnerPseudoInput(event.currentTarget.value)}
                    placeholder={gt("e.g. alice")}
                    disabled={initializing || !canInitialize}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label
                  className="block text-xs font-medium text-foreground"
                  htmlFor="team-init-display-name"
                >
                  <T>Display name (optional)</T>
                </label>
                <Input
                  id="team-init-display-name"
                  data-testid="team-init-display-name"
                  value={teamDisplayNameInput}
                  onChange={(event) => setTeamDisplayNameInput(event.currentTarget.value)}
                  placeholder={teamNameInput.trim() || gt("Defaults to team name")}
                  disabled={initializing || !canInitialize}
                />
                <p className="text-xs text-muted-foreground">
                  <T>
                    Defaults to the team name if left blank. Shown as the prefix on team-owned
                    scheduled-task threads.
                  </T>
                </p>
              </div>
              <div className="flex justify-end">
                <Button
                  type="submit"
                  size="sm"
                  disabled={initializing || !canInitialize}
                  data-testid="team-init-submit"
                >
                  {initializing ? (
                    <>
                      <Spinner />
                      <T>Initializing…</T>
                    </>
                  ) : (
                    <T>Initialize team</T>
                  )}
                </Button>
              </div>
            </form>
          </SettingsRow>
        </SettingsSection>
      ) : (
        <>
          <SettingsSection
            id="teams-workspace"
            title={teamState.team.name}
            icon={<UsersIcon className="size-4" />}
          >
            <SettingsRow
              title={gt("Team workspace")}
              description={gt("Connected to {server}. {count} members.", {
                server: serverBaseUrl || selectedEnvironment.label,
                count: teamState.members.length,
              })}
              control={
                currentMember ? (
                  <Badge variant="secondary">{formatTeamRoleLabel(currentMember.role, gt)}</Badge>
                ) : null
              }
            />

            <SettingsRow
              id="teams-display-name"
              title={gt("Team display name")}
              description={gt(
                "Shown as the prefix on team-owned scheduled-task threads (for example, {displayName}: Daily triage).",
                { displayName: teamState.team.displayName },
              )}
              control={
                currentMember && canManageTeamDisplayName(currentMember.role) ? undefined : (
                  <Badge variant="outline" data-testid="team-display-name-value">
                    {teamState.team.displayName}
                  </Badge>
                )
              }
            >
              {currentMember && canManageTeamDisplayName(currentMember.role) ? (
                <form
                  className="mt-2 flex items-center gap-2 pb-3"
                  onSubmit={(event) => void handleSaveDisplayName(event)}
                >
                  <div className="max-w-xs flex-1">
                    <Input
                      data-testid="team-display-name-input"
                      value={activeDisplayNameValue}
                      onChange={(event) => setDisplayNameDraft(event.currentTarget.value)}
                      disabled={savingDisplayName || !canUpdateDisplayName}
                    />
                  </div>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      savingDisplayName ||
                      !canUpdateDisplayName ||
                      activeDisplayNameValue.trim().length === 0 ||
                      activeDisplayNameValue.trim() === teamState.team.displayName
                    }
                    data-testid="team-display-name-save"
                  >
                    {savingDisplayName ? <Spinner /> : null}
                    <T>Save</T>
                  </Button>
                </form>
              ) : null}
            </SettingsRow>

            {currentMember ? (
              <SettingsRow
                id="teams-pseudo"
                title={gt("Your pseudo")}
                description={gt(
                  "Shown as a prefix on every thread you start on this team server (for example, {pseudo}: Fix login bug).",
                  { pseudo: currentMember.pseudo },
                )}
              >
                <form
                  className="mt-2 flex items-center gap-2 pb-3"
                  onSubmit={(event) => void handleSaveMyPseudo(event)}
                >
                  <div className="max-w-xs flex-1">
                    <Input
                      data-testid="team-my-pseudo-input"
                      value={activePseudoValue}
                      onChange={(event) => setMyPseudoDraft(event.currentTarget.value)}
                      disabled={savingPseudo || !canUpdatePseudo}
                    />
                  </div>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      savingPseudo ||
                      !canUpdatePseudo ||
                      normalizeTeamPseudo(activePseudoValue) === currentMember.pseudo
                    }
                    data-testid="team-my-pseudo-save"
                  >
                    {savingPseudo ? <Spinner /> : null}
                    <T>Save</T>
                  </Button>
                </form>
              </SettingsRow>
            ) : null}

            <SettingsRow
              id="teams-colleagues-filter"
              title={gt("Show colleagues' threads in sidebar")}
              description={gt(
                "By default, your sidebar shows only threads you started. Turn this on to see colleagues' threads alongside yours.",
              )}
              control={
                <Switch
                  checked={showColleagues}
                  onCheckedChange={(checked) => setShowColleaguesThreads(checked)}
                  data-testid="team-settings-colleagues-switch"
                />
              }
            />

            <TeamNotificationSoundRow team={teamState.team} />
          </SettingsSection>

          {selectedEnvironmentId !== null ? (
            <TeamMobileCompatSection
              environmentId={selectedEnvironmentId}
              serverBaseUrl={serverBaseUrl}
              currentMember={currentMember}
            />
          ) : null}

          {currentMember && canManageTeamInvites(currentMember.role) ? (
            <SettingsSection
              id="teams-invites"
              title={gt("Invites")}
              icon={<LinkIcon className="size-4" />}
            >
              <SettingsRow
                title={gt("Create invite link")}
                description={gt(
                  "Generate a deep link or web join link. You can grant roles up to your own role ({role}).",
                  { role: formatTeamRoleLabel(currentMember.role, gt) },
                )}
              >
                <form
                  className="mt-3 space-y-3 pb-3"
                  onSubmit={(event) => void handleCreateInvite(event)}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label
                        className="block text-xs font-medium text-foreground"
                        htmlFor="team-invite-role"
                      >
                        <T>Role</T>
                      </label>
                      <Select
                        value={effectiveInviteRole}
                        onValueChange={(value) => {
                          if (typeof value === "string") {
                            setInviteRole(value as TeamRole);
                          }
                        }}
                      >
                        <SelectTrigger
                          id="team-invite-role"
                          size="sm"
                          data-testid="team-invite-role-select"
                        >
                          <SelectValue>{formatTeamRoleLabel(effectiveInviteRole, gt)}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          {assignableRoles.map((role) => (
                            <SelectItem key={role} value={role}>
                              {formatTeamRoleLabel(role, gt)}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <label
                        className="block text-xs font-medium text-foreground"
                        htmlFor="team-invite-pseudo"
                      >
                        <T>Prefilled pseudo (optional)</T>
                      </label>
                      <Input
                        id="team-invite-pseudo"
                        data-testid="team-invite-pseudo-input"
                        value={invitePseudo}
                        onChange={(event) => setInvitePseudo(event.currentTarget.value)}
                        placeholder={gt("e.g. bob")}
                        disabled={creatingInvite || !canCreateInviteScope}
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      size="sm"
                      disabled={creatingInvite || !canCreateInviteScope}
                      data-testid="team-invite-create"
                    >
                      {creatingInvite ? (
                        <>
                          <Spinner />
                          <T>Generating…</T>
                        </>
                      ) : (
                        <T>Generate invite link</T>
                      )}
                    </Button>
                  </div>

                  {latestDeepLink || latestWebLink ? (
                    <div
                      className="space-y-3 rounded-lg border border-border/70 bg-muted/25 p-3"
                      data-testid="team-invite-generated"
                    >
                      {latestDeepLink ? (
                        <CopyableLinkRow
                          label={gt("Desktop deep link")}
                          value={latestDeepLink}
                          testId="team-invite-deeplink"
                        />
                      ) : null}
                      {latestWebLink ? (
                        <CopyableLinkRow
                          label={gt("Web join link")}
                          value={latestWebLink}
                          testId="team-invite-weblink"
                        />
                      ) : null}
                    </div>
                  ) : null}
                </form>
              </SettingsRow>

              {teamState.invites.length > 0 ? (
                <SettingsRow
                  title={gt("Recent invites")}
                  description={gt("Active and used invite links on this team server.")}
                >
                  <div className="mt-2 space-y-2 pb-3">
                    {teamState.invites.map((invite) => {
                      const isRevoked = invite.revokedAt !== null;
                      const isExhausted = invite.uses >= invite.maxUses;
                      const expiresMs = Date.parse(invite.expiresAt);
                      const isExpired = !Number.isNaN(expiresMs) && expiresMs <= nowMs;
                      const canRevokeThisInvite =
                        canRevokeInviteScope && canAssignTeamRole(currentMember.role, invite.role);
                      return (
                        <div
                          key={invite.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs"
                        >
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <Badge variant="secondary" size="sm">
                              {formatTeamRoleLabel(invite.role, gt)}
                            </Badge>
                            {invite.prefilledPseudo ? (
                              <span className="font-medium text-foreground">
                                {invite.prefilledPseudo}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                <T>Any pseudo</T>
                              </span>
                            )}
                            <span className="text-muted-foreground">
                              <T>
                                <Var>{invite.uses}</Var>/<Var>{invite.maxUses}</Var> used
                              </T>
                            </span>
                            {isRevoked ? (
                              <Badge variant="error" size="sm">
                                <T>Revoked</T>
                              </Badge>
                            ) : isExhausted ? (
                              <Badge variant="outline" size="sm">
                                <T>Redeemed</T>
                              </Badge>
                            ) : isExpired ? (
                              <Badge variant="outline" size="sm">
                                <T>Expired</T>
                              </Badge>
                            ) : (
                              <Badge variant="success" size="sm">
                                <T>Active</T>
                              </Badge>
                            )}
                          </div>
                          {!isRevoked && !isExhausted && !isExpired && canRevokeThisInvite ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={revokingInviteId === invite.id}
                              onClick={() => void handleRevokeInvite(invite.id)}
                            >
                              <Trash2Icon />
                              <T>Revoke</T>
                            </Button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </SettingsRow>
              ) : null}
            </SettingsSection>
          ) : null}

          {selectedEnvironmentId !== null ? (
            <>
              <TeamGitHubSettingsSection
                key={selectedEnvironmentId}
                environmentId={selectedEnvironmentId}
                currentMember={currentMember}
                memberById={teamState.memberById}
                myGitHubIdentity={teamState.myGitHubIdentity}
                automationGitHubIdentity={teamState.automationGitHubIdentity}
              />
              <TeamProvidersSettingsSection
                environmentId={selectedEnvironmentId}
                currentMember={currentMember}
                memberById={teamState.memberById}
                providers={teamState.providers}
              />
              <TeamSkillsAndPrepromptsSettingsSection
                environmentId={selectedEnvironmentId}
                currentMember={currentMember}
                memberById={teamState.memberById}
                skills={teamState.skills}
                preprompts={teamState.preprompts}
                assetsRevision={teamState.assetsRevision}
              />
              <TeamEnvironmentsSettingsSection
                environmentId={selectedEnvironmentId}
                currentMember={currentMember}
                members={teamState.members}
                memberById={teamState.memberById}
                environments={teamState.environments}
              />
              <TeamViewsSettingsSection
                environmentId={selectedEnvironmentId}
                currentMember={currentMember}
                members={teamState.members}
                memberById={teamState.memberById}
                views={teamState.views}
              />
              <TeamMembersSettingsSection
                environmentId={selectedEnvironmentId}
                currentMember={currentMember}
                members={teamState.members}
              />
            </>
          ) : null}
        </>
      )}

      <SettingsSection
        id="teams-join"
        title={gt("Join a team")}
        icon={<LinkIcon className="size-4" />}
      >
        <SettingsRow
          title={gt("Paste invite link")}
          description={gt(
            "Enter a team deep link (t3code://team/join?...) or web join link shared by a teammate.",
          )}
        >
          <form className="mt-2 space-y-2 pb-3" onSubmit={handleOpenJoinLink}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  data-testid="team-paste-invite-input"
                  value={joinLinkInput}
                  onChange={(event) => {
                    setJoinLinkInput(event.currentTarget.value);
                    if (joinLinkError) setJoinLinkError(null);
                  }}
                  placeholder="t3code://team/join?server=..."
                />
              </div>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                data-testid="team-paste-invite-submit"
              >
                <T>Continue</T>
              </Button>
            </div>
            {joinLinkError ? (
              <p className="text-xs text-destructive" role="alert">
                {joinLinkError}
              </p>
            ) : null}
          </form>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
