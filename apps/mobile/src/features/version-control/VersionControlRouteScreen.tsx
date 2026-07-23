import type {
  VcsPanelBranchDetails,
  VcsPanelCommitSummary,
  VcsPanelFileChange,
  VcsPanelFileDiffInput,
  VcsPanelStashDetails,
  VcsPanelSnapshotResult,
  VcsRef,
  VcsStatusResult,
} from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import {
  panelBranchOperationCwd,
  panelBranchSyncCounts,
  panelBranchSyncState,
} from "@t3tools/shared/sourceControl";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, Pressable, RefreshControl, ScrollView, View } from "react-native";
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
  applyWorkingTreeEnrichments,
  branchOwnsOperationCwd,
  branchSyncLabel,
  discardableFiles,
  discardPathGroups,
  fileStatusLetter,
  localBranchForRemoteBranch,
  operationPaths,
  panelChangeSets,
  reconcileSelectedPaths,
  selectedFileStats,
  stashIdentityKey,
  workingTreeDiffIsStaged,
  workingTreeEnrichmentRequests,
  type VersionControlChangeSet,
} from "./versionControlModel";
import {
  VersionControlCommandInterrupted,
  useVersionControlPanelApi,
} from "./useVersionControlPanelApi";
import { retryInterruptedVersionControlRequest } from "./versionControlRequest";

type VersionControlRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

type FileDiffSource = NonNullable<VcsPanelFileDiffInput["source"]>;

interface FileDiffRequest {
  readonly cwd: string;
  readonly file: VcsPanelFileChange;
  readonly source: FileDiffSource;
}

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
        "min-h-9 self-start flex-row items-center gap-1.5 rounded-full border px-3 py-2 disabled:opacity-[0.4]",
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

interface PublishRequest {
  readonly branchName: string;
  readonly targetCwd: string;
}

function PublishRemoteDialog(props: {
  readonly request: PublishRequest | null;
  readonly remoteNames: readonly string[];
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onSelect: (remoteName: string) => void;
}) {
  const pressedOverlay = useThemeColor("--color-subtle");
  return (
    <Modal
      visible={props.request !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={props.onCancel}
    >
      {props.request ? (
        <View className="flex-1 items-center justify-center bg-backdrop px-8">
          <View className="w-full max-w-md rounded-[24px] bg-card px-5 pb-5 pt-5">
            <Text className="text-lg font-t3-medium">Publish branch</Text>
            <Text className="mt-2 text-sm text-foreground-secondary">
              Choose a remote for {props.request.branchName}.
            </Text>
            <View className="mt-4 gap-2">
              {props.remoteNames.map((remoteName) => (
                <View key={remoteName} className="overflow-hidden rounded-2xl">
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-12 justify-center border border-border bg-subtle px-4"
                    disabled={props.disabled}
                    android_ripple={{ color: pressedOverlay }}
                    onPress={() => props.onSelect(remoteName)}
                  >
                    <Text className="text-base font-t3-medium text-foreground">{remoteName}</Text>
                  </Pressable>
                </View>
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              className="mt-3 min-h-10 self-end justify-center px-4"
              disabled={props.disabled}
              onPress={props.onCancel}
            >
              <Text className="text-base font-t3-medium text-foreground">Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </Modal>
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

function FileRow(props: {
  readonly file: VcsPanelFileChange;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onSelect?: () => void;
  readonly onOpenDiff: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  return (
    <View className="border-t border-border/70">
      <View className="min-h-12 flex-row items-center gap-2 px-3 py-2">
        {props.onSelect ? (
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
        ) : null}
        <Pressable
          className="min-w-0 flex-1 flex-row items-center gap-2"
          disabled={props.disabled}
          onPress={props.onOpenDiff}
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
          <SymbolView name="chevron.right" size={11} tintColor={iconColor} type="monochrome" />
        </Pressable>
      </View>
    </View>
  );
}

function BranchCommitRow(props: {
  readonly commit: VcsPanelCommitSummary;
  readonly direction: "ahead" | "behind";
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: React.ReactNode;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  const stats = selectedFileStats(props.commit.files);
  return (
    <View className="border-t border-border/70">
      <Pressable
        className="min-h-14 flex-row items-center gap-2 px-4 py-3"
        onPress={props.onToggle}
      >
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-sm font-t3-bold text-foreground" numberOfLines={1}>
              {props.commit.message}
            </Text>
            <Text
              className={cn(
                "text-xs font-t3-bold",
                props.direction === "ahead" ? "text-emerald-500" : "text-amber-500",
              )}
            >
              {props.direction === "ahead" ? "↑" : "↓"}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-2xs text-foreground-muted" numberOfLines={1}>
              {props.commit.authorName ?? "Unknown author"} · {props.commit.shortSha}
            </Text>
            <ChangeCounts insertions={stats.insertions} deletions={stats.deletions} />
            <SymbolView
              name={props.expanded ? "chevron.down" : "chevron.right"}
              size={11}
              tintColor={iconColor}
              type="monochrome"
            />
          </View>
        </View>
      </Pressable>
      {props.expanded ? (
        props.commit.files.length > 0 ? (
          props.children
        ) : (
          <Text className="border-t border-border/70 px-4 py-3 text-xs text-foreground-muted">
            No changed files.
          </Text>
        )
      ) : null}
    </View>
  );
}

function CompactTag(props: { readonly label: string }) {
  return (
    <View className="rounded-full bg-subtle px-2 py-0.5">
      <Text className="text-2xs font-t3-bold uppercase text-foreground-muted">{props.label}</Text>
    </View>
  );
}

function RepositorySummary(props: { readonly snapshot: VcsPanelSnapshotResult }) {
  const status = props.snapshot.status;
  const files = panelChangeSets(props.snapshot, "__summary__").find(
    (changeSet) => changeSet.current,
  )?.files;
  const stats = selectedFileStats(files ?? []);
  const fileCount = files?.length ?? 0;
  return (
    <View className="gap-1.5 px-1 py-1">
      <Text className="text-xl font-t3-bold text-foreground" numberOfLines={1}>
        {status.refName ?? "Detached HEAD"}
      </Text>
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
        {status.aheadCount > 0 ? (
          <Text className="text-xs font-t3-bold text-emerald-500">↑{status.aheadCount}</Text>
        ) : null}
        {status.behindCount > 0 ? (
          <Text className="text-xs font-t3-bold text-amber-500">↓{status.behindCount}</Text>
        ) : null}
        {!status.hasUpstream ? (
          <Text className="text-xs font-medium text-foreground-muted">No upstream</Text>
        ) : null}
        {status.hasWorkingTreeChanges ? (
          <View className="flex-row items-center gap-2">
            <Text className="text-xs font-medium text-foreground-muted">
              {fileCount} {fileCount === 1 ? "file" : "files"}
            </Text>
            <ChangeCounts insertions={stats.insertions} deletions={stats.deletions} />
          </View>
        ) : (
          <Text className="text-xs font-t3-bold text-foreground-muted">Clean</Text>
        )}
      </View>
    </View>
  );
}

export function VersionControlRouteScreen(props: VersionControlRouteScreenProps) {
  const insets = useSafeAreaInsets();
  const subtleIconColor = useThemeColor("--color-icon-subtle");
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitActions = useSelectedThreadGitActions();
  const api = useVersionControlPanelApi(environmentId);
  const statusQuery = useEnvironmentQuery(
    selectedThreadCwd
      ? vcsEnvironment.status({
          environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const [snapshot, setSnapshot] = useState<VcsPanelSnapshotResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [actionableExpanded, setActionableExpanded] = useState(true);
  const [remotesExpanded, setRemotesExpanded] = useState(false);
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(
    () => new Set(selectedThreadCwd ? [`changes:${selectedThreadCwd}`] : []),
  );
  const expandedRowsRef = useRef<ReadonlySet<string>>(expandedRows);
  const [selectedByCwd, setSelectedByCwd] = useState<ReadonlyMap<string, ReadonlySet<string>>>(
    new Map(),
  );
  const knownPathsByCwd = useRef(new Map<string, Set<string>>());
  const initializedChangeSetCwds = useRef(new Set<string>());
  const [branchDetails, setBranchDetails] = useState<ReadonlyMap<string, VcsPanelBranchDetails>>(
    new Map(),
  );
  const [stashDetails, setStashDetails] = useState<ReadonlyMap<string, VcsPanelStashDetails>>(
    new Map(),
  );
  const [detailErrors, setDetailErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [showAddRemote, setShowAddRemote] = useState(false);
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [publishRequest, setPublishRequest] = useState<PublishRequest | null>(null);
  const initiallyFetchedCwds = useRef(new Set<string>());
  const snapshotRequestId = useRef(0);
  const snapshotRevision = useRef(0);
  const snapshotFingerprint = useRef<string | null>(null);

  useEffect(() => {
    expandedRowsRef.current = expandedRows;
  }, [expandedRows]);

  const syncSelections = useCallback((nextSnapshot: VcsPanelSnapshotResult, cwd: string) => {
    const changeSets = panelChangeSets(nextSnapshot, cwd);
    const newlyInitializedCurrentCwds = changeSets.flatMap((changeSet) => {
      if (initializedChangeSetCwds.current.has(changeSet.cwd)) return [];
      initializedChangeSetCwds.current.add(changeSet.cwd);
      return changeSet.current ? [changeSet.cwd] : [];
    });
    const previousKnownPaths = knownPathsByCwd.current;
    const nextKnownPaths = new Map(
      changeSets.map(
        (changeSet) => [changeSet.cwd, new Set(changeSet.files.map((file) => file.path))] as const,
      ),
    );
    knownPathsByCwd.current = nextKnownPaths;

    setExpandedRows((current) => {
      const next = new Set(current);
      for (const changeSetCwd of newlyInitializedCurrentCwds) next.add(`changes:${changeSetCwd}`);
      return next;
    });
    setSelectedByCwd((current) =>
      reconcileSelectedPaths({
        changeSets,
        previousKnownPaths,
        selectedByCwd: current,
      }),
    );
  }, []);

  const refreshSnapshot = useCallback(
    async (
      options: {
        readonly pull?: boolean;
        readonly refresh?: "full" | "working-tree";
      } = {},
    ) => {
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
        const rawSnapshot = await api.snapshot({
          cwd: selectedThreadCwd,
          refresh: options.refresh ?? "full",
        });
        if (requestId !== snapshotRequestId.current) return;
        const enrichmentResults = await Promise.allSettled(
          workingTreeEnrichmentRequests(rawSnapshot, selectedThreadCwd).map(
            async (request) => [request.cwd, await api.enrichWorkingTreeFiles(request)] as const,
          ),
        );
        const enrichmentEntries = enrichmentResults.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        if (requestId !== snapshotRequestId.current) return;
        const next = applyWorkingTreeEnrichments(
          rawSnapshot,
          selectedThreadCwd,
          new Map(enrichmentEntries),
        );
        const nextFingerprint = `${selectedThreadCwd}\0${JSON.stringify(next)}`;
        if (snapshotFingerprint.current !== nextFingerprint) {
          snapshotFingerprint.current = nextFingerprint;
          snapshotRevision.current += 1;
          setBranchDetails(new Map());
          setStashDetails(new Map());
          setDetailErrors(new Map());
          setExpandedRows(
            (current) =>
              new Set(
                [...current].filter(
                  (key) =>
                    !key.startsWith("branch:") &&
                    !key.startsWith("fork:") &&
                    !key.startsWith("commit:") &&
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
      setMutationError(null);
      let succeeded = false;
      let actionError: string | null = null;
      try {
        await action();
        succeeded = true;
      } catch (cause) {
        if (!(cause instanceof VersionControlCommandInterrupted)) actionError = errorMessage(cause);
      } finally {
        await refreshSnapshot();
        statusQuery.refresh();
        if (actionError) setMutationError(actionError);
        setBusyAction(null);
      }
      return succeeded;
    },
    [refreshSnapshot, statusQuery],
  );

  useFocusEffect(
    useCallback(() => {
      if (!selectedThreadCwd) return;
      const cwd = selectedThreadCwd;
      void refreshSnapshot();
      if (!initiallyFetchedCwds.current.has(cwd)) {
        initiallyFetchedCwds.current.add(cwd);
        void api
          .fetchAllRemotes({ cwd })
          .then(() => refreshSnapshot())
          .catch(() => undefined);
      }
    }, [api, refreshSnapshot, selectedThreadCwd]),
  );

  const statusFingerprint = statusQuery.data ? JSON.stringify(statusQuery.data) : null;
  const lastStatusRefresh = useRef<{
    readonly data: VcsStatusResult;
    readonly fingerprint: string;
  } | null>(null);
  useEffect(() => {
    if (!statusQuery.data || !statusFingerprint) return;
    const previous = lastStatusRefresh.current;
    if (previous?.data === statusQuery.data && previous.fingerprint === statusFingerprint) return;
    lastStatusRefresh.current = {
      data: statusQuery.data,
      fingerprint: statusFingerprint,
    };
    if (previous) void refreshSnapshot({ refresh: "working-tree" });
  }, [refreshSnapshot, statusFingerprint, statusQuery.data]);

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
      expandedRowsRef.current = next;
      return next;
    });
  }, []);

  const openFileDiff = useCallback(
    (request: FileDiffRequest) => {
      navigation.navigate("VersionControlDiff", {
        environmentId: String(environmentId),
        cwd: request.cwd,
        file: request.file,
        source: request.source,
      });
    },
    [environmentId, navigation],
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
      const files = discardableFiles(selectedFiles(changeSet));
      const paths = discardPathGroups(files);
      if (paths.staged.length === 0 && paths.unstaged.length === 0) return;
      Alert.alert(
        "Discard selected changes?",
        `This permanently discards changes in ${files.length} selected file${files.length === 1 ? "" : "s"}.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () =>
              void runAction("discard", async () => {
                if (paths.unstaged.length > 0) {
                  await api.discardFiles({
                    cwd: changeSet.cwd,
                    paths: paths.unstaged,
                  });
                }
                if (paths.staged.length > 0) {
                  await api.discardFiles({
                    cwd: changeSet.cwd,
                    paths: paths.staged,
                    staged: true,
                  });
                }
              }),
          },
        ],
      );
    },
    [api, runAction, selectedFiles],
  );

  const loadBranchDetails = useCallback(
    (branch: VcsRef, key: string, compareBaseRef?: string) => {
      const wasExpanded = expandedRowsRef.current.has(key);
      toggleExpanded(key);
      if (!snapshot || branchDetails.has(key) || wasExpanded) return;
      const revision = snapshotRevision.current;
      setDetailErrors((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      void retryInterruptedVersionControlRequest(() =>
        api.branchDetails({
          cwd: selectedThreadCwd ?? "",
          branch,
          defaultCompareRef: snapshot.defaultCompareRef,
          ...(compareBaseRef ? { compareBaseRef } : {}),
        }),
      )
        .then((details) => {
          if (revision !== snapshotRevision.current) return;
          setBranchDetails((current) => new Map(current).set(key, details));
          setDetailErrors((current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
        })
        .catch((cause) => {
          if (
            revision === snapshotRevision.current &&
            !(cause instanceof VersionControlCommandInterrupted)
          ) {
            const message = errorMessage(cause);
            setDetailErrors((current) => new Map(current).set(key, message));
            setError(message);
          }
        });
    },
    [api, branchDetails, selectedThreadCwd, snapshot, toggleExpanded],
  );

  const publishBranch = useCallback(
    (branch: VcsRef, targetCwd: string) => {
      if (!snapshot) return;
      if (snapshot.remotes.length === 0) {
        setError("Add a remote before publishing this branch.");
        return;
      }
      if (snapshot.remotes.length > 1) {
        setPublishRequest({ branchName: branch.name, targetCwd });
        return;
      }
      const remote = snapshot.remotes[0];
      if (!remote) return;
      void runAction("publish", () =>
        api.pushBranch({
          cwd: targetCwd,
          branchName: branch.name,
          remoteName: remote.name,
        }),
      );
    },
    [api, runAction, snapshot],
  );

  const publishToRemote = useCallback(
    (remoteName: string) => {
      const request = publishRequest;
      if (!request) return;
      setPublishRequest(null);
      void runAction("publish", () =>
        api.pushBranch({
          cwd: request.targetCwd,
          branchName: request.branchName,
          remoteName,
        }),
      );
    },
    [api, publishRequest, runAction],
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
      const canMerge = branchOwnsOperationCwd(branch);
      Alert.alert("Branch has diverged", "Choose how to synchronize this branch.", [
        { text: "Cancel", style: "cancel" },
        ...(canMerge
          ? [
              {
                text: "Pull & merge",
                onPress: () =>
                  void runAction("merge-sync", () =>
                    api.pullBranch({
                      cwd: targetCwd,
                      branchName: branch.name,
                      merge: true,
                    }),
                  ),
              },
            ]
          : []),
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
                    api.pullBranch({
                      cwd: targetCwd,
                      branchName: branch.name,
                      force: true,
                    }),
                  ),
              },
              {
                text: "Force push",
                style: "destructive",
                onPress: () =>
                  void runAction("force-push", () =>
                    api.pushBranch({
                      cwd: targetCwd,
                      branchName: branch.name,
                      force: true,
                    }),
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
      if (!selectedThreadCwd || branch.current || branch.worktreePath !== null) return;
      Alert.alert("Delete branch?", `Delete ${branch.name}?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void runAction("delete-branch", () =>
              api.deleteBranch({
                cwd: selectedThreadCwd,
                branchName: branch.name,
              }),
            ),
        },
      ]);
    },
    [api, runAction, selectedThreadCwd],
  );

  const mergeBranch = useCallback(
    (refName: string) => {
      if (!selectedThreadCwd) return;
      Alert.alert("Merge branch?", `Merge ${refName} into the current branch?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Merge",
          onPress: () =>
            void runAction("merge-branch", () =>
              api.mergeBranchIntoCurrent({ cwd: selectedThreadCwd, refName }),
            ),
        },
      ]);
    },
    [api, runAction, selectedThreadCwd],
  );

  const rebaseBranch = useCallback(
    (refName: string) => {
      if (!selectedThreadCwd) return;
      Alert.alert("Rebase branch?", `Rebase the current branch onto ${refName}?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Rebase",
          onPress: () =>
            void runAction("rebase-branch", () =>
              api.rebaseCurrentOnto({ cwd: selectedThreadCwd, refName }),
            ),
        },
      ]);
    },
    [api, runAction, selectedThreadCwd],
  );

  const loadStashDetails = useCallback(
    (stash: VcsPanelSnapshotResult["stashes"][number]) => {
      const detailsKey = stashIdentityKey(stash);
      const key = `stash:${detailsKey}`;
      const wasExpanded = expandedRowsRef.current.has(key);
      toggleExpanded(key);
      if (!selectedThreadCwd || stashDetails.has(detailsKey) || wasExpanded) return;
      const revision = snapshotRevision.current;
      setDetailErrors((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      void retryInterruptedVersionControlRequest(() =>
        api.stashDetails({ cwd: selectedThreadCwd, stashRef: stash.refName }),
      )
        .then((details) => {
          if (revision !== snapshotRevision.current) return;
          setStashDetails((current) => new Map(current).set(detailsKey, details));
          setDetailErrors((current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });
        })
        .catch((cause) => {
          if (
            revision === snapshotRevision.current &&
            !(cause instanceof VersionControlCommandInterrupted)
          ) {
            const message = errorMessage(cause);
            setDetailErrors((current) => new Map(current).set(key, message));
            setError(message);
          }
        });
    },
    [api, selectedThreadCwd, stashDetails, toggleExpanded],
  );

  const renderBranchCommit = (
    commit: VcsPanelCommitSummary,
    direction: "ahead" | "behind",
    parentKey: string,
    cwd: string,
  ) => {
    const commitKey = `commit:${parentKey}:${commit.sha}`;
    const expanded = expandedRows.has(commitKey);
    return (
      <BranchCommitRow
        key={`${direction}:${commit.sha}`}
        commit={commit}
        direction={direction}
        expanded={expanded}
        onToggle={() => toggleExpanded(commitKey)}
      >
        {commit.files.map((file) => {
          const request: FileDiffRequest = {
            cwd,
            file,
            source: { kind: "commit", sha: commit.sha },
          };
          return (
            <FileRow
              key={`${commit.sha}:${file.path}:${file.originalPath ?? ""}`}
              file={file}
              disabled={busy}
              onOpenDiff={() => openFileDiff(request)}
            />
          );
        })}
      </BranchCommitRow>
    );
  };

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
      <PublishRemoteDialog
        request={publishRequest}
        remoteNames={snapshot.remotes.map((remote) => remote.name)}
        disabled={busy}
        onCancel={() => setPublishRequest(null)}
        onSelect={publishToRemote}
      />
      <ScrollView
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-5 px-4 pt-3"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refreshSnapshot({ pull: true })}
          />
        }
      >
        <RepositorySummary snapshot={snapshot} />

        {(mutationError ?? error) ? (
          <View className="rounded-2xl border border-danger-border bg-danger px-4 py-3">
            <Text selectable className="text-sm font-medium text-danger-foreground">
              {mutationError ?? error}
            </Text>
            <Pressable
              className="mt-2 self-start"
              onPress={() => {
                setMutationError(null);
                setError(null);
              }}
            >
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
                  void runAction("fetch-all", () =>
                    api.fetchAllRemotes({ cwd: selectedThreadCwd, force: true }),
                  )
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
                const discardable = discardableFiles(selected);
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
                            disabled={busy || discardable.length === 0}
                            onPress={() => discardSelected(changeSet)}
                          />
                        </View>
                        {changeSet.files.map((file) => {
                          const diffRequest: FileDiffRequest = {
                            cwd: changeSet.cwd,
                            file,
                            source: {
                              kind: "working-tree",
                              staged: workingTreeDiffIsStaged(file),
                            },
                          };
                          return (
                            <FileRow
                              key={file.path}
                              file={file}
                              selected={(selectedByCwd.get(changeSet.cwd) ?? new Set()).has(
                                file.path,
                              )}
                              disabled={busy}
                              onSelect={() => toggleSelectedFile(changeSet.cwd, file.path)}
                              onOpenDiff={() => openFileDiff(diffRequest)}
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
                    {expandedRows.has(key) ? (
                      <View>
                        <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                          {!branch.current && !branch.worktreePath ? (
                            <ActionButton
                              label="Checkout"
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
                            <>
                              <ActionButton
                                label="Merge"
                                icon="point.topleft.down.curvedto.point.bottomright.up"
                                disabled={busy}
                                onPress={() => mergeBranch(branch.name)}
                              />
                              <ActionButton
                                label="Rebase"
                                icon="arrow.triangle.pull"
                                disabled={busy}
                                onPress={() => rebaseBranch(branch.name)}
                              />
                              <ActionButton
                                label="Delete"
                                icon="trash"
                                danger
                                disabled={busy || branch.worktreePath !== null}
                                onPress={() => deleteBranch(branch)}
                              />
                            </>
                          ) : null}
                        </View>
                        {details ? (
                          <>
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
                            {details.aheadCommits.map((commit) =>
                              renderBranchCommit(commit, "ahead", key, selectedThreadCwd),
                            )}
                            {details.behindCommits.map((commit) =>
                              renderBranchCommit(commit, "behind", key, selectedThreadCwd),
                            )}
                            {details.aheadCommits.length === 0 &&
                            details.behindCommits.length === 0 ? (
                              <Text className="border-t border-border px-4 py-3 text-xs text-foreground-muted">
                                No commits differ from the comparison branch.
                              </Text>
                            ) : null}
                          </>
                        ) : (
                          <Text className="border-t border-border px-4 py-3 text-xs text-foreground-muted">
                            {detailErrors.has(key)
                              ? `Unable to load branch details: ${detailErrors.get(key)}`
                              : "Loading branch details…"}
                          </Text>
                        )}
                      </View>
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
                    {expandedRows.has(key) ? (
                      <View>
                        <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
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
                        {branchDetails.get(key) ? (
                          <>
                            {branchDetails
                              .get(key)
                              ?.aheadCommits.map((commit) =>
                                renderBranchCommit(commit, "ahead", key, selectedThreadCwd),
                              )}
                            {branchDetails
                              .get(key)
                              ?.behindCommits.map((commit) =>
                                renderBranchCommit(commit, "behind", key, selectedThreadCwd),
                              )}
                          </>
                        ) : (
                          <Text className="border-t border-border px-4 py-3 text-xs text-foreground-muted">
                            {detailErrors.has(key)
                              ? `Unable to load comparison: ${detailErrors.get(key)}`
                              : "Loading comparison…"}
                          </Text>
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              })}

              {snapshot.stashes.map((stash) => {
                const detailsKey = stashIdentityKey(stash);
                const key = `stash:${detailsKey}`;
                const details = stashDetails.get(detailsKey);
                return (
                  <View
                    key={detailsKey}
                    className="overflow-hidden rounded-[20px] border border-border bg-card"
                  >
                    <Pressable
                      className="min-h-14 flex-row items-center gap-3 px-4 py-3"
                      onPress={() => loadStashDetails(stash)}
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
                    {expandedRows.has(key) ? (
                      <View>
                        <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                          <ActionButton
                            label="Apply"
                            icon="arrow.down.circle"
                            disabled={busy}
                            onPress={() =>
                              void runAction("apply-stash", () =>
                                api.applyStash({
                                  cwd: selectedThreadCwd,
                                  stashRef: stash.refName,
                                }),
                              )
                            }
                          />
                          <ActionButton
                            label="Pop"
                            icon="arrow.down.circle"
                            disabled={busy}
                            onPress={() =>
                              void runAction("pop-stash", () =>
                                api.popStash({
                                  cwd: selectedThreadCwd,
                                  stashRef: stash.refName,
                                }),
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
                        {details ? (
                          details.files.map((file) => {
                            const request: FileDiffRequest = {
                              cwd: selectedThreadCwd,
                              file,
                              source: {
                                kind: "stash",
                                stashRef: stash.refName,
                              },
                            };
                            return (
                              <FileRow
                                key={`${file.path}:${file.originalPath ?? ""}`}
                                file={file}
                                disabled={busy}
                                onOpenDiff={() => openFileDiff(request)}
                              />
                            );
                          })
                        ) : (
                          <Text className="border-t border-border px-4 py-3 text-xs text-foreground-muted">
                            {detailErrors.has(key)
                              ? `Unable to load stash details: ${detailErrors.get(key)}`
                              : "Loading stash details…"}
                          </Text>
                        )}
                      </View>
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
                const remoteExpanded = expandedRows.has(key);
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
                        <View className="flex-row items-center gap-2">
                          <SymbolView
                            name="point.3.connected.trianglepath.dotted"
                            size={15}
                            tintColor={subtleIconColor}
                            type="monochrome"
                          />
                          <Text className="text-base font-t3-bold text-foreground">
                            {remote.name}
                          </Text>
                        </View>
                        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                          {remote.fetchUrl ?? "No fetch URL"} · {remote.branches.length} branches
                        </Text>
                      </View>
                    </Pressable>
                    {remoteExpanded ? (
                      <View className="flex-row flex-wrap gap-2 border-t border-border px-3 py-3">
                        <ActionButton
                          label="Fetch"
                          icon="arrow.clockwise"
                          disabled={busy}
                          onPress={() =>
                            void runAction("fetch-remote", () =>
                              api.fetchRemote({
                                cwd: selectedThreadCwd,
                                remoteName: remote.name,
                              }),
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
                    ) : null}
                    {remote.branches.map((remoteBranch) => {
                      const localBranch = localBranchForRemoteBranch(
                        snapshot,
                        remote,
                        remoteBranch,
                      );
                      const branch: VcsRef = localBranch ?? {
                        name: remoteBranch.fullRefName,
                        isRemote: true,
                        remoteName: remote.name,
                        current: false,
                        isDefault: remoteBranch.isDefaultRemoteHead,
                        worktreePath: null,
                        lastActivityAt: remoteBranch.lastActivityAt ?? null,
                      };
                      const branchKey = `remote-branch:${remote.name}:${remoteBranch.name}`;
                      const branchExpanded = expandedRows.has(branchKey);
                      const counts = localBranch
                        ? panelBranchSyncCounts(localBranch, snapshot)
                        : { aheadCount: 0, behindCount: 0 };
                      const syncState = localBranch
                        ? panelBranchSyncState(localBranch, snapshot)
                        : null;
                      return (
                        <View key={remoteBranch.fullRefName} className="border-t border-border/70">
                          <Pressable
                            className="min-h-12 flex-row items-center gap-2 px-4 py-3"
                            onPress={() => toggleExpanded(branchKey)}
                          >
                            <SymbolView
                              name={
                                localBranch
                                  ? "arrow.branch"
                                  : "point.3.connected.trianglepath.dotted"
                              }
                              size={14}
                              tintColor={subtleIconColor}
                              type="monochrome"
                            />
                            <View className="min-w-0 flex-1 gap-1">
                              <Text
                                className="text-sm font-t3-bold text-foreground"
                                numberOfLines={1}
                              >
                                {remoteBranch.name}
                              </Text>
                              <View className="flex-row flex-wrap items-center gap-1">
                                <CompactTag label={localBranch ? "local" : "remote"} />
                                {localBranch?.current ? <CompactTag label="current" /> : null}
                                {localBranch?.worktreePath && !localBranch.current ? (
                                  <CompactTag label="worktree" />
                                ) : null}
                                {remoteBranch.isDefaultRemoteHead || localBranch?.isDefault ? (
                                  <CompactTag label="default" />
                                ) : null}
                              </View>
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
                          {branchExpanded ? (
                            <View className="flex-row flex-wrap gap-2 border-t border-border/70 px-3 py-3">
                              {!branch.current && !branch.worktreePath ? (
                                <ActionButton
                                  label="Checkout"
                                  icon="arrow.branch"
                                  disabled={busy}
                                  onPress={() => switchBranch(branch)}
                                />
                              ) : null}
                              {localBranch && syncState ? (
                                <ActionButton
                                  label={branchSyncLabel({
                                    state: syncState,
                                    busy,
                                  })}
                                  icon="arrow.clockwise"
                                  disabled={busy}
                                  onPress={() => syncBranch(localBranch)}
                                />
                              ) : (
                                <ActionButton
                                  label="Fetch"
                                  icon="arrow.clockwise"
                                  disabled={busy}
                                  onPress={() =>
                                    void runAction("fetch-remote-branch", () =>
                                      api.fetchBranch({
                                        cwd: selectedThreadCwd,
                                        branchName: remoteBranch.fullRefName,
                                      }),
                                    )
                                  }
                                />
                              )}
                              {!branch.current ? (
                                <>
                                  <ActionButton
                                    label="Merge"
                                    icon="point.topleft.down.curvedto.point.bottomright.up"
                                    disabled={busy}
                                    onPress={() => mergeBranch(branch.name)}
                                  />
                                  <ActionButton
                                    label="Rebase"
                                    icon="arrow.triangle.pull"
                                    disabled={busy}
                                    onPress={() => rebaseBranch(branch.name)}
                                  />
                                  <ActionButton
                                    label="Delete"
                                    icon="trash"
                                    danger
                                    disabled={busy || branch.worktreePath !== null}
                                    onPress={() => deleteBranch(branch)}
                                  />
                                </>
                              ) : null}
                            </View>
                          ) : null}
                        </View>
                      );
                    })}
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
