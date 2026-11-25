import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import {
  folderName,
  pullToast,
  repositoryBadges,
  tildePath,
} from "@t3tools/client-runtime/sandboxes/manifest-folders";
import {
  canDeleteSandbox,
  canStartSandbox,
  canStopSandbox,
  sandboxSpecLine,
  sandboxStatus,
  sandboxStatusDetail,
  sandboxThreadSummary,
} from "@t3tools/client-runtime/sandboxes/presentation";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { HostedSandbox, SandboxHost } from "@t3tools/client-runtime/state/sandboxes";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import type { AgentctlManifestRoot, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { StatusPill } from "../../components/StatusPill";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { uuidv4 } from "../../lib/uuid";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentPresentation } from "../../state/presentation";
import { sandboxEnvironment } from "../../state/sandboxes";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { promptManifestFolder } from "./manifestFolderPrompt";
import { deleteSandbox, runOnHost, startSandbox, stopSandbox } from "./sandboxActions";
import { SANDBOX_TONE_CLASSES, sandboxHostMenu } from "./sandboxHostMenu";
import {
  useDefaultSandboxHost,
  useSandboxHostOptions,
  useSandboxHosts,
  type SandboxHostOption,
} from "./useSandboxes";

// The most recent threads each Sandbox lists; the thread list has the rest.
const RECENT_THREADS = 3;

/**
 * Manages one host's agentctl Sandboxes and where new ones come from. The bar picks the host, so
 * Sandboxes of the same name on two machines stay apart.
 */
export function SettingsSandboxesRouteScreen({
  route,
}: StaticScreenProps<{ readonly host?: string } | undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const hosts = useSandboxHosts();
  const options = useSandboxHostOptions();
  const defaultHost = useDefaultSandboxHost();
  const { isReady, environments } = useEnvironments();
  // A host's list arrives after its connection, so until then there may be one on its way.
  const lookingForHosts =
    !isReady ||
    environments.some(
      (environment) =>
        environment.connection.phase === "connecting" ||
        environment.serverConfig?.agentctlSandboxes === true,
    );
  const host =
    hosts.find((candidate) => candidate.hostEnvironmentId === route.params?.host) ??
    hosts.find((candidate) => candidate.hostEnvironmentId === defaultHost) ??
    null;
  const option = options.find(
    (candidate) => candidate.hostEnvironmentId === host?.hostEnvironmentId,
  );
  const hostMenu = sandboxHostMenu(options, host?.hostEnvironmentId ?? null, (next) =>
    navigation.setParams({ host: next }),
  );
  const createHost =
    host !== null && option?.offline !== true && host.snapshot.status === "available"
      ? host.hostEnvironmentId
      : null;

  return (
    <SettingsScreen
      title="Sandboxes"
      menus={hostMenu === null ? undefined : [hostMenu]}
      actions={
        createHost === null
          ? undefined
          : [
              {
                accessibilityLabel: "New Sandbox",
                icon: "plus",
                onPress: () => navigation.navigate("SettingsSandboxNew", { host: createHost }),
              },
            ]
      }
    >
      <ScrollView
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {host === null ? (
          <EmptyState
            variant="plain"
            title={lookingForHosts ? "Looking for Sandboxes…" : "No Sandboxes"}
            detail={
              lookingForHosts
                ? "Sandboxes appear once their host connects."
                : "No connected environment manages agentctl Sandboxes."
            }
          />
        ) : (
          <HostSandboxes key={host.hostEnvironmentId} host={host} option={option ?? null} />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function InfoRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly separated?: boolean;
}) {
  return (
    <View className={props.separated ? "border-t border-border-subtle" : undefined}>
      <ListRowLayout label={props.label} description={props.description} />
    </View>
  );
}

/** One host's Sandboxes and manifest folders. */
function HostSandboxes(props: {
  readonly host: SandboxHost;
  readonly option: SandboxHostOption | null;
}) {
  const { snapshot, hostEnvironmentId } = props.host;
  const hostLabel = props.option?.label ?? "This host";
  // An offline host's list is as it last reported it, and nothing can act on it until it is back.
  const offline = props.option?.offline === true;
  if (snapshot.status === "unavailable") {
    return (
      <SettingsSection title={`On ${hostLabel}`}>
        <InfoRow
          label="agentctl is not available"
          description={snapshot.error ?? "Install agentctl to run agents in Sandboxes."}
        />
      </SettingsSection>
    );
  }
  if (snapshot.status === "loading") {
    return <EmptyState variant="plain" title="Looking for Sandboxes…" detail={hostLabel} />;
  }
  return (
    <>
      <SettingsSection title={`On ${hostLabel}`}>
        {offline ? (
          <InfoRow
            label={`${hostLabel} is offline`}
            description="Its Sandboxes are shown as it last reported them. Reconnect to it to manage them."
          />
        ) : null}
        {snapshot.error !== null ? (
          // The Sandboxes below are as agentctl last reported them.
          <InfoRow
            label="agentctl is not responding"
            description={snapshot.error}
            separated={offline}
          />
        ) : null}
        {snapshot.sandboxes.length === 0 ? (
          <InfoRow
            label="No Sandboxes"
            description="Create one from a manifest with +, or with agentctl apply."
            separated={offline || snapshot.error !== null}
          />
        ) : (
          snapshot.sandboxes.map((sandbox, index) => (
            <SandboxRow
              key={sandbox.name}
              sandbox={{ ...sandbox, hostEnvironmentId }}
              homeDirectory={snapshot.homeDirectory}
              hostOffline={offline}
              separated={index > 0 || offline || snapshot.error !== null}
            />
          ))
        )}
      </SettingsSection>
      {/* An offline host can neither list nor change its manifest folders. */}
      {offline ? null : (
        <ManifestFolders
          hostEnvironmentId={hostEnvironmentId}
          hostLabel={hostLabel}
          homeDirectory={snapshot.homeDirectory}
        />
      )}
    </>
  );
}

function SandboxRow(props: {
  readonly sandbox: HostedSandbox;
  readonly homeDirectory: string;
  readonly hostOffline: boolean;
  readonly separated: boolean;
}) {
  const { sandbox, hostOffline } = props;
  const environmentId = sandbox.environmentId;
  const { presentation } = useEnvironmentPresentation(environmentId);
  const projects = useProjects();
  const allThreads = useThreadShells();
  const selectDetail = useSelectWorkspaceDetail();
  const threads = sortThreads(
    allThreads.filter(
      (thread) => thread.environmentId === environmentId && thread.archivedAt === null,
    ),
    "updated_at",
  );
  const running = threads.filter((thread) => threadRuntimeIsActive(thread.runtime)).length;
  const project =
    environmentId === null
      ? null
      : (projects.find((candidate) => candidate.environmentId === environmentId) ?? null);
  const status = sandboxStatus(sandbox);
  const detail = sandboxStatusDetail(sandbox);
  // An offline host's notice says why its Sandboxes cannot be reached.
  const connection =
    !hostOffline && sandbox.phase === "ready" && presentation !== null
      ? connectionStatusText(presentation.connection)
      : null;
  const spec = sandboxSpecLine(sandbox);
  // agentctl reports a restarted Sandbox ready before its relay answers; a thread waits for both.
  const canNewThread =
    !hostOffline &&
    project !== null &&
    sandbox.phase === "ready" &&
    sandbox.action === null &&
    presentation?.connection.phase === "connected";
  const canStart = !hostOffline && canStartSandbox(sandbox);
  const canStop = !hostOffline && canStopSandbox(sandbox);
  const canDelete = !hostOffline && canDeleteSandbox(sandbox);
  const newThread = () => {
    if (project === null) return;
    selectDetail({
      name: "Thread",
      params: {
        draft: {
          requestId: uuidv4(),
          environmentId: project.environmentId,
          projectId: project.id,
          title: project.title,
        },
      },
    });
  };
  const actions: MenuAction[] = [
    ...(canNewThread ? [{ id: "new-thread", title: "New thread", image: "plus.bubble" }] : []),
    ...(canStart ? [{ id: "start", title: "Start", image: "play" }] : []),
    ...(canStop ? [{ id: "stop", title: "Stop", image: "stop.fill" }] : []),
    ...(canDelete
      ? [
          {
            id: "delete",
            title: "Delete",
            image: "trash",
            attributes: { destructive: true },
          } satisfies MenuAction,
        ]
      : []),
  ];

  return (
    <View className={props.separated ? "border-t border-border-subtle" : undefined}>
      <View className="flex-row items-start gap-3 px-4 py-3">
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text textRole="body" className="shrink text-foreground" numberOfLines={1}>
              {sandbox.name}
            </Text>
            <StatusPill
              size="compact"
              label={status.label}
              {...SANDBOX_TONE_CLASSES[status.tone]}
            />
            {sandbox.variant ? (
              <Text textRole="caption" className="text-foreground-muted">
                {sandbox.variant}
              </Text>
            ) : null}
          </View>
          {detail || connection || sandbox.since ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {[detail, connection].filter((part) => part !== null && part !== "").join(" · ")}
              {sandbox.since ? (
                <>
                  {detail || connection ? " · " : ""}
                  Changed <RelativeTime timestamp={sandbox.since} /> ago
                </>
              ) : null}
            </Text>
          ) : null}
          {spec ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {spec}
            </Text>
          ) : null}
          {sandbox.manifestPath ? (
            <Text
              textRole="caption"
              className="font-mono text-foreground-muted"
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {tildePath(sandbox.manifestPath, props.homeDirectory)}
            </Text>
          ) : null}
          <Text textRole="footnote" className="text-foreground-muted">
            {sandboxThreadSummary(threads.length, running)}
          </Text>
          {threads.slice(0, RECENT_THREADS).map((thread) => (
            <Pressable
              key={thread.id}
              accessibilityRole="link"
              accessibilityLabel={`Open ${thread.title}`}
              hitSlop={4}
              onPress={() =>
                selectDetail({
                  name: "Thread",
                  params: {
                    environmentId: String(thread.environmentId),
                    threadId: String(thread.id),
                  },
                })
              }
              className="active:opacity-70"
            >
              <Text textRole="footnote" className="text-primary-text" numberOfLines={1}>
                {thread.title || "Untitled thread"}
              </Text>
            </Pressable>
          ))}
        </View>
        <View className="flex-row items-center gap-2">
          {canNewThread ? (
            <ControlPill variant="primary" label="New thread" onPress={newThread} />
          ) : canStart ? (
            <ControlPill variant="pill" label="Start" onPress={() => void startSandbox(sandbox)} />
          ) : null}
          {actions.length > 0 ? (
            <Menu
              accessible
              accessibilityRole="button"
              accessibilityLabel={`${sandbox.name} actions`}
              title={sandbox.name}
              actions={actions}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "new-thread") newThread();
                else if (nativeEvent.event === "start") void startSandbox(sandbox);
                else if (nativeEvent.event === "stop") void stopSandbox(sandbox);
                else if (nativeEvent.event === "delete") void deleteSandbox(sandbox);
              }}
            >
              <ControlPill icon="ellipsis" accessibilityLabel={`${sandbox.name} actions`} />
            </Menu>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** Where New Sandbox looks for manifests, and whether their repositories are current. */
function ManifestFolders(props: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly hostLabel: string;
  readonly homeDirectory: string;
}) {
  const { hostEnvironmentId } = props;
  const [roots, setRoots] = useState<ReadonlyArray<AgentctlManifestRoot> | null>(null);
  // The folders being pulled, so their rows show it and nothing pulls twice.
  const [pulling, setPulling] = useState<ReadonlyArray<string>>([]);
  // Bumped by every read, so a slow fetch cannot overwrite a newer add or remove.
  const generation = useRef(0);
  const readRoots = (command: typeof sandboxEnvironment.listManifestRoots) =>
    runOnHost(command, hostEnvironmentId, {}).then((outcome) =>
      "error" in outcome ? null : outcome.value,
    );
  const reload = () => {
    const current = ++generation.current;
    return readRoots(sandboxEnvironment.listManifestRoots).then((next) => {
      if (next !== null && generation.current === current) setRoots(next);
    });
  };

  const loadInitial = useEffectEvent(() => {
    // Local state first, then again once each repository has fetched; the fetch
    // is ignored if the list changed meanwhile or the screen closed.
    void readRoots(sandboxEnvironment.listManifestRoots).then((next) =>
      setRoots((current) => current ?? next),
    );
    const current = ++generation.current;
    void readRoots(sandboxEnvironment.refreshManifestRoots).then((next) => {
      if (next !== null && generation.current === current) setRoots(next);
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- host RPC: reads manifest folders while mounted, and drops a fetch that ends after unmount
  useEffect(() => {
    loadInitial();
    return () => {
      generation.current += 1;
    };
  }, []);

  if (roots === null) return null;
  const addRoot = async (folder: string) => {
    const added = await runOnHost(sandboxEnvironment.addManifestRoot, hostEnvironmentId, {
      folder,
    });
    if ("error" in added) Dialog.alert("Could not add folder", added.error);
    await reload();
  };
  const removeRoot = async (folder: string) => {
    await runOnHost(sandboxEnvironment.removeManifestRoot, hostEnvironmentId, { folder });
    await reload();
  };
  const pullRoots = async (folders: ReadonlyArray<string>) => {
    if (pulling.length > 0) return;
    setPulling(folders);
    const pulled = await runOnHost(sandboxEnvironment.pullManifestRoots, hostEnvironmentId, {
      folders,
    });
    const result =
      "error" in pulled
        ? { title: "Could not pull repositories", description: pulled.error }
        : pullToast(pulled.value);
    Dialog.alert(result.title, result.description);
    await reload();
    setPulling([]);
  };
  const pullable = roots
    .filter((root) => root.repositories.length > 0)
    .map((root) => root.directory);

  return (
    <SettingsSection
      title="Manifest folders"
      trailing={
        pullable.length > 1 ? (
          <ControlPill
            variant="pill"
            label={pulling.length > 1 ? "Pulling…" : "Pull all"}
            disabled={pulling.length > 0}
            onPress={() => void pullRoots(pullable)}
          />
        ) : undefined
      }
    >
      {roots.length === 0 ? (
        <InfoRow
          label="No folders yet"
          description="New Sandbox finds every agent.yaml and agent.<variant>.yaml in these folders."
        />
      ) : (
        roots.map((root, index) => (
          <ManifestFolderRow
            key={root.directory}
            root={root}
            homeDirectory={props.homeDirectory}
            separated={index > 0}
            pulling={pulling.includes(root.directory)}
            busy={pulling.length > 0}
            onPull={() => void pullRoots([root.directory])}
            onRemove={() => void removeRoot(root.directory)}
          />
        ))
      )}
      <View className="border-t border-border-subtle">
        <ListActionRow
          icon="folder.badge.plus"
          label="Add folder"
          onPress={() => promptManifestFolder(props.hostLabel, (folder) => void addRoot(folder))}
        />
      </View>
    </SettingsSection>
  );
}

function ManifestFolderRow(props: {
  readonly root: AgentctlManifestRoot;
  readonly homeDirectory: string;
  readonly separated: boolean;
  readonly pulling: boolean;
  readonly busy: boolean;
  readonly onPull: () => void;
  readonly onRemove: () => void;
}) {
  const { root } = props;
  const path = tildePath(root.directory, props.homeDirectory);
  const actions: MenuAction[] = [
    ...(root.repositories.length > 0
      ? [
          {
            id: "pull",
            title: props.pulling ? "Pulling…" : "Pull",
            image: "arrow.down.circle",
            attributes: { disabled: props.busy },
          } satisfies MenuAction,
        ]
      : []),
    {
      id: "remove",
      title: "Remove",
      image: "trash",
      attributes: { destructive: true, disabled: props.pulling },
    },
  ];
  return (
    <View className={props.separated ? "border-t border-border-subtle" : undefined}>
      <View className="flex-row items-start gap-3 px-4 py-3">
        <View className="size-6 items-center justify-center">
          <SymbolView
            name={root.repositories.length > 0 ? "arrow.triangle.branch" : "folder"}
            size={18}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Text textRole="body" className="shrink text-foreground" numberOfLines={1}>
              {folderName(root.directory)}
            </Text>
            {!root.exists ? (
              <StatusPill size="compact" label="Not found" {...SANDBOX_TONE_CLASSES.error} />
            ) : root.manifests === 0 ? (
              <StatusPill size="compact" label="No manifests" {...SANDBOX_TONE_CLASSES.warning} />
            ) : (
              <Text textRole="caption" className="text-foreground-muted">
                {root.manifests} {root.manifests === 1 ? "manifest" : "manifests"}
              </Text>
            )}
          </View>
          <Text textRole="caption" selectable className="font-mono text-foreground-muted">
            {path}
          </Text>
          {root.repositories.map((repository) => (
            <View key={repository.path} className="flex-row flex-wrap items-center gap-1.5">
              {/* Name the checkout when it is not the folder itself. */}
              {repository.path !== root.directory && root.repositories.length > 1 ? (
                <Text textRole="caption" className="font-t3-medium text-foreground">
                  {folderName(repository.path)}
                </Text>
              ) : null}
              <Text textRole="caption" className="text-foreground-muted">
                {repository.branch ?? "detached"}
              </Text>
              {repositoryBadges(repository).map((badge) => {
                const pill = (
                  <StatusPill
                    size="compact"
                    label={badge.label}
                    {...SANDBOX_TONE_CLASSES[badge.tone]}
                  />
                );
                const title = badge.title;
                // A badge's explanation, such as git's fetch error, is a tap away.
                return title === undefined ? (
                  <View key={badge.label}>{pill}</View>
                ) : (
                  <Pressable
                    key={badge.label}
                    accessibilityRole="button"
                    accessibilityHint={title}
                    onPress={() => Dialog.alert(badge.label, title)}
                    className="active:opacity-70"
                  >
                    {pill}
                  </Pressable>
                );
              })}
            </View>
          ))}
          {props.pulling ? (
            <Text textRole="caption" className="text-foreground-muted">
              Pulling…
            </Text>
          ) : null}
        </View>
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${path} actions`}
          title={path}
          actions={actions}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "pull" && !props.busy) props.onPull();
            else if (nativeEvent.event === "remove" && !props.pulling) props.onRemove();
          }}
        >
          <ControlPill icon="ellipsis" accessibilityLabel={`${path} actions`} />
        </Menu>
      </View>
    </View>
  );
}
