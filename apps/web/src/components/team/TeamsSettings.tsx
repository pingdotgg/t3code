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
  canManageTeamInvites,
  normalizeTeamPseudo,
  parseTeamJoinLink,
  PositiveInt,
  type EnvironmentId,
  type TeamInviteCreatedResult,
  type TeamRole,
} from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { msg, T, useGT, Var } from "gt-react";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  CheckIcon,
  CloudIcon,
  CopyIcon,
  KeyRoundIcon,
  LinkIcon,
  LogOutIcon,
  PlusIcon,
  ShieldIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { isElectron } from "~/env";
import { configuredHostedAppUrl } from "~/hostedPairing";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useNowMinute } from "~/hooks/useNowMinute";
import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { environmentCatalog } from "~/connection/catalog";
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
import { formatExpiresInLabel } from "~/timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { confirmTeamDestructiveAction } from "./confirmTeamDestructiveAction";
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

type TeamsSettingsTab = "overview" | "access" | "providers" | "skills";

const TARGET_ID_TO_TAB: Readonly<Record<string, TeamsSettingsTab>> = {
  "teams-workspace": "overview",
  "teams-pseudo": "overview",
  "teams-colleagues-filter": "overview",
  "teams-notification-sound": "overview",
  "teams-mobile-compat": "overview",
  "teams-mobile-visibility": "overview",
  "teams-connect-mobile": "overview",
  "teams-members": "overview",
  "teams-invites": "overview",
  "teams-danger-zone": "overview",
  "teams-views": "access",
  "teams-environments": "access",
  "teams-providers": "providers",
  "teams-github": "providers",
  "teams-github-oauth-app": "providers",
  "teams-github-automation": "providers",
  "teams-skills": "skills",
  "teams-preprompts": "skills",
};

const INVITE_EXPIRY_HOUR_OPTIONS: ReadonlyArray<number> = [1, 24, 168, 720, 2160];

function formatInviteExpiryOptionLabel(hours: number, gt: ReturnType<typeof useGT>): string {
  switch (hours) {
    case 1:
      return gt("1 hour");
    case 24:
      return gt("24 hours");
    case 168:
      return gt("7 days (default)");
    case 720:
      return gt("30 days");
    case 2160:
      return gt("90 days");
    default:
      return gt("{hours} hours", { hours });
  }
}

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
  const locationHash = useLocation({ select: (location) => location.hash });
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const teamStates = useTeamStatesByEnvironment();
  const showColleagues = useShowColleaguesThreads();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);

  const hashTargetId = locationHash.replace(/^#/, "");
  const hashTab = hashTargetId ? (TARGET_ID_TO_TAB[hashTargetId] ?? null) : null;
  const [activeTab, setActiveTab] = useState<TeamsSettingsTab>(() => hashTab ?? "overview");
  const [lastSyncedHash, setLastSyncedHash] = useState(locationHash);
  if (locationHash !== lastSyncedHash) {
    setLastSyncedHash(locationHash);
    if (hashTab !== null && hashTab !== activeTab) {
      setActiveTab(hashTab);
    }
  }

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
  const canUpdatePseudo = useAtomValue(
    teamEnvironment.updateMyPseudo.permissionAtom(selectedEnvironmentId),
  );
  const canCreateInviteScope = useAtomValue(
    teamEnvironment.createInvite.permissionAtom(selectedEnvironmentId),
  );
  const canRevokeInviteScope = useAtomValue(
    teamEnvironment.revokeInvite.permissionAtom(selectedEnvironmentId),
  );
  const canLeaveScope = useAtomValue(teamEnvironment.leave.permissionAtom(selectedEnvironmentId));
  const canDeleteScope = useAtomValue(
    teamEnvironment.deleteTeam.permissionAtom(selectedEnvironmentId),
  );

  const runInitialize = useAtomCommand(teamEnvironment.initialize, { reportFailure: false });
  const runUpdateMyPseudo = useAtomCommand(teamEnvironment.updateMyPseudo, {
    reportFailure: false,
  });
  const runCreateInvite = useAtomCommand(teamEnvironment.createInvite, { reportFailure: false });
  const runRevokeInvite = useAtomCommand(teamEnvironment.revokeInvite, { reportFailure: false });
  const runLeaveTeam = useAtomCommand(teamEnvironment.leave, { reportFailure: false });
  const runDeleteTeam = useAtomCommand(teamEnvironment.deleteTeam, { reportFailure: false });
  const runRemoveLocalBinding = useAtomCommand(teamEnvironment.removeLocalBinding, {
    reportFailure: false,
  });
  const runRemoveEnvironment = useAtomCommand(environmentCatalog.remove, {
    reportFailure: false,
  });

  const [teamNameInput, setTeamNameInput] = useState("");
  const [ownerPseudoInput, setOwnerPseudoInput] = useState("");
  const [initializing, setInitializing] = useState(false);

  const [myPseudoDraft, setMyPseudoDraft] = useState<string | null>(null);
  const [savingPseudo, setSavingPseudo] = useState(false);

  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteRole, setInviteRole] = useState<TeamRole>("regular");
  const [invitePseudo, setInvitePseudo] = useState("");
  const [inviteMaxUsesInput, setInviteMaxUsesInput] = useState("1");
  const [inviteExpiryHours, setInviteExpiryHours] = useState(168);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [latestInvite, setLatestInvite] = useState<GeneratedInviteBanner | null>(null);
  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);

  const [joinLinkInput, setJoinLinkInput] = useState("");
  const [joinLinkError, setJoinLinkError] = useState<string | null>(null);

  const [leavingTeam, setLeavingTeam] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmNameInput, setDeleteConfirmNameInput] = useState("");
  const [deletingTeam, setDeletingTeam] = useState(false);

  const currentMember = teamState.currentMember;
  const activeOwnerCount = teamState.members.filter(
    (member) => member.status === "active" && member.role === "owner",
  ).length;
  const isLastActiveOwner =
    currentMember !== null &&
    currentMember.status === "active" &&
    currentMember.role === "owner" &&
    activeOwnerCount <= 1;

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
        ownerPseudo: normalizedPseudo,
      },
    });
    setInitializing(false);
    if (result._tag === "Success") {
      setTeamNameInput("");
      setOwnerPseudoInput("");
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
    const parsedMaxUses = Number.parseInt(inviteMaxUsesInput, 10);
    if (!Number.isInteger(parsedMaxUses) || parsedMaxUses < 1 || parsedMaxUses > 1_000) {
      reportError(
        gt("Could not create invite"),
        new Error(gt("Enter a valid max uses count between 1 and 1000.")),
      );
      return;
    }
    setCreatingInvite(true);
    const result = await runCreateInvite({
      environmentId: targetEnvironmentId,
      input: {
        role: effectiveInviteRole,
        ...(trimmedPseudo.length > 0
          ? { prefilledPseudo: normalizeTeamPseudo(trimmedPseudo) }
          : {}),
        maxUses: PositiveInt.make(parsedMaxUses),
        expiresInHours: PositiveInt.make(inviteExpiryHours),
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
      setInviteMaxUsesInput("1");
      setInviteExpiryHours(168);
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
    const confirmed = await confirmTeamDestructiveAction(
      [gt("Revoke this invite link?"), gt("Anyone who tries to redeem it will be rejected.")].join(
        "\n",
      ),
    );
    if (!confirmed) return;

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

  const cleanupLocalTeamState = async (
    teamId: NonNullable<typeof teamState.team>["id"],
    targetEnvironmentId: EnvironmentId,
    removeRemoteConnection: boolean,
  ) => {
    if (primaryEnvironmentId !== null) {
      await runRemoveLocalBinding({
        environmentId: primaryEnvironmentId,
        input: { teamId },
      });
    }
    if (removeRemoteConnection && targetEnvironmentId !== primaryEnvironmentId) {
      await runRemoveEnvironment(targetEnvironmentId);
      setSelectedEnvironmentIdOverride(null);
    }
  };

  const handleLeaveTeam = async () => {
    if (selectedEnvironmentId === null || teamState.team === null) return;
    const team = teamState.team;
    const confirmed = await confirmTeamDestructiveAction(
      [
        gt('Leave "{teamName}"?', { teamName: team.name }),
        gt(
          "Your team sessions, mobile pairing links, and synced team credentials on this machine will be revoked. You will need a new invite to rejoin.",
        ),
      ].join("\n"),
    );
    if (!confirmed) return;

    const targetEnvironmentId = selectedEnvironmentId;
    setLeavingTeam(true);
    const result = await runLeaveTeam({
      environmentId: targetEnvironmentId,
      input: {},
    });
    setLeavingTeam(false);
    if (result._tag === "Success") {
      await cleanupLocalTeamState(team.id, targetEnvironmentId, true);
      toastManager.add({
        type: "success",
        title: gt("Left team"),
        description: gt("You have left {teamName}.", { teamName: team.name }),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not leave team"), squashAtomCommandFailure(result));
    }
  };

  const handleConfirmDeleteTeam = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedEnvironmentId === null || teamState.team === null) return;
    const team = teamState.team;
    if (deleteConfirmNameInput.trim() !== team.name) return;

    const targetEnvironmentId = selectedEnvironmentId;
    setDeletingTeam(true);
    const result = await runDeleteTeam({
      environmentId: targetEnvironmentId,
      input: { confirmTeamName: deleteConfirmNameInput.trim() },
    });
    setDeletingTeam(false);
    if (result._tag === "Success") {
      setDeleteDialogOpen(false);
      setDeleteConfirmNameInput("");
      setLatestInvite(null);
      await cleanupLocalTeamState(team.id, targetEnvironmentId, false);
      toastManager.add({
        type: "success",
        title: gt("Team deleted"),
        description: gt("{teamName} and its team configuration have been removed.", {
          teamName: team.name,
        }),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportError(gt("Could not delete team"), squashAtomCommandFailure(result));
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

  const tabs: ReadonlyArray<{
    readonly id: TeamsSettingsTab;
    readonly label: string;
    readonly icon: typeof UsersIcon;
  }> = [
    { id: "overview", label: gt("Overview & Members"), icon: UsersIcon },
    { id: "access", label: gt("Access & Environments"), icon: ShieldIcon },
    { id: "providers", label: gt("Providers & GitHub"), icon: CloudIcon },
    { id: "skills", label: gt("Skills & Pre-prompts"), icon: BookOpenIcon },
  ];

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
                    setMyPseudoDraft(null);
                    setShowInviteForm(false);
                    setInviteRole("regular");
                    setInvitePseudo("");
                    setInviteMaxUsesInput("1");
                    setInviteExpiryHours(168);
                    setJoinLinkInput("");
                    setJoinLinkError(null);
                    setDeleteDialogOpen(false);
                    setDeleteConfirmNameInput("");
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
          <div
            role="tablist"
            aria-label={gt("Team settings sections")}
            className="flex flex-wrap gap-1 rounded-xl border border-border/70 bg-muted/25 p-1"
            data-testid="teams-settings-tabs"
          >
            {tabs.map((tab, index) => {
              const Icon = tab.icon;
              const isSelected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`teams-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  tabIndex={isSelected ? 0 : -1}
                  aria-selected={isSelected}
                  aria-controls={isSelected ? `teams-tabpanel-${tab.id}` : undefined}
                  data-testid={`teams-tab-${tab.id}`}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(event) => {
                    let nextIndex: number | null = null;
                    if (event.key === "ArrowRight") {
                      nextIndex = (index + 1) % tabs.length;
                    } else if (event.key === "ArrowLeft") {
                      nextIndex = (index - 1 + tabs.length) % tabs.length;
                    } else if (event.key === "Home") {
                      nextIndex = 0;
                    } else if (event.key === "End") {
                      nextIndex = tabs.length - 1;
                    }
                    if (nextIndex === null) return;
                    event.preventDefault();
                    const nextTab = tabs[nextIndex];
                    if (!nextTab) return;
                    setActiveTab(nextTab.id);
                    const tabButtons =
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]',
                      );
                    tabButtons?.[nextIndex]?.focus();
                  }}
                  className={cn(
                    "inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
                    isSelected
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {activeTab === "overview" ? (
            <div
              role="tabpanel"
              id="teams-tabpanel-overview"
              aria-labelledby="teams-tab-overview"
              className="space-y-6"
            >
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
                      <Badge variant="secondary">
                        {formatTeamRoleLabel(currentMember.role, gt)}
                      </Badge>
                    ) : null
                  }
                />

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
                          aria-label={gt("Your pseudo")}
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
                <TeamMembersSettingsSection
                  key={`members:${selectedEnvironmentId}`}
                  environmentId={selectedEnvironmentId}
                  currentMember={currentMember}
                  members={teamState.members}
                />
              ) : null}

              {currentMember && canManageTeamInvites(currentMember.role) ? (
                <SettingsSection
                  id="teams-invites"
                  title={gt("Invites")}
                  icon={<LinkIcon className="size-4" />}
                  headerAction={
                    !showInviteForm ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        data-testid="team-invite-open-form"
                        onClick={() => setShowInviteForm(true)}
                      >
                        <PlusIcon />
                        <T>Create invite</T>
                      </Button>
                    ) : undefined
                  }
                >
                  {showInviteForm || activeLatestInvite ? (
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
                                <SelectValue>
                                  {formatTeamRoleLabel(effectiveInviteRole, gt)}
                                </SelectValue>
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

                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <label
                              className="block text-xs font-medium text-foreground"
                              htmlFor="team-invite-max-uses"
                            >
                              <T>Max uses</T>
                            </label>
                            <Input
                              id="team-invite-max-uses"
                              data-testid="team-invite-max-uses-input"
                              type="number"
                              min={1}
                              max={1000}
                              value={inviteMaxUsesInput}
                              onChange={(event) => setInviteMaxUsesInput(event.currentTarget.value)}
                              disabled={creatingInvite || !canCreateInviteScope}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label
                              className="block text-xs font-medium text-foreground"
                              htmlFor="team-invite-expiry"
                            >
                              <T>Expires after</T>
                            </label>
                            <Select
                              value={String(inviteExpiryHours)}
                              onValueChange={(value) => {
                                const parsed = Number.parseInt(String(value), 10);
                                if (Number.isInteger(parsed) && parsed > 0) {
                                  setInviteExpiryHours(parsed);
                                }
                              }}
                            >
                              <SelectTrigger
                                id="team-invite-expiry"
                                size="sm"
                                data-testid="team-invite-expiry-select"
                              >
                                <SelectValue>
                                  {formatInviteExpiryOptionLabel(inviteExpiryHours, gt)}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectPopup>
                                {INVITE_EXPIRY_HOUR_OPTIONS.map((hours) => (
                                  <SelectItem key={hours} value={String(hours)}>
                                    {formatInviteExpiryOptionLabel(hours, gt)}
                                  </SelectItem>
                                ))}
                              </SelectPopup>
                            </Select>
                          </div>
                        </div>

                        <div className="flex items-center justify-end gap-2">
                          {showInviteForm ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setShowInviteForm(false)}
                            >
                              <T>Hide</T>
                            </Button>
                          ) : null}
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
                  ) : null}

                  <SettingsRow
                    title={gt("Recent invites")}
                    description={gt("Active and used invite links on this team server.")}
                  >
                    <div className="mt-2 space-y-2 pb-3" data-testid="team-invites-list">
                      {teamState.invites.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          <T>No invite links created yet.</T>
                        </p>
                      ) : (
                        teamState.invites.map((invite) => {
                          const isRevoked = invite.revokedAt !== null;
                          const isExhausted = invite.uses >= invite.maxUses;
                          const remainingUses = Math.max(0, invite.maxUses - invite.uses);
                          const expiresMs = Date.parse(invite.expiresAt);
                          const isExpired = !Number.isNaN(expiresMs) && expiresMs <= nowMs;
                          const canRevokeThisInvite =
                            canRevokeInviteScope &&
                            canAssignTeamRole(currentMember.role, invite.role);
                          return (
                            <div
                              key={invite.id}
                              data-testid={`team-invite-row-${invite.id}`}
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
                                  {gt("{remaining} left ({uses}/{maxUses} used)", {
                                    remaining: remainingUses,
                                    uses: invite.uses,
                                    maxUses: invite.maxUses,
                                  })}
                                </span>
                                {!isRevoked && !isExhausted && !isExpired ? (
                                  <span className="text-muted-foreground">
                                    {`· ${formatExpiresInLabel(invite.expiresAt, nowMs, m)}`}
                                  </span>
                                ) : null}
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
                        })
                      )}
                    </div>
                  </SettingsRow>
                </SettingsSection>
              ) : null}

              {selectedEnvironmentId !== null ? (
                <TeamMobileCompatSection
                  key={`mobile:${selectedEnvironmentId}`}
                  environmentId={selectedEnvironmentId}
                  serverBaseUrl={serverBaseUrl}
                  currentMember={currentMember}
                />
              ) : null}

              {currentMember && currentMember.status === "active" ? (
                <SettingsSection
                  id="teams-danger-zone"
                  title={gt("Danger zone")}
                  icon={<AlertTriangleIcon className="size-4" />}
                >
                  <SettingsRow
                    title={gt("Leave team")}
                    description={
                      isLastActiveOwner
                        ? gt(
                            "You are the last active owner. Promote another member to Owner before leaving, or delete the team below.",
                          )
                        : gt(
                            "Leave {teamName}, revoking your sessions, mobile pairing links, and synced credentials for this team.",
                            { teamName: teamState.team.name },
                          )
                    }
                    control={
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive-outline"
                        disabled={leavingTeam || isLastActiveOwner || !canLeaveScope}
                        data-testid="team-leave-button"
                        onClick={() => void handleLeaveTeam()}
                      >
                        {leavingTeam ? <Spinner /> : <LogOutIcon />}
                        <T>Leave team</T>
                      </Button>
                    }
                  />

                  {currentMember.role === "owner" ? (
                    <SettingsRow
                      title={gt("Delete team")}
                      description={gt(
                        "Permanently delete {teamName}, revoke all teammates' sessions and invites, and return this server to personal mode.",
                        { teamName: teamState.team.name },
                      )}
                      control={
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={deletingTeam || !canDeleteScope}
                          data-testid="team-delete-open-button"
                          onClick={() => {
                            setDeleteConfirmNameInput("");
                            setDeleteDialogOpen(true);
                          }}
                        >
                          <Trash2Icon />
                          <T>Delete team</T>
                        </Button>
                      }
                    />
                  ) : null}
                </SettingsSection>
              ) : null}
            </div>
          ) : null}

          {activeTab === "access" && selectedEnvironmentId !== null ? (
            <div
              role="tabpanel"
              id="teams-tabpanel-access"
              aria-labelledby="teams-tab-access"
              className="space-y-6"
            >
              <TeamViewsSettingsSection
                key={`views:${selectedEnvironmentId}`}
                environmentId={selectedEnvironmentId}
                currentMember={currentMember}
                members={teamState.members}
                memberById={teamState.memberById}
                views={teamState.views}
              />
              <TeamEnvironmentsSettingsSection
                key={`envs:${selectedEnvironmentId}`}
                environmentId={selectedEnvironmentId}
                currentMember={currentMember}
                members={teamState.members}
                memberById={teamState.memberById}
                environments={teamState.environments}
              />
            </div>
          ) : null}

          {activeTab === "providers" && selectedEnvironmentId !== null ? (
            <div
              role="tabpanel"
              id="teams-tabpanel-providers"
              aria-labelledby="teams-tab-providers"
              className="space-y-6"
            >
              <TeamProvidersSettingsSection
                key={`providers:${selectedEnvironmentId}`}
                environmentId={selectedEnvironmentId}
                currentMember={currentMember}
                memberById={teamState.memberById}
                providers={teamState.providers}
              />
              <TeamGitHubSettingsSection
                key={`github:${selectedEnvironmentId}`}
                environmentId={selectedEnvironmentId}
                serverBaseUrl={serverBaseUrl}
                currentMember={currentMember}
                memberById={teamState.memberById}
                myGitHubIdentity={teamState.myGitHubIdentity}
                automationGitHubIdentity={teamState.automationGitHubIdentity}
                githubAppConfig={teamState.githubAppConfig}
              />
            </div>
          ) : null}

          {activeTab === "skills" && selectedEnvironmentId !== null ? (
            <div
              role="tabpanel"
              id="teams-tabpanel-skills"
              aria-labelledby="teams-tab-skills"
              className="space-y-6"
            >
              <TeamSkillsAndPrepromptsSettingsSection
                key={`skills:${selectedEnvironmentId}`}
                environmentId={selectedEnvironmentId}
                currentMember={currentMember}
                memberById={teamState.memberById}
                skills={teamState.skills}
                preprompts={teamState.preprompts}
                assetsRevision={teamState.assetsRevision}
              />
            </div>
          ) : null}
        </>
      )}

      <SettingsSection
        id="teams-join"
        title={gt("Join a team")}
        icon={<LinkIcon className="size-4" />}
        headerAction={
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="team-join-manual-open"
            onClick={() =>
              openTeamJoinDialog({
                serverUrl: "",
                token: "",
                prefilledPseudo: null,
              })
            }
          >
            <KeyRoundIcon />
            <T>Join manually with server URL &amp; token</T>
          </Button>
        }
      >
        <SettingsRow
          title={gt("Paste invite link")}
          description={gt(
            "Enter a team deep link (t3code://team/join?...) or web join link shared by a teammate, or join manually with a server URL and invite token.",
          )}
        >
          <form className="mt-2 space-y-2 pb-3" onSubmit={handleOpenJoinLink}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Input
                  data-testid="team-paste-invite-input"
                  aria-label={gt("Team invite link")}
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

      {teamState.team !== null ? (
        <Dialog
          open={deleteDialogOpen}
          onOpenChange={(open) => {
            if (!deletingTeam) setDeleteDialogOpen(open);
          }}
        >
          <DialogPopup className="max-w-md" data-testid="team-delete-confirm-dialog">
            <form className="contents" onSubmit={(event) => void handleConfirmDeleteTeam(event)}>
              <DialogHeader>
                <DialogTitle>
                  <T>
                    Delete team <Var>{teamState.team.name}</Var>
                  </T>
                </DialogTitle>
                <DialogDescription>
                  <T>
                    This permanently removes the team, revokes all members&apos; sessions and
                    invites, and deletes team providers, views, skills, and GitHub configurations.
                    Type the team name below to confirm.
                  </T>
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="space-y-1.5">
                  <label
                    className="block text-xs font-medium text-foreground"
                    htmlFor="team-delete-confirm-name"
                  >
                    <T>
                      Type <Var>{teamState.team.name}</Var> to confirm
                    </T>
                  </label>
                  <Input
                    id="team-delete-confirm-name"
                    data-testid="team-delete-confirm-input"
                    value={deleteConfirmNameInput}
                    onChange={(event) => setDeleteConfirmNameInput(event.currentTarget.value)}
                    placeholder={teamState.team.name}
                    autoComplete="off"
                    disabled={deletingTeam}
                  />
                </div>
              </DialogPanel>
              <DialogFooter>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={deletingTeam}
                  onClick={() => setDeleteDialogOpen(false)}
                >
                  <T>Cancel</T>
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  variant="destructive"
                  disabled={deletingTeam || deleteConfirmNameInput.trim() !== teamState.team.name}
                  data-testid="team-delete-confirm-submit"
                >
                  {deletingTeam ? <Spinner /> : <Trash2Icon />}
                  <T>Delete team permanently</T>
                </Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
      ) : null}
    </SettingsPageContainer>
  );
}
