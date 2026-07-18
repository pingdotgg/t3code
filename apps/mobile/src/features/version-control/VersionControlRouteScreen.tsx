import type {
  VcsPanelBranchDetails,
  VcsPanelFileChange,
  VcsPanelStashDetails,
  VcsPanelSnapshotResult,
  VcsRef,
} from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import {
  panelBranchOperationCwd,
  panelBranchSyncCounts,
  panelBranchSyncState,
  type PanelChangedFile,
} from "@t3tools/shared/sourceControl";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text as NativeText,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { vcsEnvironment } from "../../state/vcs";
import { SheetActionButton } from "../threads/git/gitSheetComponents";
import {
  actionableLocalBranches,
  branchSyncLabel,
  fileStatusLetter,
  operationPaths,
  panelChangeSets,
  selectedFileStats,
  type VersionControlChangeSet,
} from "./versionControlModel";
import {
  VersionControlCommandInterrupted,
  useVersionControlPanelApi,
} from "./useVersionControlPanelApi";

type VersionControlRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

type FileDiffState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly patch: string }
  | { readonly status: "error"; readonly message: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "The Version Control operation failed.";
}

function relativeLabel(value: string | null | undefined): string | null {
  return value ? relativeTime(value) : null;
}

function ActionButton(props: {
  readonly label: string;
  readonly icon: React.ComponentProps<typeof SymbolView>["name"];
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor(props.danger ? "--color-danger-foreground" : "--color-icon");
  return (
    <Pressable
      className={cn(
        "min-h-9 flex-row items-center gap-1.5 rounded-full border px-3 py-2 disabled:opacity-[0.4]",
        props.danger ? "border-danger-border bg-danger" : "border-border bg-subtle",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={13} tintColor={iconColor} type="monochrome" />
      <Text
        className={cn(
          "text-xs font-t3-bold",
          props.danger ? "text-danger-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function ChangeCounts(props: { readonly insertions: number; readonly deletions: number }) {
  if (props.insertions === 0 && props.deletions === 0) return null;
  return (
    <View className="flex-row items-center gap-1.5">
      {props.insertions > 0 ? (
        <Text className="text-xs font-t3-bold text-emerald-500">+{props.insertions}</Text>
      ) : null}
      {props.deletions > 0 ? (
        <Text className="text-xs font-t3-bold text-rose-500">-{props.deletions}</Text>
      ) : null}
    </View>
  );
}

function SectionHeader(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly action?: React.ReactNode;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  return (
    <View className="flex-row items-center gap-2 px-1">
      <Pressable className="min-h-10 flex-1 flex-row items-center gap-2" onPress={props.onToggle}>
        <SymbolView
          name={props.expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColor={iconColor}
          type="monochrome"
        />
        <Text className="text-xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs font-medium text-foreground-muted">{props.subtitle}</Text>
        ) : null}
      </Pressable>
      {props.action}
    </View>
  );
}

function PatchPreview(props: { readonly state: FileDiffState }) {
  if (props.state.status === "loading") {
    return <Text className="px-3 pb-3 text-xs text-foreground-muted">Loading diff…</Text>;
  }
  if (props.state.status === "error") {
    return <Text className="px-3 pb-3 text-xs text-danger-foreground">{props.state.message}</Text>;
  }
  const lines = props.state.patch.split("\n");
  const visible = lines.slice(0, 180);
  return (
    <View className="mx-3 mb-3 overflow-hidden rounded-xl border border-border bg-screen">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <NativeText
          selectable
          style={{
            fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
            fontSize: 11,
            lineHeight: 17,
            paddingHorizontal: 12,
            paddingVertical: 10,
          }}
          className="text-foreground"
        >
          {visible.join("\n") || "No textual diff available."}
        </NativeText>
      </ScrollView>
      {lines.length > visible.length ? (
        <Text className="border-t border-border px-3 py-2 text-2xs text-foreground-muted">
          Showing the first {visible.length} of {lines.length} lines
        </Text>
      ) : null}
    </View>
  );
}

function FileRow(props: {
  readonly file: PanelChangedFile;
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly diffState?: FileDiffState;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
  readonly onToggleDiff: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  return (
    <View className="border-t border-border/70">
      <View className="min-h-12 flex-row items-center gap-2 px-3 py-2">
        <Pressable
          accessibilityLabel={
            props.selected ? `Unselect ${props.file.path}` : `Select ${props.file.path}`
          }
          className="h-8 w-8 items-center justify-center"
          disabled={props.disabled}
          onPress={props.onSelect}
        >
          <SymbolView
            name={props.selected ? "checkmark.circle" : "circle"}
            size={18}
            tintColor={iconColor}
            type="monochrome"
          />
        </Pressable>
        <Pressable
          className="min-w-0 flex-1 flex-row items-center gap-2"
          disabled={props.disabled}
          onPress={props.onToggleDiff}
        >
          <Text className="w-4 text-center text-xs font-t3-bold text-foreground-muted">
            {fileStatusLetter(props.file.status)}
          </Text>
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
              {props.file.path}
            </Text>
            {props.file.originalPath ? (
              <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                from {props.file.originalPath}
              </Text>
            ) : null}
          </View>
          <ChangeCounts insertions={props.file.insertions} deletions={props.file.deletions} />
          <SymbolView
            name={props.expanded ? "chevron.down" : "chevron.right"}
            size={11}
            tintColor={iconColor}
            type="monochrome"
          />
        </Pressable>
      </View>
      {props.expanded && props.diffState ? <PatchPreview state={props.diffState} /> : null}
    </View>
  );
}

function PlainFileRow(props: { readonly file: VcsPanelFileChange }) {
  return (
    <View className="flex-row items-center gap-2 border-t border-border/70 px-4 py-2.5">
      <Text className="w-4 text-center text-xs font-t3-bold text-foreground-muted">
        {fileStatusLetter(props.file.status)}
      </Text>
      <Text className="min-w-0 flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
        {props.file.path}
      </Text>
      <ChangeCounts insertions={props.file.insertions} deletions={props.file.deletions} />
    </View>
  );
}

function RepositorySummary(props: { readonly snapshot: VcsPanelSnapshotResult }) {
  const status = props.snapshot.status;
  const fileCount = panelChangeSets(props.snapshot, "__summary__").find(
    (changeSet) => changeSet.current,
  )?.files.length;
  return (
    <View className="gap-3 rounded-[22px] border border-border bg-card px-4 py-4">
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-2xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
            Repository
          </Text>
          <Text className="text-xl font-t3-bold text-foreground" numberOfLines={1}>
            {status.refName ?? "Detached HEAD"}
          </Text>
        </View>
        <View className="rounded-full bg-subtle px-3 py-1.5">
          <Text className="text-xs font-t3-bold text-foreground-secondary">
            {status.hasWorkingTreeChanges ? `${fileCount ?? 0} changed` : "Clean"}
          </Text>
        </View>
      </View>
      <View className="flex-row flex-wrap gap-x-3 gap-y-1">
        {status.aheadCount > 0 ? (
          <Text className="text-xs font-t3-bold text-emerald-500">↑{status.aheadCount} ahead</Text>
        ) : null}
        {status.behindCount > 0 ? (
          <Text className="text-xs font-t3-bold text-amber-500">↓{status.behindCount} behind</Text>
        ) : null}
        {(status.aheadOfDefaultCount ?? 0) > 0 ? (
          <Text className="text-xs font-medium text-foreground-muted">
            {status.aheadOfDefaultCount} ahead of default
          </Text>
        ) : null}
        {status.hasUpstream ? (
          <Text className="text-xs font-medium text-foreground-muted">Tracking upstream</Text>
        ) : (
          <Text className="text-xs font-medium text-foreground-muted">Not published</Text>
        )}
      </View>
    </View>
  );
}

export function VersionControlRouteScreen(props: VersionControlRouteScreenProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitActions = useSelectedThreadGitActions();
  const api = useVersionControlPanelApi(environmentId);
  const statusQuery = useEnvironmentQuery(
    selectedThreadCwd
      ? vcsEnvironment.status({ environmentId, input: { cwd: selectedThreadCwd } })
      : null,
  );

  const [snapshot, setSnapshot] = useState<VcsPanelSnapshotResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionableExpanded, setActionableExpanded] = useState(true);
  const [remotesExpanded, setRemotesExpanded] = useState(false);
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(
    () => new Set(selectedThreadCwd ? [`changes:${selectedThreadCwd}`] : []),
  );
  const [selectedByCwd, setSelectedByCwd] = useState<ReadonlyMap<string, ReadonlySet<string>>>(
    new Map(),
  );
  const knownPathsByCwd = useRef(new Map<string, Set<string>>());
  const initializedChangeSetCwds = useRef(new Set<string>());
  const [diffs, setDiffs] = useState<ReadonlyMap<string, FileDiffState>>(new Map());
  const [branchDetails, setBranchDetails] = useState<ReadonlyMap<string, VcsPanelBranchDetails>>(
    new Map(),
  );
  const [stashDetails, setStashDetails] = useState<ReadonlyMap<string, VcsPanelStashDetails>>(
    new Map(),
  );
  const [showAddRemote, setShowAddRemote] = useState(false);
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const openedCwd = useRef<string | null>(null);
  const snapshotRequestId = useRef(0);
  const snapshotRevision = useRef(0);
  const snapshotFingerprint = useRef<string | null>(null);

  const syncSelections = useCallback((nextSnapshot: VcsPanelSnapshotResult, cwd: string) => {
    const changeSets = panelChangeSets(nextSnapshot, cwd);
    setExpandedRows((current) => {
      const next = new Set(current);
      for (const changeSet of changeSets) {
        if (!initializedChangeSetCwds.current.has(changeSet.cwd)) {
          initializedChangeSetCwds.current.add(changeSet.cwd);
          if (changeSet.current) next.add(`changes:${changeSet.cwd}`);
        }
      }
      return next;
    });
    setSelectedByCwd((current) => {
      const next = new Map(current);
      for (const changeSet of changeSets) {
        const known = knownPathsByCwd.current.get(changeSet.cwd) ?? new Set<string>();
        const visible = new Set(changeSet.files.map((file) => file.path));
        const selected = new Set(next.get(changeSet.cwd) ?? []);
        for (const path of visible) {
          if (!known.has(path)) selected.add(path);
        }
        for (const path of selected) {
          if (!visible.has(path)) selected.delete(path);
        }
        next.set(changeSet.cwd, selected);
        knownPathsByCwd.current.set(changeSet.cwd, visible);
      }
      return next;
    });
  }, []);

  const refreshSnapshot = useCallback(
    async (options: { readonly pull?: boolean } = {}) => {
      const requestId = ++snapshotRequestId.current;
      setRefreshing(options.pull === true);
      if (!selectedThreadCwd) {
        if (requestId === snapshotRequestId.current) {
          setLoading(false);
          setRefreshing(false);
        }
        return;
      }
      try {
        const next = await api.snapshot({ cwd: selectedThreadCwd });
        if (requestId !== snapshotRequestId.current) return;
        const nextFingerprint = `${selectedThreadCwd}\0${JSON.stringify(next)}`;
        if (snapshotFingerprint.current !== nextFingerprint) {
          snapshotFingerprint.current = nextFingerprint;
          snapshotRevision.current += 1;
          setDiffs(new Map());
          setBranchDetails(new Map());
          setStashDetails(new Map());
          setExpandedRows(
            (current) =>
              new Set(
                [...current].filter(
                  (key) =>
                    !key.startsWith("file:") &&
                    !key.startsWith("branch:") &&
                    !key.startsWith("fork:") &&
                    !key.startsWith("stash:"),
                ),
              ),
          );
        }
        setSnapshot(next);
        syncSelections(next, selectedThreadCwd);
        setError(null);
      } catch (cause) {
        if (
          requestId === snapshotRequestId.current &&
          !(cause instanceof VersionControlCommandInterrupted)
        ) {
          setError(errorMessage(cause));
        }
      } finally {
        if (requestId === snapshotRequestId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [api, selectedThreadCwd, syncSelections],
  );

  const runAction = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      setBusyAction(label);
      setError(null);
      try {
        await action();
        statusQuery.refresh();
        await refreshSnapshot();
        return true;
      } catch (cause) {
        if (!(cause instanceof VersionControlCommandInterrupted)) setError(errorMessage(cause));
        return false;
      } finally {
        setBusyAction(null);
      }
    },
    [refreshSnapshot, statusQuery],
  );

  useFocusEffect(
    useCallback(() => {
      if (!selectedThreadCwd) return;
      void refreshSnapshot();
      if (openedCwd.current !== selectedThreadCwd) {
        openedCwd.current = selectedThreadCwd;
        void api
          .fetchAllRemotes({ cwd: selectedThreadCwd })
          .then(() => refreshSnapshot())
          .catch(() => undefined);
      }
    }, [api, refreshSnapshot, selectedThreadCwd]),
  );

  const statusFingerprint = statusQuery.data ? JSON.stringify(statusQuery.data) : null;
  const lastStatusFingerprint = useRef<string | null>(null);
  useEffect(() => {
    if (!statusFingerprint || lastStatusFingerprint.current === statusFingerprint) return;
    const hadStatus = lastStatusFingerprint.current !== null;
    lastStatusFingerprint.current = statusFingerprint;
    if (hadStatus) void refreshSnapshot();
  }, [refreshSnapshot, statusFingerprint]);

  const changeSets = useMemo(
    () => (snapshot && selectedThreadCwd ? panelChangeSets(snapshot, selectedThreadCwd) : []),
    [selectedThreadCwd, snapshot],
  );
  const localBranches = useMemo(
    () => (snapshot ? actionableLocalBranches(snapshot) : []),
    [snapshot],
  );
  const actionCount =
    changeSets.length +
    localBranches.length +
    (snapshot?.actionableForkBranches.length ?? 0) +
    (snapshot?.stashes.length ?? 0);
  const busy = busyAction !== null;
  const headerToolbar = (
    <NativeHeaderToolbar placement="right">
      <NativeHeaderToolbar.Button
        accessibilityLabel="Close Version Control"
        icon="xmark"
        onPress={() => navigation.goBack()}
        separateBackground
      />
    </NativeHeaderToolbar>
  );

  const toggleExpanded = useCallback((key: string) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleFileDiff = useCallback(
    (changeSet: VersionControlChangeSet, file: PanelChangedFile) => {
      const key = `file:${changeSet.cwd}:${file.path}`;
      if (expandedRows.has(key)) {
        toggleExpanded(key);
        return;
      }
      toggleExpanded(key);
      if (diffs.has(key) && diffs.get(key)?.status !== "error") return;
      const revision = snapshotRevision.current;
      setDiffs((current) => new Map(current).set(key, { status: "loading" }));
      void api
        .readFileDiff({
          cwd: changeSet.cwd,
          path: file.path,
          ...(file.originalPath ? { originalPath: file.originalPath } : {}),
          source: { kind: "working-tree", staged: !file.hasUnstagedChanges },
        })
        .then((result) => {
          if (revision !== snapshotRevision.current) return;
          setDiffs((current) =>
            new Map(current).set(key, { status: "loaded", patch: result.patch }),
          );
        })
        .catch((cause) => {
          if (revision !== snapshotRevision.current) return;
          setDiffs((current) =>
            new Map(current).set(key, { status: "error", message: errorMessage(cause) }),
          );
        });
    },
    [api, diffs, expandedRows, toggleExpanded],
  );

  const toggleSelectedFile = useCallback((cwd: string, path: string) => {
    setSelectedByCwd((current) => {
      const next = new Map(current);
      const selected = new Set(next.get(cwd) ?? []);
      if (selected.has(path)) selected.delete(path);
      else selected.add(path);
      next.set(cwd, selected);
      return next;
    });
  }, []);

  const selectAllFiles = useCallback((changeSet: VersionControlChangeSet) => {
    setSelectedByCwd((current) => {
      const next = new Map(current);
      const selected = next.get(changeSet.cwd) ?? new Set();
      next.set(
        changeSet.cwd,
        selected.size === changeSet.files.length
          ? new Set()
          : new Set(changeSet.files.map((file) => file.path)),
      );
      return next;
    });
  }, []);

  const selectedFiles = useCallback(
    (changeSet: VersionControlChangeSet) => {
      const selected = selectedByCwd.get(changeSet.cwd) ?? new Set();
      return changeSet.files.filter((file) => selected.has(file.path));
    },
    [selectedByCwd],
  );

  const commitSelected = useCallback(
    (changeSet: VersionControlChangeSet) => {
      const files = selectedFiles(changeSet);
      const paths = operationPaths(files);
      if (paths.length === 0) return;
      void runAction("commit", async () => {
        await api.stageFiles({ cwd: changeSet.cwd, paths });
        await api.commitStaged({ cwd: changeSet.cwd, paths });
      });
    },
    [api, runAction, selectedFiles],
  );

  const stashSelected = useCallback(
    (changeSet: VersionControlChangeSet) => {
      const files = selectedFiles(changeSet);
      const paths = operationPaths(files);
      if (paths.length === 0) return;
      void runAction("stash", () =>
        api.createStash({ cwd: changeSet.cwd, paths, includeUntracked: true }),
      );
    },
    [api, runAction, selectedFiles],
  );

  const discardSelected = useCallback(
    (changeSet: VersionControlChangeSet) => {
      const files = selectedFiles(changeSet);
      const paths = operationPaths(files);
      if (paths.length === 0) return;
      Alert.alert(
        "Discard selected changes?",
        `This permanently discards changes in ${files.length} selected file${files.length === 1 ? "" : "s"}.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () =>
              void runAction("discard", () => api.discardFiles({ cwd: changeSet.cwd, paths })),
          },
        ],
      );
    },
    [api, runAction, selectedFiles],
  );

  const loadBranchDetails = useCallback(
    (branch: VcsRef, key: string, compareBaseRef?: string) => {
      toggleExpanded(key);
      if (!snapshot || branchDetails.has(key) || expandedRows.has(key)) return;
      const revision = snapshotRevision.current;
      void api
        .branchDetails({
          cwd: selectedThreadCwd ?? "",
          branch,
          defaultCompareRef: snapshot.defaultCompareRef,
          ...(compareBaseRef ? { compareBaseRef } : {}),
        })
        .then((details) => {
          if (revision !== snapshotRevision.current) return;
          setBranchDetails((current) => new Map(current).set(key, details));
        })
        .catch((cause) => {
          if (revision === snapshotRevision.current) setError(errorMessage(cause));
        });
    },
    [api, branchDetails, expandedRows, selectedThreadCwd, snapshot, toggleExpanded],
  );

  const publishBranch = useCallback(
    (branch: VcsRef, targetCwd: string) => {
      if (!snapshot) return;
      const preferredRemote =
        snapshot.remotes.find((remote) => remote.name === "origin") ?? snapshot.remotes[0];
      if (!preferredRemote) {
        setError("Add a remote before publishing this branch.");
        return;
      }
      const publish = () =>
        void runAction("publish", () =>
          api.pushBranch({
            cwd: targetCwd,
            branchName: branch.name,
            remoteName: preferredRemote.name,
          }),
        );
      if (snapshot.remotes.length > 1) {
        Alert.alert("Publish branch?", `Publish ${branch.name} to ${preferredRemote.name}?`, [
          { text: "Cancel", style: "cancel" },
          { text: "Publish", onPress: publish },
        ]);
      } else publish();
    },
    [api, runAction, snapshot],
  );

  const syncBranch = useCallback(
    (branch: VcsRef) => {
      if (!snapshot || !selectedThreadCwd) return;
      const state = panelBranchSyncState(branch, snapshot);
      const targetCwd = panelBranchOperationCwd(branch, selectedThreadCwd);
      if (state === "publish") {
        publishBranch(branch, targetCwd);
        return;
      }
      if (state === "push") {
        void runAction("push", () => api.pushBranch({ cwd: targetCwd, branchName: branch.name }));
        return;
      }
      if (state === "pull") {
        void runAction("pull", () => api.pullBranch({ cwd: targetCwd, branchName: branch.name }));
        return;
      }
      if (state === "fetch") {
        void runAction("fetch", () => api.fetchBranch({ cwd: targetCwd, branchName: branch.name }));
        return;
      }
      Alert.alert("Branch has diverged", "Choose how to synchronize this branch.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Pull & merge",
          onPress: () =>
            void runAction("merge-sync", () =>
              api.pullBranch({ cwd: targetCwd, branchName: branch.name, merge: true }),
            ),
        },
        {
          text: "More…",
          onPress: () =>
            Alert.alert("Destructive sync", "These actions overwrite one side of the branch.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Force pull",
                style: "destructive",
                onPress: () =>
                  void runAction("force-pull", () =>
                    api.pullBranch({ cwd: targetCwd, branchName: branch.name, force: true }),
                  ),
              },
              {
                text: "Force push",
                style: "destructive",
                onPress: () =>
                  void runAction("force-push", () =>
                    api.pushBranch({ cwd: targetCwd, branchName: branch.name, force: true }),
                  ),
              },
            ]),
        },
      ]);
    },
    [api, publishBranch, runAction, selectedThreadCwd, snapshot],
  );

  const switchBranch = useCallback(
    (branch: VcsRef) => {
      void runAction("switch", async () => {
        await gitActions.onCheckoutSelectedThreadBranch(branch.name);
      });
    },
    [gitActions, runAction],
  );

  const deleteBranch = useCallback(
    (branch: VcsRef) => {
      if (!selectedThreadCwd || branch.current) return;
      Alert.alert("Delete branch?", `Delete ${branch.name}?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void runAction("delete-branch", () =>
              api.deleteBranch({ cwd: selectedThreadCwd, branchName: branch.name }),
            ),
        },
      ]);
    },
    [api, runAction, selectedThreadCwd],
  );

  const loadStashDetails = useCallback(
    (stashRef: string) => {
      const key = `stash:${stashRef}`;
      toggleExpanded(key);
      if (!selectedThreadCwd || stashDetails.has(stashRef) || expandedRows.has(key)) return;
      const revision = snapshotRevision.current;
      void api
        .stashDetails({ cwd: selectedThreadCwd, stashRef })
        .then((details) => {
          if (revision !== snapshotRevision.current) return;
          setStashDetails((current) => new Map(current).set(stashRef, details));
        })
        .catch((cause) => {
          if (revision === snapshotRevision.current) setError(errorMessage(cause));
        });
    },
    [api, expandedRows, selectedThreadCwd, stashDetails, toggleExpanded],
  );

  if (!selectedThread || !selectedThreadCwd) {
    return (
      <>
        {headerToolbar}
        <View className="flex-1 bg-screen px-6">
          <EmptyState
            title="Version Control unavailable"
            detail="This thread does not have an active repository checkout."
          />
        </View>
      </>
    );
  }

  if (loading && !snapshot) {
    return (
      <>
        {headerToolbar}
        <View className="flex-1 items-center justify-center bg-screen px-6">
          <Text className="text-sm font-medium text-foreground-muted">
            Loading repository state…
          </Text>
        </View>
      </>
    );
  }

  if (!snapshot) {
    return (
      <>
        {headerToolbar}
        <View className="flex-1 bg-screen px-6">
          <EmptyState
            title="Version Control unavailable"
            detail={error ?? "The repository snapshot could not be loaded."}
          />
        </View>
      </>
    );
  }

  return (
    <>
      {headerToolbar}
      <ScrollView
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerClassName="gap-5 px-4 pb-8 pt-3"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refreshSnapshot({ pull: true })}
          />
        }
      >
        <RepositorySummary snapshot={snapshot} />

        {error ? (
          <View className="rounded-2xl border border-danger-border bg-danger px-4 py-3">
            <Text selectable className="text-sm font-medium text-danger-foreground">
              {error}
            </Text>
            <Pressable className="mt-2 self-start" onPress={() => setError(null)}>
              <Text className="text-xs font-t3-bold text-danger-foreground">Dismiss</Text>
            </Pressable>
          </View>
        ) : null}

        {busyAction ? (
          <View className="rounded-2xl border border-border bg-subtle px-4 py-3">
            <Text className="text-sm font-t3-bold text-foreground">{busyAction}</Text>
            <Text className="text-xs text-foreground-muted">
              Refreshing repository state when done…
            </Text>
          </View>
        ) : null}

        <View className="gap-2">
          <SectionHeader
            title="Actionable"
            subtitle={`${actionCount}`}
            expanded={actionableExpanded}
            onToggle={() => setActionableExpanded((value) => !value)}
            action={
              <ActionButton
                label="Fetch"
                icon="arrow.clockwise"
                disabled={busy}
                onPress={() =>
                  void runAction("fetch-all", () => api.fetchAllRemotes({ cwd: selectedThreadCwd }))
                }
              />
            }
          />
          {actionableExpanded ? (
            <View className="gap-3">
              {changeSets.map((changeSet) => {
                const rowKey = `changes:${changeSet.cwd}`;
                const expanded = expandedRows.has(rowKey);
                const selected = selectedFiles(changeSet);
                const stats = selectedFileStats(selected);
                return (
                  <View
                    key={changeSet.id}
                    className="overflow-hidden rounded-[20px] border border-border bg-card"
                  >
                    <Pressable
                      className="min-h-14 flex-row items-center gap-3 px-4 py-3"
                      onPress={() => toggleExpanded(rowKey)}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text className="text-base font-t3-bold text-foreground">
                          {changeSet.current ? "Working tree" : changeSet.branchName}
                        </Text>
                        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                          {selected.length} of {changeSet.files.length} files selected
                          {changeSet.current ? "" : ` · ${changeSet.cwd}`}
                        </Text>
                      </View>
                      <ChangeCounts insertions={stats.insertions} deletions={stats.deletions} />
                    </Pressable>
                    {expanded ? (
                      <>
                        <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                          <ActionButton
                            label={
                              selected.length === changeSet.files.length
                                ? "Select none"
                                : "Select all"
                            }
                            icon={
                              selected.length === changeSet.files.length
                                ? "circle"
                                : "checkmark.circle"
                            }
                            disabled={busy}
                            onPress={() => selectAllFiles(changeSet)}
                          />
                          <ActionButton
                            label="Commit"
                            icon="checkmark.circle"
                            disabled={busy || selected.length === 0}
                            onPress={() => commitSelected(changeSet)}
                          />
                          <ActionButton
                            label="Stash"
                            icon="archivebox"
                            disabled={busy || selected.length === 0}
                            onPress={() => stashSelected(changeSet)}
                          />
                          <ActionButton
                            label="Discard"
                            icon="trash"
                            danger
                            disabled={busy || selected.length === 0}
                            onPress={() => discardSelected(changeSet)}
                          />
                        </View>
                        {changeSet.files.map((file) => {
                          const fileKey = `file:${changeSet.cwd}:${file.path}`;
                          return (
                            <FileRow
                              key={file.path}
                              file={file}
                              selected={(selectedByCwd.get(changeSet.cwd) ?? new Set()).has(
                                file.path,
                              )}
                              expanded={expandedRows.has(fileKey)}
                              diffState={diffs.get(fileKey)}
                              disabled={busy}
                              onSelect={() => toggleSelectedFile(changeSet.cwd, file.path)}
                              onToggleDiff={() => toggleFileDiff(changeSet, file)}
                            />
                          );
                        })}
                      </>
                    ) : null}
                  </View>
                );
              })}

              {localBranches.map((branch) => {
                const key = `branch:${branch.name}`;
                const details = branchDetails.get(key);
                const state = panelBranchSyncState(branch, snapshot);
                const counts = panelBranchSyncCounts(branch, snapshot);
                const date = relativeLabel(branch.lastActivityAt);
                return (
                  <View
                    key={key}
                    className="overflow-hidden rounded-[20px] border border-border bg-card"
                  >
                    <Pressable
                      className="min-h-14 flex-row items-center gap-3 px-4 py-3"
                      onPress={() => loadBranchDetails(branch, key)}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                          {branch.name}
                        </Text>
                        <Text className="text-xs text-foreground-muted">
                          {branch.current
                            ? "Current branch"
                            : branch.worktreePath
                              ? "Checked out"
                              : "Local branch"}
                          {date ? ` · ${date}` : ""}
                        </Text>
                      </View>
                      {counts.aheadCount > 0 ? (
                        <Text className="text-xs font-t3-bold text-emerald-500">
                          ↑{counts.aheadCount}
                        </Text>
                      ) : null}
                      {counts.behindCount > 0 ? (
                        <Text className="text-xs font-t3-bold text-amber-500">
                          ↓{counts.behindCount}
                        </Text>
                      ) : null}
                    </Pressable>
                    <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                      {!branch.current && !branch.worktreePath ? (
                        <ActionButton
                          label="Switch"
                          icon="arrow.branch"
                          disabled={busy}
                          onPress={() => switchBranch(branch)}
                        />
                      ) : null}
                      <ActionButton
                        label={branchSyncLabel({ state, busy })}
                        icon="arrow.clockwise"
                        disabled={busy}
                        onPress={() => syncBranch(branch)}
                      />
                      {!branch.current ? (
                        <ActionButton
                          label="Delete"
                          icon="trash"
                          danger
                          disabled={busy}
                          onPress={() => deleteBranch(branch)}
                        />
                      ) : null}
                    </View>
                    {expandedRows.has(key) ? (
                      details ? (
                        <View>
                          <View className="border-t border-border px-4 py-3">
                            <Text className="text-2xs font-t3-bold tracking-[0.9px] uppercase text-foreground-muted">
                              vs.{" "}
                              {details.baseRef ?? snapshot.defaultCompareRef ?? "default branch"}
                            </Text>
                            <Text className="mt-1 text-xs text-foreground-secondary">
                              {details.aheadCommits.length} ahead · {details.behindCommits.length}{" "}
                              behind · {details.compareFiles.length} changed
                            </Text>
                          </View>
                          {details.commits.slice(0, 5).map((commit) => (
                            <View
                              key={commit.sha}
                              className="border-t border-border/70 px-4 py-2.5"
                            >
                              <Text
                                className="text-sm font-t3-bold text-foreground"
                                numberOfLines={1}
                              >
                                {commit.message}
                              </Text>
                              <Text className="text-2xs text-foreground-muted">
                                {commit.authorName ?? "Unknown author"} · {commit.shortSha}
                              </Text>
                            </View>
                          ))}
                          {details.compareFiles.map((file) => (
                            <PlainFileRow
                              key={`${file.path}:${file.originalPath ?? ""}`}
                              file={file}
                            />
                          ))}
                        </View>
                      ) : (
                        <Text className="border-t border-border px-4 py-3 text-xs text-foreground-muted">
                          Loading branch details…
                        </Text>
                      )
                    ) : null}
                  </View>
                );
              })}

              {snapshot.actionableForkBranches.map((fork) => {
                const branch = snapshot.localBranches.find(
                  (candidate) => candidate.name === fork.localBranchName,
                );
                if (!branch) return null;
                const key = `fork:${fork.localBranchName}:${fork.remoteRefName}`;
                return (
                  <View
                    key={key}
                    className="overflow-hidden rounded-[20px] border border-border bg-card"
                  >
                    <Pressable
                      className="min-h-14 flex-row items-center gap-3 px-4 py-3"
                      onPress={() => loadBranchDetails(branch, key, fork.remoteRefName)}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                          {fork.localBranchName}
                        </Text>
                        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                          Behind {fork.remoteRefName}
                        </Text>
                      </View>
                      <Text className="text-xs font-t3-bold text-amber-500">
                        ↓{fork.behindCount}
                      </Text>
                    </Pressable>
                    <View className="border-t border-border px-3 py-3">
                      <ActionButton
                        label="Fetch"
                        icon="arrow.clockwise"
                        disabled={busy}
                        onPress={() =>
                          void runAction("fetch-fork", () =>
                            api.fetchBranch({
                              cwd: selectedThreadCwd,
                              branchName: fork.remoteRefName,
                            }),
                          )
                        }
                      />
                    </View>
                    {expandedRows.has(key) ? (
                      branchDetails.get(key) ? (
                        <View>
                          {branchDetails.get(key)?.compareFiles.map((file) => (
                            <PlainFileRow
                              key={`${file.path}:${file.originalPath ?? ""}`}
                              file={file}
                            />
                          ))}
                        </View>
                      ) : (
                        <Text className="border-t border-border px-4 py-3 text-xs text-foreground-muted">
                          Loading comparison…
                        </Text>
                      )
                    ) : null}
                  </View>
                );
              })}

              {snapshot.stashes.map((stash) => {
                const key = `stash:${stash.refName}`;
                const details = stashDetails.get(stash.refName);
                return (
                  <View
                    key={stash.sha ?? stash.refName}
                    className="overflow-hidden rounded-[20px] border border-border bg-card"
                  >
                    <Pressable
                      className="min-h-14 flex-row items-center gap-3 px-4 py-3"
                      onPress={() => loadStashDetails(stash.refName)}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                          {stash.message}
                        </Text>
                        <Text className="text-xs text-foreground-muted">
                          {stash.refName}
                          {relativeLabel(stash.createdAt)
                            ? ` · ${relativeLabel(stash.createdAt)}`
                            : ""}
                        </Text>
                      </View>
                    </Pressable>
                    <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                      <ActionButton
                        label="Apply"
                        icon="arrow.down.circle"
                        disabled={busy}
                        onPress={() =>
                          void runAction("apply-stash", () =>
                            api.applyStash({ cwd: selectedThreadCwd, stashRef: stash.refName }),
                          )
                        }
                      />
                      <ActionButton
                        label="Pop"
                        icon="arrow.down.circle"
                        disabled={busy}
                        onPress={() =>
                          void runAction("pop-stash", () =>
                            api.popStash({ cwd: selectedThreadCwd, stashRef: stash.refName }),
                          )
                        }
                      />
                      <ActionButton
                        label="Drop"
                        icon="trash"
                        danger
                        disabled={busy}
                        onPress={() =>
                          Alert.alert("Drop stash?", `Permanently drop ${stash.refName}?`, [
                            { text: "Cancel", style: "cancel" },
                            {
                              text: "Drop",
                              style: "destructive",
                              onPress: () =>
                                void runAction("drop-stash", () =>
                                  api.dropStash({
                                    cwd: selectedThreadCwd,
                                    stashRef: stash.refName,
                                  }),
                                ),
                            },
                          ])
                        }
                      />
                    </View>
                    {expandedRows.has(key) ? (
                      details ? (
                        details.files.map((file) => (
                          <PlainFileRow
                            key={`${file.path}:${file.originalPath ?? ""}`}
                            file={file}
                          />
                        ))
                      ) : (
                        <Text className="border-t border-border px-4 py-3 text-xs text-foreground-muted">
                          Loading stash details…
                        </Text>
                      )
                    ) : null}
                  </View>
                );
              })}

              {actionCount === 0 ? (
                <View className="rounded-[20px] border border-border bg-card px-4 py-5">
                  <Text className="text-base font-t3-bold text-foreground">
                    Nothing needs attention
                  </Text>
                  <Text className="mt-1 text-sm text-foreground-muted">
                    The working tree and tracked branches are synchronized.
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>

        <View className="gap-2">
          <SectionHeader
            title="Remotes"
            subtitle={`${snapshot.remotes.length}`}
            expanded={remotesExpanded}
            onToggle={() => setRemotesExpanded((value) => !value)}
            action={
              <ActionButton
                label={showAddRemote ? "Cancel" : "Add"}
                icon={showAddRemote ? "xmark" : "plus"}
                disabled={busy}
                onPress={() => {
                  setRemotesExpanded(true);
                  setShowAddRemote((value) => !value);
                }}
              />
            }
          />
          {remotesExpanded ? (
            <View className="gap-3">
              {showAddRemote ? (
                <View className="gap-3 rounded-[20px] border border-border bg-card px-4 py-4">
                  <TextInput
                    value={remoteName}
                    onChangeText={setRemoteName}
                    placeholder="Remote name"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TextInput
                    value={remoteUrl}
                    onChangeText={setRemoteUrl}
                    placeholder="https://host/owner/repository.git"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <SheetActionButton
                    icon="plus"
                    label="Add remote"
                    tone="primary"
                    disabled={
                      busy || remoteName.trim().length === 0 || remoteUrl.trim().length === 0
                    }
                    onPress={() =>
                      void runAction("add-remote", () =>
                        api.addRemote({
                          cwd: selectedThreadCwd,
                          name: remoteName.trim(),
                          url: remoteUrl.trim(),
                        }),
                      ).then((succeeded) => {
                        if (!succeeded) return;
                        setRemoteName("");
                        setRemoteUrl("");
                        setShowAddRemote(false);
                      })
                    }
                  />
                </View>
              ) : null}
              {snapshot.remotes.map((remote) => {
                const key = `remote:${remote.name}`;
                return (
                  <View
                    key={remote.name}
                    className="overflow-hidden rounded-[20px] border border-border bg-card"
                  >
                    <Pressable
                      className="min-h-14 flex-row items-center gap-3 px-4 py-3"
                      onPress={() => toggleExpanded(key)}
                    >
                      <View className="min-w-0 flex-1 gap-0.5">
                        <Text className="text-base font-t3-bold text-foreground">
                          {remote.name}
                        </Text>
                        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                          {remote.fetchUrl ?? "No fetch URL"} · {remote.branches.length} branches
                        </Text>
                      </View>
                    </Pressable>
                    <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                      <ActionButton
                        label="Fetch"
                        icon="arrow.clockwise"
                        disabled={busy}
                        onPress={() =>
                          void runAction("fetch-remote", () =>
                            api.fetchRemote({ cwd: selectedThreadCwd, remoteName: remote.name }),
                          )
                        }
                      />
                      <ActionButton
                        label="Remove"
                        icon="trash"
                        danger
                        disabled={busy}
                        onPress={() =>
                          Alert.alert(
                            "Remove remote?",
                            `Remove ${remote.name} from this repository?`,
                            [
                              { text: "Cancel", style: "cancel" },
                              {
                                text: "Remove",
                                style: "destructive",
                                onPress: () =>
                                  void runAction("remove-remote", () =>
                                    api.removeRemote({
                                      cwd: selectedThreadCwd,
                                      remoteName: remote.name,
                                    }),
                                  ),
                              },
                            ],
                          )
                        }
                      />
                    </View>
                    {expandedRows.has(key)
                      ? remote.branches.map((branch) => (
                          <View
                            key={branch.fullRefName}
                            className="flex-row items-center gap-2 border-t border-border/70 px-4 py-3"
                          >
                            <Text
                              className="min-w-0 flex-1 text-sm font-medium text-foreground"
                              numberOfLines={1}
                            >
                              {branch.name}
                            </Text>
                            {branch.isDefaultRemoteHead ? (
                              <Text className="text-2xs font-t3-bold text-foreground-muted">
                                DEFAULT
                              </Text>
                            ) : null}
                            {relativeLabel(branch.lastActivityAt) ? (
                              <Text className="text-xs text-foreground-muted">
                                {relativeLabel(branch.lastActivityAt)}
                              </Text>
                            ) : null}
                          </View>
                        ))
                      : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}
