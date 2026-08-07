import { BotIcon, GitBranchIcon, ShieldCheckIcon } from "lucide-react";
import { ProjectId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function SecretInput({
  label,
  stored,
  value,
  onChange,
}: {
  readonly label: string;
  readonly stored: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Input
      type="password"
      autoComplete="off"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder={stored ? "Stored securely — type to replace" : label}
      aria-label={label}
    />
  );
}

export function ChannelSettings() {
  const settings = usePrimarySettings((value) => value.channelIntegrations.discord);
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      primaryEnvironment
        ? allProjects.filter(
            (project) => project.environmentId === primaryEnvironment.environmentId,
          )
        : [],
    [allProjects, primaryEnvironment],
  );
  const [enabled, setEnabled] = useState(settings.enabled);
  const [projectId, setProjectId] = useState<ProjectId | null>(settings.projectId);
  const [threadEnvMode, setThreadEnvMode] = useState(settings.threadEnvMode);
  const [baseBranch, setBaseBranch] = useState(settings.baseBranch);
  const [branchPrefix, setBranchPrefix] = useState(settings.branchPrefix);
  const [applicationId, setApplicationId] = useState(settings.applicationId);
  const [guildId, setGuildId] = useState(settings.guildId);
  const [botToken, setBotToken] = useState("");
  const [botTokenChanged, setBotTokenChanged] = useState(false);

  useEffect(() => {
    setEnabled(settings.enabled);
    setProjectId(settings.projectId);
    setThreadEnvMode(settings.threadEnvMode);
    setBaseBranch(settings.baseBranch);
    setBranchPrefix(settings.branchPrefix);
    setApplicationId(settings.applicationId);
    setGuildId(settings.guildId);
  }, [settings]);

  const hasBotToken = botTokenChanged ? botToken.length > 0 : settings.botTokenRedacted;
  const setupComplete =
    projectId !== null &&
    (threadEnvMode === "local" ||
      (baseBranch.trim().length > 0 && branchPrefix.trim().length > 0)) &&
    applicationId.trim().length > 0 &&
    hasBotToken;
  const selectedProject = projects.find((project) => project.id === projectId) ?? null;

  const save = () => {
    updateSettings({
      channelIntegrations: {
        discord: {
          enabled,
          projectId,
          threadEnvMode,
          baseBranch,
          branchPrefix,
          applicationId,
          guildId,
          botToken: botTokenChanged ? botToken : "",
          botTokenRedacted: botTokenChanged ? false : settings.botTokenRedacted,
        },
      },
    });
    setBotToken("");
    setBotTokenChanged(false);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("discord-channel")}
        title="Discord channel"
        icon={<BotIcon className="size-4" />}
        headerAction={
          <Badge variant={enabled && setupComplete ? "success" : "secondary"} size="sm">
            {enabled && setupComplete ? "Configured" : enabled ? "Setup incomplete" : "Off"}
          </Badge>
        }
      >
        <SettingsRow
          title="Connect Discord"
          description="Send a coding request to T3 Code from a Discord mention or the /t3 command. Progress and completion return to the same thread."
          control={
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(Boolean(checked))}
              aria-label="Enable Discord channel"
            />
          }
        />
        <SettingsRow
          title="Project"
          description="Every Discord request starts a new T3 Code thread for this project."
          control={
            <Select
              value={projectId}
              onValueChange={(value) => setProjectId(value ? ProjectId.make(value) : null)}
            >
              <SelectTrigger className="w-full sm:w-72" aria-label="Discord channel project">
                <SelectValue>
                  {selectedProject?.title ??
                    (projects.length > 0 ? "Choose a project" : "No projects")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {projects.map((project) => (
                  <SelectItem key={project.id} hideIndicator value={project.id}>
                    <span className="block max-w-64 truncate">{project.title}</span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Discord application"
          description="Create a Discord bot, enable Message Content and Server Members intents, then copy its credentials here."
        >
          <div className="grid gap-3 py-3 sm:grid-cols-2">
            <Input
              value={applicationId}
              onChange={(event) => setApplicationId(event.currentTarget.value)}
              placeholder="Application ID"
              aria-label="Discord application ID"
            />
            <Input
              value={guildId}
              onChange={(event) => setGuildId(event.currentTarget.value)}
              placeholder="Server ID (optional)"
              aria-label="Discord server ID"
            />
            <SecretInput
              label="Discord bot token"
              stored={settings.botTokenRedacted}
              value={botToken}
              onChange={(value) => {
                setBotToken(value);
                setBotTokenChanged(true);
              }}
            />
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Run location" icon={<ShieldCheckIcon className="size-4" />}>
        <SettingsRow
          title="Where tasks run"
          description="Choose whether Discord tasks use a dedicated worktree or the project's current checkout."
          control={
            <Select
              value={threadEnvMode}
              onValueChange={(value) => setThreadEnvMode(value === "local" ? "local" : "worktree")}
            >
              <SelectTrigger className="w-full sm:w-72" aria-label="Discord task run location">
                <SelectValue>
                  {threadEnvMode === "worktree" ? "Isolated worktree" : "Project checkout"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="worktree">
                  Isolated worktree
                </SelectItem>
                <SelectItem hideIndicator value="local">
                  Project checkout
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title={threadEnvMode === "worktree" ? "Base branch protected" : "Direct project access"}
          description={
            threadEnvMode === "worktree"
              ? "If T3 Code cannot create a dedicated worktree and branch, the agent never starts."
              : "The agent runs in the existing project checkout and can modify its currently checked-out branch, including main."
          }
          status={
            <span
              className={
                threadEnvMode === "worktree"
                  ? "inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400"
                  : "inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400"
              }
            >
              <ShieldCheckIcon className="size-3.5" />
              {threadEnvMode === "worktree" ? "Isolated" : "Not isolated"}
            </span>
          }
        />
        {threadEnvMode === "worktree" ? (
          <SettingsRow
            title="Branch naming"
            description="Each request receives a unique branch under this prefix, created from the selected base branch."
          >
            <div className="grid gap-3 py-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <GitBranchIcon className="size-3.5 text-muted-foreground" /> Base branch
                </label>
                <Input
                  value={baseBranch}
                  onChange={(event) => setBaseBranch(event.currentTarget.value)}
                  placeholder="main"
                  aria-label="Channel base branch"
                />
              </div>
              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <GitBranchIcon className="size-3.5 text-muted-foreground" /> Branch prefix
                </label>
                <Input
                  value={branchPrefix}
                  onChange={(event) => setBranchPrefix(event.currentTarget.value)}
                  placeholder="demo/discord"
                  aria-label="Channel branch prefix"
                />
              </div>
            </div>
          </SettingsRow>
        ) : null}
        <div className="flex justify-end px-3 pt-3 sm:px-4">
          <Button onClick={save} disabled={enabled && !setupComplete}>
            Save channel configuration
          </Button>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
