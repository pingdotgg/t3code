import type {
  VcsPanelCommitSummary,
  VcsPanelFileChange,
  VcsPanelSnapshotResult,
} from "@t3tools/contracts";
import { Modal, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { fileStatusLetter, panelChangeSets, selectedFileStats } from "./versionControlModel";

export function ActionButton(props: {
  readonly label: string;
  readonly icon: React.ComponentProps<typeof SymbolView>["name"];
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor(props.danger ? "--color-danger-foreground" : "--color-icon");
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
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

export interface PublishRequest {
  readonly branchName: string;
  readonly targetCwd: string;
}

export function PublishRemoteDialog(props: {
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

export function ChangeCounts(props: { readonly insertions: number; readonly deletions: number }) {
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

export function SectionHeader(props: {
  readonly title: string;
  readonly subtitle?: string | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly action?: React.ReactNode;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  return (
    <View className="flex-row items-center gap-2 px-1">
      <Pressable
        accessibilityLabel={`${props.title} section`}
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        className="min-h-10 flex-1 flex-row items-center gap-2"
        onPress={props.onToggle}
      >
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

export function FileRow(props: {
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
            accessibilityRole="checkbox"
            accessibilityState={{ checked: props.selected, disabled: props.disabled }}
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
          accessibilityLabel={`Open diff for ${props.file.path}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: props.disabled }}
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

export function BranchCommitRow(props: {
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
        accessibilityLabel={`${props.commit.message}, ${props.direction} commit`}
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
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

export function CompactTag(props: { readonly label: string }) {
  return (
    <View className="rounded-full bg-subtle px-2 py-0.5">
      <Text className="text-2xs font-t3-bold uppercase text-foreground-muted">{props.label}</Text>
    </View>
  );
}

export function RepositorySummary(props: { readonly snapshot: VcsPanelSnapshotResult }) {
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
