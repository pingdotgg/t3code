import {
  confirmWorktreeRemoval,
  formatWorktreeAge,
  groupWorktreesByProject,
  NO_CONFIRMED_WORKTREE_REMOVALS,
  primaryLinkedThread,
  visibleWorktrees,
  worktreeBranchLabel,
  worktreeGroupSummary,
  worktreeIgnoredNote,
  worktreeInventoryRefreshKey,
  worktreeRemovalConfirmation,
  worktreeRemovalOutcome,
  worktreeStateLabel,
} from "@t3tools/client-runtime/state/worktrees";
import type { EnvironmentId, ProjectId, WorktreeInfo } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { showConfirmDialog } from "../../../components/ConfirmDialogHost";
import { cn } from "../../../lib/cn";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { worktreeEnvironment } from "../../../state/worktrees";
import { SettingsSection } from "./SettingsSection";

function threadLine(worktree: WorktreeInfo): string {
  const { thread, otherCount } = primaryLinkedThread(worktree);
  if (thread === null) return "No linked threads";
  const title = thread.title || "Untitled thread";
  const label = thread.status === "archived" ? `Archived: ${title}` : title;
  return otherCount > 0 ? `${label} +${otherCount}` : label;
}

/** Two lines per worktree: branch and state, then thread and age. */
function WorktreeRow(props: {
  readonly worktree: WorktreeInfo;
  readonly nowMs: number;
  readonly removing: boolean;
  readonly disabled: boolean;
  readonly separated: boolean;
  readonly onRemove: (worktree: WorktreeInfo) => void;
}) {
  const { worktree } = props;
  const state = worktreeStateLabel(worktree);
  const detail = [
    state === null ? worktreeIgnoredNote(worktree) : null,
    worktree.lastActivityAt ? formatWorktreeAge(worktree.lastActivityAt, props.nowMs) : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <View
      className={cn(
        "gap-1 px-4 py-3",
        props.separated && "border-t border-border-subtle",
        props.removing && "opacity-60",
      )}
    >
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
          {worktreeBranchLabel(worktree)}
        </Text>
        {props.removing ? (
          <Text className="text-sm text-foreground-muted">Removing</Text>
        ) : state === null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove worktree ${worktreeBranchLabel(worktree)}`}
            disabled={props.disabled}
            hitSlop={8}
            onPress={() => props.onRemove(worktree)}
            className="active:opacity-70"
          >
            <Text className="text-sm font-t3-medium text-danger-foreground">Remove</Text>
          </Pressable>
        ) : (
          <Text
            accessibilityHint={state.detail}
            className={cn(
              "shrink text-sm",
              state.tone === "warning" ? "text-warning-foreground" : "text-foreground-muted",
            )}
            numberOfLines={1}
          >
            {state.text}
          </Text>
        )}
      </View>
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
          {threadLine(worktree)}
        </Text>
        {detail.length > 0 ? (
          <Text className="text-sm tabular-nums text-foreground-muted">{detail}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * One environment's managed worktrees, optionally narrowed to a project's
 * repository. Labels, grouping and the reread decision come from the shared
 * client runtime, so they match the web settings list.
 */
export function WorktreeInventorySection(props: {
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
}) {
  const { environmentId, projectId } = props;
  const inventory = useEnvironmentQuery(
    worktreeEnvironment.list({ environmentId, input: projectId === null ? {} : { projectId } }),
  );
  const { refresh: refreshInventory, isPending: inventoryPending } = inventory;
  const listedRevision = inventory.data?.revision;
  const streamRevision = useEnvironmentQuery(
    worktreeEnvironment.changes({ environmentId, input: {} }),
  ).data?.revision;
  const pruneWorktrees = useAtomCommand(worktreeEnvironment.prune, {
    label: "remove worktree",
    reportFailure: true,
  });
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [removals, setRemovals] = useState(NO_CONFIRMED_WORKTREE_REMOVALS);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastRefreshKey = useRef<string | null>(null);
  const groups = groupWorktreesByProject(visibleWorktrees(inventory.data, removals));

  useEffect(() => {
    const refreshKey = worktreeInventoryRefreshKey({
      listedRevision,
      streamRevision,
      isPending: inventoryPending,
      lastRefreshKey: lastRefreshKey.current,
    });
    if (refreshKey === null) return;
    lastRefreshKey.current = refreshKey;
    refreshInventory();
  }, [refreshInventory, inventoryPending, listedRevision, streamRevision]);

  const refresh = () => {
    setNowMs(Date.now());
    refreshInventory();
  };

  const remove = (worktree: WorktreeInfo, allowIgnoredFiles: boolean) => {
    setPendingPath(worktree.path);
    void pruneWorktrees({
      environmentId,
      input: {
        projectId: worktree.projectId,
        paths: [worktree.path],
        ...(allowIgnoredFiles ? { allowIgnoredFiles } : {}),
      },
    })
      .then((result) => {
        if (result._tag !== "Success") return;
        const outcome = worktreeRemovalOutcome(result.value);
        if (outcome.removed) {
          setRemovals((current) => confirmWorktreeRemoval(current, listedRevision, worktree.path));
        } else {
          Alert.alert(`Kept ${worktreeBranchLabel(worktree)}`, outcome.message);
        }
      })
      .finally(() => {
        setPendingPath(null);
        refresh();
      });
  };

  const confirmRemove = (worktree: WorktreeInfo) => {
    if (pendingPath !== null) return;
    const confirmation = worktreeRemovalConfirmation(worktree);
    // The ignored paths are part of what the user agrees to delete.
    const message = [
      confirmation.message,
      ...confirmation.ignoredFiles,
      ...(confirmation.ignoredMoreCount > 0 ? [`and ${confirmation.ignoredMoreCount} more`] : []),
    ].join("\n");
    const onConfirm = () => remove(worktree, confirmation.allowIgnoredFiles);
    if (process.env.EXPO_OS === "ios") {
      Alert.alert(confirmation.title, message, [
        { text: "Cancel", style: "cancel" },
        { text: "Remove worktree", style: "destructive", onPress: onConfirm },
      ]);
      return;
    }
    showConfirmDialog({
      title: confirmation.title,
      message,
      confirmText: "Remove worktree",
      destructive: true,
      onConfirm,
    });
  };

  return (
    <SettingsSection
      title={props.title}
      trailing={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh worktrees"
          disabled={inventoryPending}
          hitSlop={8}
          onPress={refresh}
          className={cn("px-2 android:px-4", inventoryPending ? "opacity-40" : "active:opacity-70")}
        >
          <SymbolView name="arrow.clockwise" size={16} tintColorClassName="accent-icon" />
        </Pressable>
      }
    >
      {/* Rows from the last read stay up while a refresh runs or fails. */}
      {inventory.error !== null ? (
        <Pressable accessibilityRole="button" onPress={refresh} className="px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            Couldn't read worktrees. <Text className="text-sm text-primary-text">Retry</Text>
          </Text>
        </Pressable>
      ) : null}
      {inventory.data === null ? (
        inventory.error === null ? (
          <Text className="px-4 py-3 text-sm text-foreground-muted">Reading worktrees</Text>
        ) : null
      ) : groups.length === 0 ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">No worktrees</Text>
      ) : (
        groups.map((group, groupIndex) => (
          <View
            key={group.projectId}
            className={cn(groupIndex > 0 && "border-t border-border-subtle")}
          >
            <View className="flex-row items-center gap-3 px-4 pt-3">
              <Text
                className="min-w-0 flex-1 text-sm font-t3-medium text-foreground"
                numberOfLines={1}
              >
                {group.projectTitle}
              </Text>
              <Text className="text-sm tabular-nums text-foreground-muted">
                {worktreeGroupSummary(group)}
              </Text>
            </View>
            {group.worktrees.map((worktree, index) => (
              <WorktreeRow
                key={worktree.path}
                worktree={worktree}
                nowMs={nowMs}
                removing={pendingPath === worktree.path}
                disabled={pendingPath !== null}
                separated={index > 0}
                onRemove={confirmRemove}
              />
            ))}
          </View>
        ))
      )}
    </SettingsSection>
  );
}
