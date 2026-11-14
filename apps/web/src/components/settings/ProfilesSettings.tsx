import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type McpServersFile,
  type Profile,
  ProfilesError,
  type ProfilesEditorState,
  type ProfilesEditorWriteInput,
  type ProfilesFile,
  type ProfileProviderSettingsDriver,
  type ProfilesSkillsInput,
  type ProviderSettingsFile,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import {
  profilesEnvironment,
  syncProfilesNow,
  useProfilesSyncSnapshot,
} from "../../state/profiles";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { ProviderSettingsEditor } from "./ProfileProviderSettings";
import { McpServersEditor } from "./ProfileMcpServers";
import {
  addProfile,
  cleanMcpServers,
  EMPTY_MCP_SERVERS,
  deleteProfile,
  duplicateProfile,
  editDraft,
  PROFILE_DRIVER_LABELS,
  PROFILE_DRIVERS,
  profileNameError,
  profilesUsingMcpServer,
  profilesUsingPrompt,
  profilesUsingProviderSettings,
  promptUpserts,
  removeMcpServerRefs,
  renameProfile,
  renamePromptRefs,
  renameProviderSettings,
  renameProviderSettingsRefs,
  type SectionDraft,
  syncStatusText,
  toggleInList,
  toggleInOptionalList,
  uniqueName,
  viewDraft,
  withKey,
} from "@t3tools/client-runtime/profiles-editor";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const EMPTY_PROFILES: ProfilesFile = { profiles: {} };
const isProfilesError = Schema.is(ProfilesError);

function failureMessage(result: { readonly cause: Cause.Cause<unknown> }) {
  const error = squashAtomCommandFailure(result);
  return {
    conflict: isProfilesError(error) && error.reason === "conflict",
    message: error instanceof Error ? error.message : "Something went wrong.",
  };
}

export function ProfilesSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  if (!environment || scope.kind === "project" || scope.kind === "checkout") {
    return (
      <SettingsPageContainer>
        <SettingsSection id="profiles" title="Profiles">
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Profiles belong to an environment. Choose one to edit its profiles; saving copies them
            to your other environments.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      <EnvironmentProfiles
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    </SettingsPageContainer>
  );
}

function useDraft<T>(saved: T) {
  const [draft, setDraft] = useState<SectionDraft<T> | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const view = viewDraft(saved, draft);
  return {
    ...view,
    resetKey,
    set: (next: T) => setDraft(editDraft(saved, draft, next)),
    /** Rewrites an unsaved edit after its saved value was changed on purpose. */
    rebase: (nextSaved: T, map: (value: T) => T) =>
      setDraft(view.dirty ? { base: nextSaved, value: map(view.value) } : null),
    discard: () => {
      setDraft(null);
      setResetKey((key) => key + 1);
    },
  };
}

function EnvironmentProfiles({ environmentId }: { environmentId: EnvironmentId }) {
  const editorQuery = useEnvironmentQuery(profilesEnvironment.editor({ environmentId, input: {} }));
  const canWrite = useAtomValue(profilesEnvironment.writeEditor.permissionAtom(environmentId));
  const canManageSkills = useAtomValue(profilesEnvironment.runSkills.permissionAtom(environmentId));
  const write = useAtomCommand(profilesEnvironment.writeEditor, { reportFailure: false });
  const state = editorQuery.data;
  const refreshCatalog = useAtomRefresh(
    serverEnvironment.profileConfig({ environmentId, input: {} }),
  );
  const reload = () => {
    // The composer reads its own catalog query, not the editor's.
    editorQuery.refresh();
    refreshCatalog();
  };

  const savedProfiles = state?.profiles ?? EMPTY_PROFILES;
  const savedProviderSettings = state?.providerSettings ?? {};
  const savedPrompts = Object.fromEntries((state?.prompts ?? []).map((p) => [p.name, p.content]));
  const savedMcpServers = state?.mcpServers ?? EMPTY_MCP_SERVERS;
  const profiles = useDraft(savedProfiles);
  const providerSettings = useDraft<ProviderSettingsFile>(savedProviderSettings);
  const mcpServers = useDraft<McpServersFile>(savedMcpServers);
  const prompts = useDraft<Readonly<Record<string, string>>>(savedPrompts);
  const [saving, setSaving] = useState(false);

  /** Saves one change; on a conflict the section is reloaded and its edit dropped. */
  const save = async (
    input: Omit<ProfilesEditorWriteInput, "expectedRevision" | "expectedHash">,
    onConflict: () => void,
  ): Promise<ProfilesEditorState | null> => {
    if (state === null) return null;
    setSaving(true);
    const result = await write({
      environmentId,
      input: { expectedRevision: state.sync.revision, expectedHash: state.sync.hash, ...input },
    });
    setSaving(false);
    if (result._tag === "Success") return result.value;
    const failure = failureMessage(result);
    if (failure.conflict) {
      onConflict();
      editorQuery.refresh();
      toastManager.add({
        type: "warning",
        title: "Profiles changed elsewhere",
        description: "They were reloaded. Make your change again.",
      });
    } else {
      toastManager.add({
        type: "error",
        title: "Could not save profiles",
        description: failure.message,
      });
    }
    return null;
  };

  const saveSection = async <T,>(
    section: ReturnType<typeof useDraft<T>>,
    input: Omit<ProfilesEditorWriteInput, "expectedRevision" | "expectedHash">,
  ) => {
    if (section.stale) {
      section.discard();
      editorQuery.refresh();
      toastManager.add({
        type: "warning",
        title: "Profiles changed elsewhere",
        description: "This section was reloaded. Make your change again.",
      });
      return;
    }
    if ((await save(input, section.discard)) !== null) section.discard();
  };

  const renameProviderEntry = async (
    driver: ProfileProviderSettingsDriver,
    from: string,
    to: string | null,
  ) => {
    const users = profilesUsingProviderSettings(savedProfiles, driver, from);
    if (
      to === null &&
      (await requestConfirmDialog(
        `Delete the ${PROFILE_DRIVER_LABELS[driver]} settings “${from}”?${
          users.length > 0 ? `\n${users.join(", ")} will use the provider default.` : ""
        }`,
        { variant: "destructive" },
      )) !== true
    ) {
      return;
    }
    const nextProfiles = renameProviderSettingsRefs(savedProfiles, driver, from, to);
    const saved = await save(
      {
        providerSettings: renameProviderSettings(savedProviderSettings, driver, from, to),
        ...(state?.profiles && users.length > 0 ? { profiles: nextProfiles } : {}),
      },
      () => undefined,
    );
    if (saved !== null) {
      profiles.rebase(nextProfiles, (value) => renameProviderSettingsRefs(value, driver, from, to));
      setInvalidJson((current) => {
        const next = new Set(current);
        next.delete(`${driver}:${from}`);
        return next;
      });
    }
  };

  const deleteMcpServer = async (name: string) => {
    const remaining = {
      mcpServers: withKey({ ...mcpServers.value.mcpServers }, name, undefined),
    };
    if (!(name in savedMcpServers.mcpServers)) {
      mcpServers.set(remaining);
      return;
    }
    const users = profilesUsingMcpServer(savedProfiles, name);
    const confirmed = await requestConfirmDialog(
      `Delete the MCP server “${name}”?${users.length > 0 ? `\nIt is used by ${users.join(", ")}.` : ""}`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    const nextSaved = {
      mcpServers: withKey({ ...savedMcpServers.mcpServers }, name, undefined),
    };
    const nextProfiles = removeMcpServerRefs(savedProfiles, name);
    const saved = await save(
      {
        mcpServers: nextSaved,
        ...(state?.profiles && users.length > 0 ? { profiles: nextProfiles } : {}),
      },
      () => undefined,
    );
    if (saved !== null) {
      profiles.rebase(nextProfiles, (value) => removeMcpServerRefs(value, name));
      mcpServers.rebase(nextSaved, () => remaining);
    }
  };

  const deletePrompt = async (name: string) => {
    if (!(name in savedPrompts)) {
      prompts.set(withKey(prompts.value, name, undefined));
      return;
    }
    const users = profilesUsingPrompt(savedProfiles, name);
    const confirmed = await requestConfirmDialog(
      `Delete the prompt “${name}”?${users.length > 0 ? `\nIt is used by ${users.join(", ")}.` : ""}`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    const nextProfiles = renamePromptRefs(savedProfiles, name, null);
    const saved = await save(
      {
        prompts: { remove: [name] },
        ...(state?.profiles && users.length > 0 ? { profiles: nextProfiles } : {}),
      },
      () => undefined,
    );
    if (saved !== null) {
      profiles.rebase(nextProfiles, (value) => renamePromptRefs(value, name, null));
      const rest = withKey(prompts.value, name, undefined);
      prompts.rebase(Object.fromEntries(saved.prompts.map((p) => [p.name, p.content])), () => rest);
    }
  };

  const detect = useEnvironmentQuery(
    profilesEnvironment.detectOptions({ environmentId, input: {} }),
  );
  const canClearClaudeList = useAtomValue(
    profilesEnvironment.clearClaudeList.permissionAtom(environmentId),
  );
  const clearClaudeList = useAtomCommand(profilesEnvironment.clearClaudeList, "clear Claude list");
  const [invalidJson, setInvalidJson] = useState<ReadonlySet<string>>(new Set());
  const disabled = !canWrite || saving || state === null;

  return (
    <>
      <FolderAndSync
        environmentId={environmentId}
        state={state}
        error={editorQuery.error}
        pending={editorQuery.isPending}
        onReload={reload}
        canWrite={canWrite}
        onCreate={() => void save({ profiles: EMPTY_PROFILES }, () => undefined)}
      />
      {state?.profiles ? (
        <>
          <SettingsSection
            {...searchableSetting("profiles-list")}
            title="Profiles"
            headerAction={
              <SaveActions
                dirty={profiles.dirty}
                disabled={disabled}
                onDiscard={profiles.discard}
                onSave={() => void saveSection(profiles, { profiles: profiles.value })}
              />
            }
          >
            <ProfilesEditor
              file={profiles.value}
              state={state}
              providerSettings={providerSettings.value}
              mcpServers={mcpServers.value}
              disabled={disabled}
              onChange={profiles.set}
            />
          </SettingsSection>
          <SettingsSection
            {...searchableSetting("profiles-provider-settings")}
            title="Provider settings"
            headerAction={
              <SaveActions
                dirty={providerSettings.dirty}
                disabled={disabled || invalidJson.size > 0}
                onDiscard={() => {
                  providerSettings.discard();
                  setInvalidJson(new Set());
                }}
                onSave={() =>
                  void saveSection(providerSettings, { providerSettings: providerSettings.value })
                }
              />
            }
          >
            <ProviderSettingsEditor
              value={providerSettings.value}
              options={detect.data}
              optionsError={detect.error}
              optionsPending={detect.isPending}
              onRefreshOptions={detect.refresh}
              onClearClaudeList={
                canClearClaudeList
                  ? () => void clearClaudeList({ environmentId, input: {} })
                  : undefined
              }
              disabled={disabled}
              dirty={providerSettings.dirty}
              onChange={providerSettings.set}
              onRename={(driver, from, to) => void renameProviderEntry(driver, from, to)}
              usedBy={(driver, name) => profilesUsingProviderSettings(profiles.value, driver, name)}
              resetKey={providerSettings.resetKey}
              onJsonValidity={(key, valid) =>
                setInvalidJson((current) => {
                  const next = new Set(current);
                  if (valid) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            />
          </SettingsSection>
          <SettingsSection
            {...searchableSetting("profiles-mcp-servers")}
            title="MCP servers"
            headerAction={
              <SaveActions
                dirty={mcpServers.dirty}
                disabled={disabled || !canManageSkills}
                onDiscard={mcpServers.discard}
                onSave={() =>
                  void saveSection(mcpServers, { mcpServers: cleanMcpServers(mcpServers.value) })
                }
              />
            }
          >
            <AllowMcpCommands environmentId={environmentId} />
            <McpServersEditor
              environmentId={environmentId}
              value={mcpServers.value}
              profiles={profiles.value}
              disabled={disabled || !canManageSkills}
              onChange={mcpServers.set}
              onDelete={(name) => void deleteMcpServer(name)}
            />
          </SettingsSection>
        </>
      ) : null}
      {state?.exists ? (
        <>
          <SettingsSection
            {...searchableSetting("profiles-prompts")}
            title="Prompts"
            headerAction={
              <SaveActions
                dirty={prompts.dirty}
                disabled={disabled}
                onDiscard={prompts.discard}
                onSave={() =>
                  void saveSection(prompts, {
                    prompts: { upsert: promptUpserts(state.prompts, prompts.value) },
                  })
                }
              />
            }
          >
            <PromptsEditor
              contents={prompts.value}
              profiles={profiles.value}
              disabled={disabled}
              onChange={prompts.set}
              onDelete={(name) => void deletePrompt(name)}
            />
          </SettingsSection>
          <SkillsSection
            environmentId={environmentId}
            state={state}
            disabled={!canManageSkills || state === null}
          />
        </>
      ) : null}
    </>
  );
}

function AllowMcpCommands({ environmentId }: { environmentId: EnvironmentId }) {
  const allowed = useEnvironmentSettings(environmentId, (value) => value.profilesMcpCommands);
  const update = useUpdateEnvironmentSettings(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  return (
    <SettingsRow
      title="Allow MCP commands"
      description="Let profiles start command servers on this machine. Off by default, because profiles sync from your other machines. Sessions that need one fail to start until this is on."
      control={
        <Switch
          checked={allowed}
          disabled={!canManage}
          onCheckedChange={(checked) => void update({ profilesMcpCommands: checked })}
          aria-label="Allow MCP commands"
        />
      }
    />
  );
}

function SaveActions(props: {
  dirty: boolean;
  disabled: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!props.dirty) return null;
  return (
    <span className="flex items-center gap-2">
      <Badge variant="outline" size="sm">
        Unsaved
      </Badge>
      <Button size="xs" variant="ghost" onClick={props.onDiscard}>
        Discard
      </Button>
      <Button size="xs" disabled={props.disabled} onClick={props.onSave}>
        Save
      </Button>
    </span>
  );
}

function FolderAndSync(props: {
  environmentId: EnvironmentId;
  state: ProfilesEditorState | null;
  error: string | null;
  pending: boolean;
  onReload: () => void;
  canWrite: boolean;
  onCreate: () => void;
}) {
  const { environmentId, state } = props;
  const settings = useEnvironmentSettings(environmentId, (value) => value);
  const update = useUpdateEnvironmentSettings(environmentId);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canOpenEditor = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const { environments } = useEnvironments();
  const availableEditors =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.availableEditors ?? [];
  const openInEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const writable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const snapshot = useProfilesSyncSnapshot();
  const catalog = state?.catalog;
  const usable = Object.entries(catalog?.profiles ?? {}).filter(([, profile]) => !profile.warning);

  return (
    <SettingsSection
      {...searchableSetting("profiles")}
      title="Folder & sync"
      headerAction={
        <span className="flex items-center gap-2">
          <Button size="xs" variant="outline" disabled={props.pending} onClick={props.onReload}>
            Reload
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={snapshot.running}
            onClick={() => void syncProfilesNow()}
          >
            {snapshot.running ? "Syncing…" : "Sync now"}
          </Button>
        </span>
      }
    >
      <SettingsRow
        title="Profiles folder"
        description={
          state?.folder ??
          "Leave blank to use <T3 home>/profiles. Profiles are copied to your other environments."
        }
        control={
          <span className="flex items-center gap-2">
            <Input
              aria-label="Profiles folder"
              placeholder="Default"
              defaultValue={settings.profilesFolder}
              disabled={!canWriteSettings}
              onBlur={(event) => {
                if (event.target.value !== settings.profilesFolder) {
                  update({ profilesFolder: event.target.value }, { onSaved: props.onReload });
                }
              }}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={!canOpenEditor || !state?.exists || availableEditors.length === 0}
              onClick={async () => {
                if (!state) return;
                const result = await openInEditor(state.folder);
                if (result._tag === "Success") return;
                toastManager.add({
                  type: "error",
                  title: "Could not open the profiles folder",
                  description: failureMessage(result).message,
                });
              }}
            >
              Open in editor
            </Button>
          </span>
        }
      />
      <SettingsRow
        title="Sync with other machines"
        description="Copy profiles to and from your other connected machines. The latest change wins. Turn off to keep this machine's profiles to itself."
        control={
          <Switch
            checked={settings.profilesSync}
            disabled={!canWriteSettings}
            onCheckedChange={(checked) =>
              update({ profilesSync: checked }, { onSaved: () => void syncProfilesNow() })
            }
            aria-label="Sync with other machines"
          />
        }
      />
      <SettingsRow
        title="Default profile for new threads"
        description="Does not affect existing threads or delegated children."
        control={
          <Select
            value={settings.defaultProfile ?? "__folder__"}
            disabled={!canWriteSettings}
            onValueChange={(value) => {
              void update({ defaultProfile: value === "__folder__" ? null : value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Default profile for new threads">
              <SelectValue>
                {settings.defaultProfile === null
                  ? "Folder default"
                  : settings.defaultProfile || "No profile"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="__folder__">Folder default</SelectItem>
              <SelectItem value="">No profile</SelectItem>
              {Object.entries(catalog?.profiles ?? {}).map(([id, profile]) => (
                <SelectItem key={id} value={id} disabled={Boolean(profile.warning)}>
                  {id}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <div className="space-y-1 px-3 py-3 text-xs sm:px-4">
        {props.error ? (
          <p role="alert" className="text-destructive">
            {props.error}
          </p>
        ) : null}
        {state?.error ? (
          <p role="alert" className="text-destructive">
            {state.error}
          </p>
        ) : null}
        {catalog?.error && catalog.error !== state?.error ? (
          <p role="alert" className="text-destructive">
            {catalog.error}
          </p>
        ) : null}
        {state ? (
          <p className="text-muted-foreground">
            Revision {state.sync.revision}. {usable.length} profiles available. Changes apply at the
            next session start.
          </p>
        ) : null}
        {state && state.profiles === null && !state.error ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground">This folder has no profiles.json yet.</p>
            <Button size="xs" disabled={!props.canWrite} onClick={props.onCreate}>
              Create profiles
            </Button>
          </div>
        ) : null}
        <ul className="space-y-0.5">
          {environments.map((environment) => {
            const status = syncStatusText({
              connected: environment.connection.phase === "connected",
              canWrite: writable.has(environment.environmentId),
              status: snapshot.statuses.get(environment.environmentId),
            });
            return (
              <li key={environment.environmentId} className="flex justify-between gap-3">
                <span className="truncate">{environment.label}</span>
                <span
                  className={
                    status.tone === "error"
                      ? "text-destructive"
                      : status.tone === "warning"
                        ? "text-warning"
                        : "text-muted-foreground"
                  }
                >
                  {status.text}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </SettingsSection>
  );
}

function ProfilesEditor(props: {
  file: ProfilesFile;
  state: ProfilesEditorState;
  providerSettings: ProviderSettingsFile;
  mcpServers: McpServersFile;
  disabled: boolean;
  onChange: (file: ProfilesFile) => void;
}) {
  const { file, state } = props;
  const ids = Object.keys(file.profiles);
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected !== null && selected in file.profiles ? selected : (ids[0] ?? null);
  const profile = current === null ? undefined : file.profiles[current];
  const [newName, setNewName] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const newNameError = newName === "" ? null : profileNameError(newName, ids);
  const renameError =
    renameTo === "" || renameTo === current ? null : profileNameError(renameTo, ids);
  const setProfile = (next: Profile) => {
    if (current !== null)
      props.onChange({ ...file, profiles: { ...file.profiles, [current]: next } });
  };

  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <ul className="flex flex-wrap gap-1.5" aria-label="Profiles">
        {ids.map((id) => {
          const warning = state.catalog.profiles[id]?.warning;
          return (
            <li key={id}>
              <Button
                size="xs"
                variant={id === current ? "secondary" : "ghost"}
                aria-pressed={id === current}
                onClick={() => {
                  setSelected(id);
                  setRenameTo("");
                }}
              >
                {id}
                {file.default === id ? " (default)" : ""}
                {warning ? " ⚠" : ""}
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="New profile name"
          placeholder="New profile name"
          value={newName}
          disabled={props.disabled}
          aria-invalid={newNameError !== null}
          onChange={(event) => setNewName(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || newName === "" || newNameError !== null}
          onClick={() => {
            props.onChange(addProfile(file, newName));
            setSelected(newName);
            setNewName("");
          }}
        >
          Add profile
        </Button>
      </div>
      {newNameError ? <p className="text-xs text-destructive">{newNameError}</p> : null}

      {current !== null && profile !== undefined ? (
        <div className="space-y-3 rounded-lg border border-border/60 p-3">
          {state.catalog.profiles[current]?.warning ? (
            <p role="status" className="text-xs text-warning">
              {state.catalog.profiles[current]?.warning}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Rename profile"
              placeholder={current}
              value={renameTo}
              disabled={props.disabled}
              aria-invalid={renameError !== null}
              onChange={(event) => setRenameTo(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={
                props.disabled || renameTo === "" || renameTo === current || renameError !== null
              }
              onClick={() => {
                props.onChange(renameProfile(file, current, renameTo));
                setSelected(renameTo);
                setRenameTo("");
              }}
            >
              Rename
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={props.disabled}
              onClick={() => {
                const copy = uniqueName(`${current}-copy`, ids);
                props.onChange(duplicateProfile(file, current, copy));
                setSelected(copy);
              }}
            >
              Duplicate
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={props.disabled || file.default === current}
              onClick={() => props.onChange({ ...file, default: current })}
            >
              Make default
            </Button>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={props.disabled}
              onClick={async () => {
                const confirmed = await requestConfirmDialog(`Delete the profile “${current}”?`, {
                  variant: "destructive",
                });
                if (confirmed === true) props.onChange(deleteProfile(file, current));
              }}
            >
              Delete
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Threads that already use this profile keep its old name. After a rename or delete, pick
            a profile again in those threads.
          </p>
          {renameError ? <p className="text-xs text-destructive">{renameError}</p> : null}
          <Input
            aria-label="Profile description"
            placeholder="Description"
            value={profile.description ?? ""}
            disabled={props.disabled}
            onChange={(event) =>
              setProfile(
                withKey(
                  profile,
                  "description",
                  event.target.value.trim() === "" ? undefined : event.target.value,
                ),
              )
            }
          />
          <NamedChecklist
            title="Prompts"
            description="Added to the agent’s instructions in this order."
            names={orderedNames(
              profile.prompts,
              state.prompts.map(({ name }) => name),
            )}
            checked={profile.prompts}
            missingLabel="no prompt file"
            known={state.prompts.map(({ name }) => name)}
            disabled={props.disabled}
            onToggle={(name, on) =>
              setProfile({ ...profile, prompts: toggleInList(profile.prompts, name, on) })
            }
          />
          <NamedChecklist
            title="Skills"
            description="Listed for the agent to use."
            names={orderedNames(
              profile.skills,
              state.skills.map(({ name }) => name),
            )}
            checked={profile.skills}
            missingLabel="not installed"
            known={state.skills.map(({ name }) => name)}
            warnings={Object.fromEntries(
              state.skills.flatMap((skill) => (skill.warning ? [[skill.name, skill.warning]] : [])),
            )}
            disabled={props.disabled}
            onToggle={(name, on) =>
              setProfile({ ...profile, skills: toggleInList(profile.skills, name, on) })
            }
          />
          <NamedChecklist
            title="MCP servers"
            description="Added to Claude and Codex sessions."
            names={orderedNames(profile.mcpServers ?? [], Object.keys(props.mcpServers.mcpServers))}
            checked={profile.mcpServers ?? []}
            missingLabel="not defined"
            known={Object.keys(props.mcpServers.mcpServers)}
            disabled={props.disabled}
            onToggle={(name, on) =>
              setProfile(
                withKey(profile, "mcpServers", toggleInOptionalList(profile.mcpServers, name, on)),
              )
            }
          />
          <div className="space-y-1.5">
            <p className="text-sm text-foreground">Provider settings</p>
            {PROFILE_DRIVERS.map((driver) => (
              <ProviderSettingsPick
                key={driver}
                driver={driver}
                value={profile.providerSettings?.[driver]}
                names={Object.keys(props.providerSettings[driver] ?? {})}
                disabled={props.disabled}
                onChange={(name) => {
                  const refs = withKey(profile.providerSettings ?? {}, driver, name);
                  setProfile(
                    withKey(
                      profile,
                      "providerSettings",
                      Object.keys(refs).length === 0 ? undefined : refs,
                    ),
                  );
                }}
              />
            ))}
          </div>
          <Collapsible>
            <CollapsibleTrigger>Advanced</CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-3">
                <Input
                  aria-label="Provider instance"
                  placeholder="Provider instance"
                  value={profile.provider ?? ""}
                  disabled={props.disabled}
                  onChange={(event) => {
                    const text = event.target.value.trim();
                    setProfile(
                      withKey(
                        profile,
                        "provider",
                        text === "" ? undefined : ProviderInstanceId.make(text),
                      ),
                    );
                  }}
                />
                <Input
                  aria-label="Model"
                  placeholder="Model"
                  value={profile.model ?? ""}
                  disabled={props.disabled}
                  onChange={(event) =>
                    setProfile(
                      withKey(
                        profile,
                        "model",
                        event.target.value.trim() === "" ? undefined : event.target.value,
                      ),
                    )
                  }
                />
                <Input
                  aria-label="Effort"
                  placeholder="Effort"
                  value={profile.effort ?? ""}
                  disabled={props.disabled}
                  onChange={(event) =>
                    setProfile(
                      withKey(
                        profile,
                        "effort",
                        event.target.value.trim() === "" ? undefined : event.target.value,
                      ),
                    )
                  }
                />
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No profiles yet. Add one to start.</p>
      )}
    </div>
  );
}

/** The profile's own order first, then the other available names. */
function orderedNames(selected: ReadonlyArray<string>, available: ReadonlyArray<string>) {
  return [...selected, ...available.filter((name) => !selected.includes(name)).toSorted()];
}

function NamedChecklist(props: {
  title: string;
  description: string;
  names: ReadonlyArray<string>;
  checked: ReadonlyArray<string>;
  known: ReadonlyArray<string>;
  missingLabel: string;
  warnings?: Readonly<Record<string, string>>;
  disabled: boolean;
  onToggle: (name: string, on: boolean) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div>
        <p className="text-sm text-foreground">{props.title}</p>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      {props.names.length === 0 ? (
        <p className="text-xs text-muted-foreground">None in this folder.</p>
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {props.names.map((name) => (
            <label key={name} className="flex min-w-0 items-center gap-2 text-xs">
              <Checkbox
                checked={props.checked.includes(name)}
                disabled={props.disabled}
                onCheckedChange={(on) => props.onToggle(name, on === true)}
              />
              <span className="truncate">{name}</span>
              {props.known.includes(name) ? null : (
                <Badge variant="outline" size="sm">
                  {props.missingLabel}
                </Badge>
              )}
              {props.warnings?.[name] ? (
                <span className="text-warning">{props.warnings[name]}</span>
              ) : null}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const PROVIDER_DEFAULT = "__provider_default__";

function ProviderSettingsPick(props: {
  driver: ProfileProviderSettingsDriver;
  value: string | undefined;
  names: ReadonlyArray<string>;
  disabled: boolean;
  onChange: (name: string | undefined) => void;
}) {
  const names =
    props.value !== undefined && !props.names.includes(props.value)
      ? [...props.names, props.value]
      : props.names;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs">{PROFILE_DRIVER_LABELS[props.driver]}</span>
      <Select
        value={props.value ?? PROVIDER_DEFAULT}
        disabled={props.disabled}
        onValueChange={(value) =>
          props.onChange(value === PROVIDER_DEFAULT || value === null ? undefined : value)
        }
      >
        <SelectTrigger size="sm" aria-label={`${PROFILE_DRIVER_LABELS[props.driver]} settings`}>
          <SelectValue>{props.value ?? "Provider default"}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={PROVIDER_DEFAULT}>Provider default</SelectItem>
          {names.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
              {props.names.includes(name) ? "" : " (missing)"}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function PromptsEditor(props: {
  contents: Readonly<Record<string, string>>;
  profiles: ProfilesFile;
  disabled: boolean;
  onChange: (contents: Readonly<Record<string, string>>) => void;
  onDelete: (name: string) => void;
}) {
  const names = Object.keys(props.contents).toSorted();
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected !== null && selected in props.contents ? selected : (names[0] ?? null);
  const [newName, setNewName] = useState("");
  const newNameError = newName === "" ? null : profileNameError(newName, names);
  const users = current === null ? [] : profilesUsingPrompt(props.profiles, current);
  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        {names.length > 0 ? (
          <Select value={current ?? ""} onValueChange={(value) => setSelected(value)}>
            <SelectTrigger size="sm" aria-label="Prompt">
              <SelectValue>{current}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {names.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <Input
          aria-label="New prompt name"
          placeholder="New prompt name"
          value={newName}
          disabled={props.disabled}
          aria-invalid={newNameError !== null}
          onChange={(event) => setNewName(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || newName === "" || newNameError !== null}
          onClick={() => {
            props.onChange({ ...props.contents, [newName]: "" });
            setSelected(newName);
            setNewName("");
          }}
        >
          Add prompt
        </Button>
        {current !== null ? (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={props.disabled}
            onClick={() => props.onDelete(current)}
          >
            Delete
          </Button>
        ) : null}
      </div>
      {newNameError ? <p className="text-xs text-destructive">{newNameError}</p> : null}
      {current !== null ? (
        <>
          <Textarea
            aria-label={`Prompt ${current}`}
            value={props.contents[current] ?? ""}
            disabled={props.disabled}
            onChange={(event) =>
              props.onChange({ ...props.contents, [current]: event.target.value })
            }
          />
          <p className="text-xs text-muted-foreground">
            {users.length > 0 ? `Used by ${users.join(", ")}.` : "No profile uses this prompt."}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">No prompts yet.</p>
      )}
    </div>
  );
}

function SkillsSection(props: {
  environmentId: EnvironmentId;
  state: ProfilesEditorState;
  disabled: boolean;
}) {
  const run = useAtomCommand(profilesEnvironment.runSkills, { reportFailure: false });
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [skill, setSkill] = useState("");
  const skillError = skill === "" ? null : profileNameError(skill, []);
  const disabled = props.disabled || running;

  const runSkills = async (input: ProfilesSkillsInput, done: string) => {
    setRunning(true);
    setFailure(null);
    const result = await run({ environmentId: props.environmentId, input });
    setRunning(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: done });
      return true;
    }
    setFailure(failureMessage(result).message);
    return false;
  };

  return (
    <SettingsSection
      {...searchableSetting("profiles-skills")}
      title="Skills"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => void runSkills({ _tag: "update" }, "Skills updated")}
        >
          Update all
        </Button>
      }
    >
      <div className="space-y-3 px-3 py-3 sm:px-4">
        {props.state.skills.length === 0 ? (
          <p className="text-xs text-muted-foreground">No skills in this folder.</p>
        ) : (
          <ul className="space-y-2">
            {props.state.skills.map((entry) => (
              <li key={entry.name} className="flex items-start justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    {entry.name}{" "}
                    <span className="font-normal text-muted-foreground">
                      {entry.source ?? "local"}
                    </span>
                  </p>
                  {entry.description ? (
                    <p className="text-muted-foreground">{entry.description}</p>
                  ) : null}
                  {entry.warning ? <p className="text-warning">{entry.warning}</p> : null}
                  {entry.needsInstall ? (
                    <p className="text-warning">Its dependencies are not installed here.</p>
                  ) : null}
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  {entry.needsInstall ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        void runSkills(
                          { _tag: "install", name: entry.name },
                          `Installed dependencies for ${entry.name}`,
                        )
                      }
                    >
                      Install dependencies
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={disabled}
                    onClick={async () => {
                      const confirmed = await requestConfirmDialog(
                        `Remove the skill “${entry.name}”?`,
                        {
                          variant: "destructive",
                        },
                      );
                      if (confirmed === true) {
                        void runSkills(
                          { _tag: "remove", name: entry.name },
                          `Removed ${entry.name}`,
                        );
                      }
                    }}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Skill source"
            placeholder="owner/repo or URL"
            value={source}
            disabled={disabled}
            onChange={(event) => setSource(event.target.value)}
          />
          <Input
            aria-label="Skill name"
            placeholder="Skill (optional)"
            value={skill}
            disabled={disabled}
            aria-invalid={skillError !== null}
            onChange={(event) => setSkill(event.target.value)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || source.trim() === "" || skillError !== null}
            onClick={async () => {
              const added = await runSkills(
                {
                  _tag: "add",
                  source: source.trim(),
                  ...(skill === "" ? {} : { skill }),
                },
                "Skill added",
              );
              if (added) {
                setSource("");
                setSkill("");
              }
            }}
          >
            {running ? "Running…" : "Add skill"}
          </Button>
        </div>
        {skillError ? <p className="text-xs text-destructive">{skillError}</p> : null}
        {failure ? (
          <pre
            role="alert"
            className="max-h-48 overflow-auto rounded-md border border-destructive/30 p-2 text-xs whitespace-pre-wrap text-destructive"
          >
            {failure}
          </pre>
        ) : null}
      </div>
    </SettingsSection>
  );
}
