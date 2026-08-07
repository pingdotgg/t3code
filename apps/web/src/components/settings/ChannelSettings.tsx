import { useAtomValue } from "@effect/atom-react";
import { BotIcon, ExternalLinkIcon, GitBranchIcon, ShieldCheckIcon } from "lucide-react";
import { type ModelSelection, ProjectId, type ServerSettingsPatch } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePersistPrimaryServerSettings, usePrimarySettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { buildDiscordInstallUrl } from "./discordInstallUrl";

function SecretInput({
  label,
  stored,
  value,
  onChange,
  onBlur,
}: {
  readonly label: string;
  readonly stored: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onBlur: () => void;
}) {
  return (
    <Input
      type="password"
      autoComplete="off"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onBlur={onBlur}
      placeholder={stored ? "Stored securely — type to replace" : label}
      aria-label={label}
    />
  );
}

type DiscordChannelPatch = NonNullable<
  NonNullable<ServerSettingsPatch["channelIntegrations"]>["discord"]
>;

type SaveStatus = "idle" | "unsaved" | "saving" | "saved" | "error";
type DirtyField = "applicationId" | "guildId" | "botToken" | "baseBranch" | "branchPrefix";

export function ChannelSettings() {
  const allSettings = usePrimarySettings();
  const settings = allSettings.channelIntegrations.discord;
  const persistServerSettings = usePersistPrimaryServerSettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const allProjects = useProjects();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
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
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(
    settings.modelSelection,
  );
  const [threadEnvMode, setThreadEnvMode] = useState(settings.threadEnvMode);
  const [baseBranch, setBaseBranch] = useState(settings.baseBranch);
  const [branchPrefix, setBranchPrefix] = useState(settings.branchPrefix);
  const [applicationId, setApplicationId] = useState(settings.applicationId);
  const [guildId, setGuildId] = useState(settings.guildId);
  const [botToken, setBotToken] = useState("");
  const [botTokenChanged, setBotTokenChanged] = useState(false);
  const [botTokenStored, setBotTokenStored] = useState(settings.botTokenRedacted);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const dirtyFieldsRef = useRef(new Set<DirtyField>());

  useEffect(() => {
    setEnabled(settings.enabled);
    setProjectId(settings.projectId);
    setModelSelection(settings.modelSelection);
    setThreadEnvMode(settings.threadEnvMode);
    if (!dirtyFieldsRef.current.has("baseBranch")) setBaseBranch(settings.baseBranch);
    if (!dirtyFieldsRef.current.has("branchPrefix")) setBranchPrefix(settings.branchPrefix);
    if (!dirtyFieldsRef.current.has("applicationId")) setApplicationId(settings.applicationId);
    if (!dirtyFieldsRef.current.has("guildId")) setGuildId(settings.guildId);
    if (!dirtyFieldsRef.current.has("botToken")) {
      setBotTokenStored(settings.botTokenRedacted);
    }
  }, [settings]);

  const hasBotToken = botTokenChanged ? botToken.length > 0 : botTokenStored;
  const setupComplete =
    projectId !== null &&
    (threadEnvMode === "local" ||
      (baseBranch.trim().length > 0 && branchPrefix.trim().length > 0)) &&
    applicationId.trim().length > 0 &&
    hasBotToken;
  const selectedProject = projects.find((project) => project.id === projectId) ?? null;
  const fallbackModelSelection = useMemo(
    () => resolveAppModelSelectionState(allSettings, serverProviders),
    [allSettings, serverProviders],
  );
  const activeModelSelection = useMemo(
    () => modelSelection ?? selectedProject?.defaultModelSelection ?? fallbackModelSelection,
    [fallbackModelSelection, modelSelection, selectedProject?.defaultModelSelection],
  );
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), allSettings),
      ),
    [allSettings, serverProviders],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        allSettings,
        serverProviders,
        activeModelSelection.instanceId,
        activeModelSelection.model,
      ),
    [activeModelSelection.instanceId, activeModelSelection.model, allSettings, serverProviders],
  );
  const discordInstallUrl = buildDiscordInstallUrl(applicationId, guildId);

  const persistDiscordPatch = useCallback(
    async (discord: DiscordChannelPatch, persistedFields: ReadonlyArray<DirtyField> = []) => {
      setSaveStatus("saving");
      const saved = await persistServerSettings({ channelIntegrations: { discord } });
      if (saved) {
        for (const field of persistedFields) dirtyFieldsRef.current.delete(field);
      }
      setSaveStatus(saved ? "saved" : "error");
      return saved;
    },
    [persistServerSettings],
  );

  const save = useCallback(async () => {
    const saved = await persistDiscordPatch(
      {
        enabled,
        projectId,
        modelSelection,
        threadEnvMode,
        baseBranch,
        branchPrefix,
        applicationId,
        guildId,
        botToken: botTokenChanged ? botToken : "",
        botTokenRedacted: botTokenChanged ? false : botTokenStored,
      },
      ["applicationId", "guildId", "botToken", "baseBranch", "branchPrefix"],
    );
    if (saved && botTokenChanged) {
      setBotTokenChanged(false);
      setBotTokenStored(botToken.length > 0);
    }
  }, [
    applicationId,
    baseBranch,
    botToken,
    botTokenChanged,
    botTokenStored,
    branchPrefix,
    enabled,
    guildId,
    modelSelection,
    persistDiscordPatch,
    projectId,
    threadEnvMode,
  ]);

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
              onCheckedChange={(checked) => {
                const next = Boolean(checked);
                setEnabled(next);
                void persistDiscordPatch({ enabled: next });
              }}
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
              onValueChange={(value) => {
                const next = value ? ProjectId.make(value) : null;
                setProjectId(next);
                void persistDiscordPatch({ projectId: next });
              }}
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
          title="Default model"
          description="Every Discord task uses this model unless /model selects a conversation override."
          control={
            <ProviderModelPicker
              activeInstanceId={activeModelSelection.instanceId}
              model={activeModelSelection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              disabled={instanceEntries.length === 0}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              triggerAriaLabel="Discord default model"
              onInstanceModelChange={(instanceId, model) => {
                const next = createModelSelection(instanceId, model);
                setModelSelection(next);
                void persistDiscordPatch({ modelSelection: next });
              }}
            />
          }
        />
        <SettingsRow
          title="Discord application"
          description="Enter the app credentials, then add the bot to your server. Message Content and Server Members intents must be enabled."
        >
          <div className="grid gap-3 py-3 sm:grid-cols-2">
            <Input
              value={applicationId}
              onChange={(event) => {
                setApplicationId(event.currentTarget.value);
                dirtyFieldsRef.current.add("applicationId");
                setSaveStatus("unsaved");
              }}
              onBlur={() => void persistDiscordPatch({ applicationId }, ["applicationId"])}
              placeholder="Application ID"
              aria-label="Discord application ID"
            />
            <Input
              value={guildId}
              onChange={(event) => {
                setGuildId(event.currentTarget.value);
                dirtyFieldsRef.current.add("guildId");
                setSaveStatus("unsaved");
              }}
              onBlur={() => void persistDiscordPatch({ guildId }, ["guildId"])}
              placeholder="Server ID (optional)"
              aria-label="Discord server ID"
            />
            <SecretInput
              label="Discord bot token"
              stored={botTokenStored}
              value={botToken}
              onChange={(value) => {
                setBotToken(value);
                setBotTokenChanged(true);
                dirtyFieldsRef.current.add("botToken");
                setSaveStatus("unsaved");
              }}
              onBlur={() => {
                if (!botTokenChanged) return;
                void persistDiscordPatch({ botToken, botTokenRedacted: false }, ["botToken"]).then(
                  (saved) => {
                    if (!saved) return;
                    setBotTokenChanged(false);
                    setBotTokenStored(botToken.length > 0);
                  },
                );
              }}
            />
            <Button
              variant="outline"
              className="sm:col-span-2 sm:justify-self-start"
              disabled={discordInstallUrl === null}
              onClick={() => {
                if (!discordInstallUrl) return;
                void ensureLocalApi()
                  .shell.openExternal(discordInstallUrl)
                  .catch(() => undefined);
              }}
            >
              <ExternalLinkIcon className="size-3.5" aria-hidden />
              Add to Discord server
            </Button>
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
              onValueChange={(value) => {
                const next = value === "local" ? "local" : "worktree";
                setThreadEnvMode(next);
                void persistDiscordPatch({ threadEnvMode: next });
              }}
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
                  onChange={(event) => {
                    setBaseBranch(event.currentTarget.value);
                    dirtyFieldsRef.current.add("baseBranch");
                    setSaveStatus("unsaved");
                  }}
                  onBlur={() => void persistDiscordPatch({ baseBranch }, ["baseBranch"])}
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
                  onChange={(event) => {
                    setBranchPrefix(event.currentTarget.value);
                    dirtyFieldsRef.current.add("branchPrefix");
                    setSaveStatus("unsaved");
                  }}
                  onBlur={() => void persistDiscordPatch({ branchPrefix }, ["branchPrefix"])}
                  placeholder="demo/discord"
                  aria-label="Channel branch prefix"
                />
              </div>
            </div>
          </SettingsRow>
        ) : null}
        <div className="flex justify-end px-3 pt-3 sm:px-4">
          <Button
            onClick={() => void save()}
            disabled={(enabled && !setupComplete) || saveStatus === "saving"}
          >
            {saveStatus === "saving"
              ? "Saving…"
              : saveStatus === "saved"
                ? "Saved locally"
                : saveStatus === "error"
                  ? "Save failed — retry"
                  : "Save channel configuration"}
          </Button>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
