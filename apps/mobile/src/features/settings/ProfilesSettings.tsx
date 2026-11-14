import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  addProfile,
  deleteProfile,
  editDraft,
  PROFILE_DRIVERS,
  PROFILE_DRIVER_LABELS,
  profileNameError,
  renameProfile,
  type SectionDraft,
  syncStatusText,
  toggleInList,
  toggleInOptionalList,
  viewDraft,
  withKey,
} from "@t3tools/client-runtime/profiles-editor";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type Profile,
  ProfilesError,
  type ProfilesEditorState,
  type ProfilesFile,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
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
import { SettingsSection } from "./components/SettingsSection";
import type { SettingsTarget } from "./settings-environment-filter";
import { ProfileSkillsSettings } from "./ProfileSkillsSettings";

const EMPTY_PROFILES: ProfilesFile = { profiles: {} };
const isProfilesError = Schema.is(ProfilesError);

export function ProfilesSettings({ environment }: { environment: SettingsTarget }) {
  const environmentId = environment.environmentId;
  const query = useEnvironmentQuery(profilesEnvironment.editor({ environmentId, input: {} }));
  const refreshCatalog = useAtomRefresh(
    serverEnvironment.profileConfig({ environmentId, input: {} }),
  );
  function refresh() {
    query.refresh();
    refreshCatalog();
  }
  return (
    <>
      <ProfilesFolderSettings environment={environment} state={query.data} refresh={refresh} />
      {query.error ? <Notice tone="danger" message={query.error} /> : null}
      <Button label="Refresh profiles" tone="text" onPress={refresh} />
      {query.data ? (
        <ProfilesEditor
          key={query.data.folder}
          environmentId={environmentId}
          state={query.data}
          refresh={refresh}
        />
      ) : !query.error ? (
        <Text className="text-foreground-muted">Loading profiles…</Text>
      ) : null}
    </>
  );
}

function ProfilesFolderSettings(props: {
  readonly environment: SettingsTarget;
  readonly state: ProfilesEditorState | null;
  readonly refresh: () => void;
}) {
  const { environment, state } = props;
  const environmentId = environment.environmentId;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const settings = config?.settings ?? environment.serverConfig.settings;
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canSync = useAtomValue(profilesEnvironment.writeSync.permissionAtom(environmentId));
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const sync = useProfilesSyncSnapshot();
  const { environments } = useEnvironments();
  const writable = useEnvironmentsWithScope(environments, AuthSettingsWriteScope);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const catalog = state?.catalog ?? environment.serverConfig.profiles;
  async function update(patch: ServerSettingsPatch) {
    if (!canWrite || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    const result = await save({ environmentId, input: { patch } });
    pending.current = false;
    setSaving(false);
    if (result._tag === "Success") {
      props.refresh();
      if (patch.profilesFolder !== undefined || patch.profilesSync !== undefined)
        void syncProfilesNow();
    } else {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not save profiles settings.");
    }
  }
  return (
    <SettingsSection
      title="Folder & sync"
      footer="Changes apply at the next session start, not to a running session."
    >
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground">Profiles folder</Text>
        <TextInput
          key={settings.profilesFolder}
          accessibilityLabel="Profiles folder"
          className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
          autoCapitalize="none"
          autoCorrect={false}
          editable={canWrite && !saving}
          defaultValue={settings.profilesFolder}
          placeholder={state?.folder ?? catalog?.folder ?? "<T3 home>/profiles"}
          placeholderTextColorClassName="accent-foreground-muted"
          onEndEditing={(event) => {
            if (event.nativeEvent.text !== settings.profilesFolder)
              void update({ profilesFolder: event.nativeEvent.text });
          }}
        />
        <Text selectable className="text-sm text-foreground-muted">
          {state?.folder ?? catalog?.folder ?? "<T3 home>/profiles"}
        </Text>
        <Text className="text-sm text-foreground-muted">
          Revision: {state?.sync.revision ?? "Unknown"}
        </Text>
        <Menu
          accessibilityLabel="Default profile for new threads"
          actions={[
            {
              id: "__folder__",
              title: "Folder default",
              attributes: { disabled: !canWrite || saving },
            },
            { id: "", title: "No profile", attributes: { disabled: !canWrite || saving } },
            ...Object.entries(catalog?.profiles ?? {}).map(([id, profile]) => ({
              id,
              title: id,
              subtitle: profile.warning,
              attributes: { disabled: !canWrite || saving || Boolean(profile.warning) },
            })),
          ]}
          onPressAction={({ nativeEvent }) => {
            const id = nativeEvent.event;
            if (catalog?.profiles[id]?.warning) return;
            void update({ defaultProfile: id === "__folder__" ? null : id });
          }}
        >
          <Button
            tone="text"
            label={`Default profile: ${settings.defaultProfile === null ? "Folder default" : settings.defaultProfile || "No profile"}`}
            disabled={!canWrite || saving}
            onPress={() => {}}
          />
        </Menu>
        <ListToggleRow
          label="Sync with other machines"
          description="The latest change wins. Turn off to keep this machine's profiles to itself."
          disabled={!canWrite || saving}
          value={settings.profilesSync}
          onValueChange={(value) => void update({ profilesSync: value })}
        />
        <ListToggleRow
          label="Allow MCP commands"
          description="Let profiles start command servers on this machine. Off by default, because profiles sync from your other machines."
          disabled={!canWrite || !canManageProviders || saving}
          value={settings.profilesMcpCommands}
          onValueChange={(value) => void update({ profilesMcpCommands: value })}
        />
        <Button
          label="Sync now"
          disabled={!canSync || sync.running}
          onPress={() => {
            if (canSync) void syncProfilesNow().then(props.refresh);
          }}
        />
        {environments.map((entry) => (
          <Text key={entry.environmentId} selectable className="text-sm text-foreground-muted">
            {entry.label}:{" "}
            {
              syncStatusText({
                connected: entry.connection.phase === "connected",
                canWrite: writable.has(entry.environmentId),
                status: sync.statuses.get(entry.environmentId),
              }).text
            }
          </Text>
        ))}
        {error ? <Notice tone="danger" message={error} /> : null}
      </View>
    </SettingsSection>
  );
}

function ProfilesEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly state: ProfilesEditorState;
  readonly refresh: () => void;
}) {
  const { environmentId, state } = props;
  const canWrite = useAtomValue(profilesEnvironment.writeEditor.permissionAtom(environmentId));
  const write = useAtomCommand(profilesEnvironment.writeEditor, { reportFailure: false });
  const [draft, setDraft] = useState<SectionDraft<ProfilesFile> | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saved = state.profiles ?? EMPTY_PROFILES;
  const section = viewDraft(saved, draft);
  const file = section.value;
  const disabled = !canWrite || saving || state.profiles === null;
  function edit(next: ProfilesFile) {
    if (!disabled) setDraft(editDraft(saved, draft, next));
  }
  function editProfile(id: string, profile: Profile) {
    edit({ ...file, profiles: { ...file.profiles, [id]: profile } });
  }
  function changedElsewhere() {
    setDraft(null);
    props.refresh();
    setNotice("Profiles changed elsewhere. This section was reloaded. Make your change again.");
  }
  async function save(create = false) {
    if (!canWrite || pending.current || (create ? state.exists : state.profiles === null)) return;
    if (section.stale) {
      changedElsewhere();
      return;
    }
    pending.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    const result = await write({
      environmentId,
      input: {
        expectedRevision: state.sync.revision,
        expectedHash: state.sync.hash,
        profiles: file,
      },
    });
    pending.current = false;
    setSaving(false);
    if (result._tag === "Success") {
      setDraft(null);
      setNotice("Profiles saved.");
    } else {
      const failure = squashAtomCommandFailure(result);
      if (isProfilesError(failure) && failure.reason === "conflict") changedElsewhere();
      else setError(failure instanceof Error ? failure.message : "Could not save profiles.");
    }
  }
  function nameProfile(id?: string) {
    Dialog.prompt({
      title: id === undefined ? "Add profile" : "Rename profile",
      ...(id === undefined
        ? {}
        : { message: "Threads that already use this profile keep its old name." }),
      initialValue: id ?? "",
      confirmText: id === undefined ? "Add" : "Rename",
      onConfirm: (name) => {
        const validation = profileNameError(
          name,
          Object.keys(file.profiles).filter((key) => key !== id),
        );
        if (validation) {
          setError(validation);
          return;
        }
        edit(id === undefined ? addProfile(file, name) : renameProfile(file, id, name));
      },
    });
  }
  return (
    <>
      <SettingsSection
        title="Profiles"
        footer="Prompts keep their order; newly enabled prompts are appended."
      >
        {state.error ? (
          <View className="p-4">
            <Notice tone="danger" message={state.error} />
          </View>
        ) : null}
        {state.catalog.error && state.catalog.error !== state.error ? (
          <View className="p-4">
            <Notice tone="danger" message={state.catalog.error} />
          </View>
        ) : null}
        {notice ? (
          <View className="p-4">
            <Notice message={notice} />
          </View>
        ) : null}
        {error ? (
          <View className="p-4">
            <Notice tone="danger" message={error} />
          </View>
        ) : null}
        {!state.exists ? (
          <View className="p-4">
            <Button
              label="Create profiles"
              disabled={!canWrite || saving}
              onPress={() => void save(true)}
            />
          </View>
        ) : null}
        {state.exists && state.profiles === null ? (
          <Text className="p-4 text-foreground-muted">
            Invalid profiles.json is never overwritten. Fix it on web or desktop.
          </Text>
        ) : null}
        {Object.entries(file.profiles).map(([id, profile]) => (
          <View key={id} className="gap-3 border-t border-border-subtle py-4">
            <View className="gap-2 px-4">
              <Text className="font-t3-medium text-foreground">
                {id}
                {file.default === id ? " · Default" : ""}
              </Text>
              {profile.description ? (
                <Text className="text-sm text-foreground-muted">{profile.description}</Text>
              ) : null}
              {state.catalog.profiles[id]?.warning ? (
                <Notice message={state.catalog.profiles[id]!.warning!} />
              ) : null}
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label={file.default === id ? "Clear default" : "Set default"}
                  tone="text"
                  disabled={disabled}
                  onPress={() =>
                    edit(withKey(file, "default", file.default === id ? undefined : id))
                  }
                />
                <Button
                  label="Rename"
                  tone="text"
                  disabled={disabled}
                  onPress={() => nameProfile(id)}
                />
                <Button
                  label="Delete"
                  tone="danger"
                  disabled={disabled}
                  onPress={() =>
                    Dialog.confirm({
                      title: `Delete profile “${id}”?`,
                      message: "Save profiles to apply this change.",
                      confirmText: "Delete",
                      destructive: true,
                      onConfirm: () => edit(deleteProfile(file, id)),
                    })
                  }
                />
              </View>
              <Text className="text-sm text-foreground-muted">Prompts</Text>
            </View>
            {[...new Set([...profile.prompts, ...state.prompts.map((prompt) => prompt.name)])].map(
              (name) => (
                <ListToggleRow
                  key={name}
                  label={name}
                  description={
                    state.prompts.some((prompt) => prompt.name === name)
                      ? undefined
                      : "Not on this machine"
                  }
                  value={profile.prompts.includes(name)}
                  disabled={disabled}
                  onValueChange={(on) =>
                    editProfile(id, {
                      ...profile,
                      prompts: toggleInList(profile.prompts, name, on),
                    })
                  }
                />
              ),
            )}
            <Text className="px-4 text-sm text-foreground-muted">Skills</Text>
            {[...new Set([...profile.skills, ...state.skills.map((skill) => skill.name)])].map(
              (name) => (
                <ListToggleRow
                  key={name}
                  label={name}
                  description={
                    state.skills.some((skill) => skill.name === name)
                      ? undefined
                      : "Not on this machine"
                  }
                  value={profile.skills.includes(name)}
                  disabled={disabled}
                  onValueChange={(on) =>
                    editProfile(id, { ...profile, skills: toggleInList(profile.skills, name, on) })
                  }
                />
              ),
            )}
            {/* Missing when the file is broken or the server predates MCP servers. */}
            {state.mcpServers === undefined ? null : (
              <Text className="px-4 text-sm text-foreground-muted">MCP servers</Text>
            )}
            {(state.mcpServers === undefined
              ? []
              : [
                  ...new Set([
                    ...(profile.mcpServers ?? []),
                    ...Object.keys(state.mcpServers.mcpServers),
                  ]),
                ]
            ).map((name) => (
              <ListToggleRow
                key={name}
                label={name}
                description={
                  state.mcpServers?.mcpServers[name] === undefined
                    ? "Not defined"
                    : "For Claude and Codex"
                }
                value={profile.mcpServers?.includes(name) === true}
                disabled={disabled}
                onValueChange={(on) =>
                  editProfile(
                    id,
                    withKey(
                      profile,
                      "mcpServers",
                      toggleInOptionalList(profile.mcpServers, name, on),
                    ),
                  )
                }
              />
            ))}
            <View className="gap-2 px-4">
              {PROFILE_DRIVERS.map((driver) => {
                const current = profile.providerSettings?.[driver];
                const names = Object.keys(state.providerSettings[driver] ?? {});
                return (
                  <Menu
                    key={driver}
                    accessibilityLabel={`${id} ${PROFILE_DRIVER_LABELS[driver]} provider settings`}
                    actions={[
                      {
                        id: "",
                        title: "Provider default",
                        state: current ? "off" : "on",
                        attributes: { disabled },
                      },
                      ...[...new Set([...names, ...(current ? [current] : [])])].map((name) => ({
                        id: name,
                        title: name,
                        subtitle: names.includes(name) ? undefined : "Not on this machine",
                        attributes: { disabled },
                        state: current === name ? ("on" as const) : ("off" as const),
                      })),
                    ]}
                    onPressAction={({ nativeEvent }) => {
                      if (disabled) return;
                      const refs = withKey(
                        profile.providerSettings ?? {},
                        driver,
                        nativeEvent.event || undefined,
                      );
                      editProfile(
                        id,
                        withKey(
                          profile,
                          "providerSettings",
                          Object.keys(refs).length ? refs : undefined,
                        ),
                      );
                    }}
                  >
                    <Button
                      label={`${PROFILE_DRIVER_LABELS[driver]}: ${current ?? "Provider default"}`}
                      tone="text"
                      disabled={disabled}
                      onPress={() => {}}
                    />
                  </Menu>
                );
              })}
            </View>
          </View>
        ))}
        {state.profiles !== null ? (
          <View className="gap-3 p-4">
            <Button label="Add profile" disabled={disabled} onPress={() => nameProfile()} />
            {section.dirty ? (
              <Text className="text-sm text-foreground-muted">
                Unsaved changes{section.stale ? " · Profiles changed elsewhere" : ""}
              </Text>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <Button
                label="Save profiles"
                disabled={disabled || !section.dirty}
                onPress={() => void save()}
              />
              <Button
                label="Discard"
                tone="text"
                disabled={saving || !section.dirty}
                onPress={() => setDraft(null)}
              />
            </View>
          </View>
        ) : null}
      </SettingsSection>
      <SettingsSection title="Provider settings" footer="Edit on web or desktop">
        <View className="gap-3 p-4">
          {PROFILE_DRIVERS.map((driver) => (
            <View key={driver} className="gap-1">
              <Text className="font-t3-medium text-foreground">
                {PROFILE_DRIVER_LABELS[driver]}
              </Text>
              {Object.entries(state.providerSettings[driver] ?? {}).map(([name, settings]) => (
                <View key={name}>
                  <Text className="text-foreground">{name}</Text>
                  {settings.description ? (
                    <Text className="text-sm text-foreground-muted">{settings.description}</Text>
                  ) : null}
                  <Text selectable className="font-mono text-sm text-foreground-muted">
                    {JSON.stringify(settings, null, 2)}
                  </Text>
                </View>
              ))}
              {Object.keys(state.providerSettings[driver] ?? {}).length === 0 ? (
                <Text className="text-sm text-foreground-muted">Provider default only</Text>
              ) : null}
            </View>
          ))}
        </View>
      </SettingsSection>
      <SettingsSection title="Prompts" footer="Edit on web or desktop">
        <View className="gap-3 p-4">
          {state.prompts.length === 0 ? (
            <Text className="text-foreground-muted">No prompts</Text>
          ) : null}
          {state.prompts.map((prompt) => (
            <View key={prompt.name} className="gap-1">
              <Text className="font-t3-medium text-foreground">{prompt.name}</Text>
              <Text selectable className="text-sm text-foreground-muted">
                {prompt.content}
              </Text>
            </View>
          ))}
        </View>
      </SettingsSection>
      <ProfileSkillsSettings environmentId={environmentId} state={state} />
    </>
  );
}
