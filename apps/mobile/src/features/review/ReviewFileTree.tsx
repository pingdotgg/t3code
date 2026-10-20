import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { reviewFileTreeRows, reviewFolderContains } from "@t3tools/client-runtime/review-workspace";
import * as Clipboard from "expo-clipboard";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { ReviewRenamePath } from "./ReviewRenamePath";

export interface ReviewFileTreeItem {
  readonly path: string;
  readonly previousPath?: string | null;
  readonly changeType: string;
  readonly additions: number;
  readonly deletions: number;
  readonly reviewed?: boolean;
  readonly unresolved?: number;
}

/** Virtualized folder navigation for native PR and working-change readers. */
export function ReviewFileTree({
  files,
  reviewFiles = files,
  onSelectFile,
  onSetViewed,
  reviewActionLabels,
  onRefresh,
  refreshing = false,
  showViewedCheckbox = false,
}: {
  files: ReadonlyArray<ReviewFileTreeItem>;
  reviewFiles?: ReadonlyArray<ReviewFileTreeItem>;
  reviewActionLabels?: { mark: string; unmark: string };
  onSelectFile: (path: string) => void;
  onSetViewed?: ((paths: ReadonlyArray<string>, viewed: boolean) => void) | undefined;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean;
  showViewedCheckbox?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [width, setWidth] = useState(0);
  const rows = useMemo(
    () => reviewFileTreeRows(files, (file) => file.path, collapsed),
    [files, collapsed],
  );
  const folderCounts = useMemo(() => {
    const counts = new Map<string, { unresolved: number; reviewed: number; total: number }>();
    for (const file of files) {
      const parts = file.path.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        const path = parts.slice(0, depth).join("/");
        const count = counts.get(path) ?? { unresolved: 0, reviewed: 0, total: 0 };
        counts.set(path, {
          unresolved: count.unresolved + (file.unresolved ?? 0),
          reviewed: count.reviewed + Number(file.reviewed === true),
          total: count.total + 1,
        });
      }
    }
    return counts;
  }, [files]);
  return (
    <AnimatedLegendList
      style={{ flex: 1 }}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined
      }
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      data={rows}
      keyExtractor={(row) => `${row.kind}:${row.path}`}
      estimatedItemSize={42}
      recycleItems
      renderItem={({ item }) => {
        if (item.kind === "folder") {
          const count = folderCounts.get(item.path);
          const reviewed = count !== undefined && count.total > 0 && count.reviewed === count.total;
          const reviewDescendants = reviewFiles.filter((file) =>
            reviewFolderContains(item.path, file.path),
          );
          const canMarkReviewed = reviewDescendants.some((file) => !file.reviewed);
          const canMarkUnreviewed = reviewDescendants.some((file) => file.reviewed);
          return (
            <Menu
              title={item.path}
              shouldOpenOnLongPress
              actions={[
                ...(onSetViewed && canMarkReviewed
                  ? [
                      {
                        id: "mark-reviewed",
                        title: reviewActionLabels?.mark ?? "Mark as reviewed",
                      },
                    ]
                  : []),
                ...(onSetViewed && canMarkUnreviewed
                  ? [
                      {
                        id: "mark-unreviewed",
                        title: reviewActionLabels?.unmark ?? "Mark as unreviewed",
                      },
                    ]
                  : []),
                { id: "copy", title: "Copy folder path" },
              ]}
              onPressAction={({ nativeEvent }) => {
                if (
                  nativeEvent.event === "mark-reviewed" ||
                  nativeEvent.event === "mark-unreviewed"
                )
                  onSetViewed?.(
                    reviewDescendants.map((file) => file.path),
                    nativeEvent.event === "mark-reviewed",
                  );
                else void Clipboard.setStringAsync(item.path);
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.path}, ${count?.unresolved ?? 0} unresolved comments`}
                accessibilityState={{ expanded: !collapsed.has(item.path) }}
                className="min-h-[42px] flex-row items-center gap-2 rounded-xl pr-3"
                style={{ paddingLeft: 12 + Math.min(item.depth * 16, Math.max(0, width - 220)) }}
                onPress={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(item.path)) next.delete(item.path);
                    else next.add(item.path);
                    return next;
                  })
                }
              >
                <SymbolView
                  name={collapsed.has(item.path) ? "chevron.right" : "chevron.down"}
                  size={11}
                  tintColorClassName="accent-icon-muted"
                />
                <SymbolView name="folder" size={16} tintColorClassName="accent-icon-muted" />
                <Text numberOfLines={1} ellipsizeMode="tail" className="min-w-0 flex-1 text-sm">
                  {item.label}
                </Text>
                {(count?.unresolved ?? 0) > 0 ? (
                  <Text className="text-xs text-foreground-muted">{count?.unresolved}</Text>
                ) : null}
                {reviewed ? (
                  <SymbolView
                    name="checkmark"
                    size={14}
                    tintColorClassName="accent-adaptive-emerald-600-400"
                  />
                ) : null}
              </Pressable>
            </Menu>
          );
        }
        const file = item.file;
        const renamed = file.previousPath && file.previousPath !== file.path;
        const status = renamed
          ? "R"
          : file.changeType === "added" || file.changeType === "new"
            ? "A"
            : file.changeType === "deleted"
              ? "D"
              : "M";
        return (
          <Menu
            title={file.path}
            shouldOpenOnLongPress
            actions={[
              { id: "open", title: "View diff" },
              ...(onSetViewed
                ? [
                    {
                      id: "review",
                      title: file.reviewed
                        ? (reviewActionLabels?.unmark ?? "Mark as unreviewed")
                        : (reviewActionLabels?.mark ?? "Mark as reviewed"),
                    },
                  ]
                : []),
              { id: "copy", title: "Copy full path" },
              ...(renamed
                ? [{ id: "copy-old", title: `Copy old path: ${file.previousPath}` }]
                : []),
            ]}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "open") onSelectFile(file.path);
              else if (nativeEvent.event === "review") onSetViewed?.([file.path], !file.reviewed);
              else
                void Clipboard.setStringAsync(
                  nativeEvent.event === "copy-old" ? (file.previousPath ?? file.path) : file.path,
                );
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${file.path}${renamed ? `, renamed from ${file.previousPath}` : ""}, ${file.unresolved ?? 0} unresolved comments`}
              className="min-h-[42px] flex-row items-center gap-2 rounded-xl pr-3"
              style={{ paddingLeft: 28 + Math.min(item.depth * 16, Math.max(0, width - 220)) }}
              onPress={() => onSelectFile(file.path)}
            >
              <PierreEntryIcon kind="file" path={file.path} size={18} />
              <View className="min-w-0 flex-1 py-1">
                {file.previousPath && file.previousPath !== file.path ? (
                  <ReviewRenamePath
                    path={file.path}
                    previousPath={file.previousPath}
                    directory={false}
                  />
                ) : (
                  <Text numberOfLines={1} ellipsizeMode="tail" className="text-sm">
                    {file.path.split("/").at(-1)}
                  </Text>
                )}
              </View>
              {(file.unresolved ?? 0) > 0 ? (
                <Text className="text-xs text-foreground-muted">{file.unresolved}</Text>
              ) : null}
              <Text
                className={
                  status === "A"
                    ? "text-xs text-adaptive-emerald-600-400"
                    : status === "D"
                      ? "text-xs text-danger-foreground"
                      : status === "R"
                        ? "text-xs text-warning-foreground"
                        : "text-xs text-foreground-muted"
                }
              >
                {status}
              </Text>
              {showViewedCheckbox ? (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={`Mark ${file.path} as ${file.reviewed ? "unviewed" : "viewed"}`}
                  accessibilityState={{ checked: file.reviewed === true, disabled: !onSetViewed }}
                  disabled={!onSetViewed}
                  className="min-h-11 min-w-11 items-center justify-center"
                  onPress={(event) => {
                    event.stopPropagation();
                    onSetViewed?.([file.path], !file.reviewed);
                  }}
                >
                  <View
                    className={
                      file.reviewed
                        ? "size-4 items-center justify-center rounded border border-adaptive-emerald-600-400 bg-adaptive-emerald-600-400"
                        : "size-4 rounded border border-border"
                    }
                  >
                    {file.reviewed ? (
                      <SymbolView
                        name="checkmark"
                        size={11}
                        tintColorClassName="accent-primary-foreground"
                      />
                    ) : null}
                  </View>
                </Pressable>
              ) : file.reviewed ? (
                <SymbolView
                  name="checkmark"
                  size={14}
                  tintColorClassName="accent-adaptive-emerald-600-400"
                />
              ) : null}
            </Pressable>
          </Menu>
        );
      }}
    />
  );
}
