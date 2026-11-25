import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  filterManifestRepositories,
  groupManifests,
  manifestRelativePath,
  pickAgentManifest,
  type ManifestAgent,
} from "@t3tools/client-runtime/sandboxes/manifest-agents";
import { tildePath } from "@t3tools/client-runtime/sandboxes/manifest-folders";
import { suggestSandboxName } from "@t3tools/client-runtime/sandboxes/presentation";
import type {
  AgentctlSandboxManifest,
  AgentctlSandboxSettings,
  EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { sandboxEnvironment } from "../../state/sandboxes";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { promptManifestFolder } from "./manifestFolderPrompt";
import { runOnHost } from "./sandboxActions";
import { sandboxHostMenu } from "./sandboxHostMenu";
import { useDefaultSandboxHost, useSandboxHostOptions, useSandboxHosts } from "./useSandboxes";

/**
 * Applies an agentctl manifest on a host, as `agentctl apply` does. Opened from the Sandboxes
 * screen, Add project or the command palette; without a host it uses the first that can reach
 * agentctl.
 */
export function SettingsSandboxNewRouteScreen({
  route,
}: StaticScreenProps<{ readonly host?: string } | undefined>) {
  const navigation = useNavigation();
  const hosts = useSandboxHosts();
  const options = useSandboxHostOptions();
  const defaultHost = useDefaultSandboxHost();
  const [query, setQuery] = useState("");
  const hostEnvironmentId =
    hosts.find((host) => host.hostEnvironmentId === route.params?.host)?.hostEnvironmentId ??
    defaultHost;
  const option = options.find((candidate) => candidate.hostEnvironmentId === hostEnvironmentId);
  const hostMenu = sandboxHostMenu(options, hostEnvironmentId, (next) =>
    navigation.setParams({ host: next }),
  );

  return (
    <SettingsScreen
      title="New Sandbox"
      menus={hostMenu === null ? undefined : [hostMenu]}
      search={{ value: query, onChangeText: setQuery, placeholder: "Search agents and variants" }}
    >
      {hostEnvironmentId === null || option?.offline === true ? (
        <EmptyState
          variant="plain"
          title="No host available"
          detail="Connect to an environment that manages agentctl Sandboxes."
        />
      ) : (
        // Another host has its own manifests and Sandboxes, so its form starts over.
        <NewSandboxForm
          key={hostEnvironmentId}
          hostEnvironmentId={hostEnvironmentId}
          hostLabel={option?.label ?? "this host"}
          query={query}
        />
      )}
    </SettingsScreen>
  );
}

/** Its name where that says more than its folder, and how many variants it has. */
function agentDescription(agent: ManifestAgent): string | undefined {
  const parts = [
    agent.agentName !== null && agent.agentName !== agent.label ? agent.agentName : null,
    agent.manifests.length > 1 ? `${agent.manifests.length} variants` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function NewSandboxForm(props: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly hostLabel: string;
  readonly query: string;
}) {
  const { hostEnvironmentId } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const sandboxes = useAtomValue(sandboxEnvironment.sandboxesAtom).filter(
    (sandbox) => sandbox.hostEnvironmentId === hostEnvironmentId,
  );
  const homeDirectory =
    useSandboxHosts().find((host) => host.hostEnvironmentId === hostEnvironmentId)?.snapshot
      .homeDirectory ?? "";
  const [manifests, setManifests] = useState<ReadonlyArray<AgentctlSandboxManifest> | null>(null);
  const [settings, setSettings] = useState<AgentctlSandboxSettings | null>(null);
  const [manifestPath, setManifestPath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cleared when the form closes or moves to another host, so a late create does not navigate.
  const open = useRef(true);

  const apply = (
    nextManifests: ReadonlyArray<AgentctlSandboxManifest>,
    nextSettings: AgentctlSandboxSettings,
  ) => {
    setManifests(nextManifests);
    setSettings(nextSettings);
    // The manifest of the last Sandbox comes first, so "another one" is one tap.
    setManifestPath(
      (current) =>
        current ??
        nextManifests.find((candidate) => candidate.path === nextSettings.lastManifestPath)?.path ??
        nextManifests[0]?.path ??
        null,
    );
  };
  const load = () =>
    Promise.all([
      runOnHost(sandboxEnvironment.listManifests, hostEnvironmentId, {}),
      runOnHost(sandboxEnvironment.getSettings, hostEnvironmentId, {}),
    ]).then(([listed, read]) => {
      if ("error" in listed || "error" in read) {
        setError("error" in listed ? listed.error : "error" in read ? read.error : null);
        return null;
      }
      return [listed.value, read.value] as const;
    });

  const loadInitial = useEffectEvent(() => {
    void load().then((loaded) => {
      if (loaded !== null && open.current) apply(...loaded);
    });
  });
  // Loads once when the form opens; adding a folder reloads explicitly.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- host RPC: reads manifests while open, and drops a read that ends after close
  useEffect(() => {
    open.current = true;
    loadInitial();
    return () => {
      open.current = false;
    };
  }, []);

  const repositories = groupManifests(manifests ?? []);
  const filtered = filterManifestRepositories(repositories, props.query);
  const manifest = manifests?.find((candidate) => candidate.path === manifestPath) ?? null;
  const repository = repositories.find((candidate) =>
    candidate.agents.some((agent) => agent.directory === manifest?.directory),
  );
  const agent = repository?.agents.find((candidate) => candidate.directory === manifest?.directory);
  const suggestedName = manifest === null ? "" : suggestSandboxName(manifest.agentName, sandboxes);
  const effectiveName = nameEdited ? name : suggestedName;

  const pick = (directory: string) => {
    const picked = repositories
      .flatMap((candidate) => candidate.agents)
      .find((candidate) => candidate.directory === directory);
    const next = picked && pickAgentManifest(picked, props.query, manifest?.variant ?? null);
    if (next) setManifestPath(next.path);
  };

  const addManifestRoot = async (folder: string) => {
    const added = await runOnHost(sandboxEnvironment.addManifestRoot, hostEnvironmentId, {
      folder,
    });
    if ("error" in added) {
      setError(added.error);
      return;
    }
    const loaded = await load();
    if (loaded !== null && open.current) apply(...loaded);
  };
  const addFolderRow = (
    <ListActionRow
      icon="folder.badge.plus"
      label="Add manifest folder"
      description={
        settings !== null && settings.manifestRoots.length === 0
          ? "Choose a folder with agentctl manifests, such as a repository with an agents folder."
          : undefined
      }
      onPress={() =>
        promptManifestFolder(props.hostLabel, (folder) => void addManifestRoot(folder))
      }
    />
  );

  const create = async () => {
    if (manifest === null || submitting) return;
    setSubmitting(true);
    setError(null);
    const sandboxName = effectiveName.trim();
    const created = await runOnHost(sandboxEnvironment.create, hostEnvironmentId, {
      manifestPath: manifest.path,
      name: sandboxName,
    });
    setSubmitting(false);
    const failure = "error" in created ? created.error : created.value.error;
    if (failure !== null) {
      setError(failure);
      return;
    }
    // The Sandboxes screen shows its progress from here, and New thread once it is ready.
    if (open.current) {
      navigation.dispatch(StackActions.popTo("SettingsSandboxes", { host: hostEnvironmentId }));
    }
  };

  const errorText = error ? (
    <Text selectable accessibilityRole="alert" className="text-danger-foreground">
      {error}
    </Text>
  ) : null;

  return (
    <ScrollView
      alwaysBounceVertical
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-4 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      {settings !== null && settings.manifestRoots.length === 0 ? (
        // Without a manifest folder there is nothing to choose from yet, so that comes first.
        <>
          <SettingsSection
            title={`On ${props.hostLabel}`}
            footer="T3 Code finds every agent.yaml and agent.<variant>.yaml in it."
          >
            {addFolderRow}
          </SettingsSection>
          {errorText}
        </>
      ) : (
        <>
          <SettingsSection
            title={`On ${props.hostLabel}`}
            footer="Applies an agentctl manifest and connects to the Sandbox when it is ready."
          >
            <ListRowLayout
              icon="cube"
              label={
                repository && agent
                  ? [repository.name, ...agent.label.split("/")].join(" / ")
                  : manifests === null
                    ? "Looking for manifests…"
                    : "Choose an agent below"
              }
              description={manifest === null ? undefined : manifestRelativePath(manifest)}
            />
            {manifest !== null && agent !== undefined && agent.manifests.length > 1 ? (
              <View className="flex-row flex-wrap gap-2 border-t border-border-subtle px-4 py-3">
                {agent.manifests.map((candidate) => (
                  <Chip
                    key={candidate.path}
                    label={candidate.variant ?? "default"}
                    accessibilityLabel={`Variant ${candidate.variant ?? "default"}`}
                    selected={candidate.path === manifest.path}
                    onPress={() => setManifestPath(candidate.path)}
                  />
                ))}
              </View>
            ) : null}
            <View className="gap-2 border-t border-border-subtle px-4 py-3">
              <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
                Name
              </Text>
              <AppTextInput
                accessibilityLabel="Sandbox name"
                value={effectiveName}
                onChangeText={(next) => {
                  setNameEdited(true);
                  setName(next);
                }}
                onSubmitEditing={() => void create()}
                returnKeyType="go"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                editable={!submitting}
              />
            </View>
          </SettingsSection>
          {errorText}
          <Button
            tone="primary"
            fullWidth
            label={submitting ? "Applying…" : "Create Sandbox"}
            loading={submitting}
            disabled={manifest === null || effectiveName.trim() === ""}
            onPress={() => void create()}
          />
          {manifests !== null && manifests.length === 0 ? (
            <EmptyState
              variant="plain"
              title="No manifests"
              detail={`No agent.yaml manifests in ${settings?.manifestRoots.join(", ") ?? "the manifest folders"}.`}
            />
          ) : manifests !== null && filtered.length === 0 ? (
            <EmptyState variant="plain" title="No agent matches" detail={props.query.trim()} />
          ) : (
            filtered.map((group) => (
              <SettingsSection
                key={group.path}
                title={group.name}
                footer={tildePath(group.path, homeDirectory)}
              >
                {group.agents.map((candidate, index) => (
                  <ListChoiceRow
                    key={candidate.directory}
                    label={candidate.label.split("/").join(" / ")}
                    description={agentDescription(candidate)}
                    selected={candidate.directory === manifest?.directory}
                    separated={index > 0}
                    onPress={() => pick(candidate.directory)}
                  />
                ))}
              </SettingsSection>
            ))
          )}
          <SettingsSection>{addFolderRow}</SettingsSection>
        </>
      )}
    </ScrollView>
  );
}
