import { LegendList } from "@legendapp/list/react-native";
import type { ProjectEntry } from "@t3tools/contracts";
import { SymbolView } from "../../components/AppSymbol";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { cn } from "../../lib/cn";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import {
  buildFileTree,
  flattenFileTree,
  type FileTreeNode,
  type VisibleFileTreeNode,
} from "./fileTree";

const fileTreeCache = new WeakMap<ReadonlyArray<ProjectEntry>, ReadonlyArray<FileTreeNode>>();
const OPTIMISTIC_SELECTION_TIMEOUT_MS = 1_000;

function cachedFileTree(entries: ReadonlyArray<ProjectEntry>): ReadonlyArray<FileTreeNode> {
  const cached = fileTreeCache.get(entries);
  if (cached !== undefined) {
    return cached;
  }
  const tree = buildFileTree(entries);
  fileTreeCache.set(entries, tree);
  return tree;
}

function ancestorPaths(path: string): ReadonlyArray<string> {
  const parts = path.split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join("/"));
  }
  return ancestors;
}

const FileTreeRow = memo(function FileTreeRow(props: {
  readonly item: VisibleFileTreeNode;
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly loading: boolean;
  readonly onPressDirectory: (path: string, expand: boolean) => void;
  readonly onPreviewFile?: (path: string) => void;
  readonly onPressFile: (path: string) => void;
}) {
  const { node, depth } = props.item;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={node.path}
      onPressIn={() => {
        if (node.kind === "file") {
          props.onPreviewFile?.(node.path);
        }
      }}
      onPress={() => {
        if (node.kind === "directory") {
          props.onPressDirectory(node.path, !props.expanded);
          return;
        }
        props.onPressFile(node.path);
      }}
      className={cn(
        "mx-2 min-h-[42px] flex-row items-center gap-2 rounded-[12px] px-2 active:bg-subtle",
        props.selected && "bg-subtle-strong",
      )}
      style={{ paddingLeft: 8 + depth * 18 }}
    >
      {node.kind === "directory" ? (
        <SymbolView
          name={props.expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      ) : (
        <View className="w-3" />
      )}
      <PierreEntryIcon path={node.path} kind={node.kind} size={17} />
      <Text
        className={cn(
          "min-w-0 flex-1 text-sm leading-normal",
          props.selected
            ? "font-t3-bold text-foreground"
            : node.ignored
              ? "font-t3-medium text-foreground-tertiary"
              : "font-t3-medium text-foreground-secondary",
        )}
        numberOfLines={1}
      >
        {node.name}
      </Text>
      {node.kind === "directory" && props.expanded && props.loading ? (
        <ActivityIndicator size="small" accessibilityLabel={`Loading ${node.name}`} />
      ) : null}
    </Pressable>
  );
});

export function FileTreeBrowser(props: {
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly isRefreshing: boolean;
  readonly searchQuery: string;
  readonly searchTruncated: boolean;
  readonly selectedPath: string | null;
  readonly loadingDirectories: ReadonlySet<string>;
  readonly onLoadDirectory: (path: string) => void;
  readonly onPreviewFile?: (path: string) => void;
  readonly onRefresh: () => void;
  readonly onSelectFile: (path: string) => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingSelection, setPendingSelection] = useState<{
    readonly path: string;
    readonly selectedPathAtPress: string | null;
  } | null>(null);
  const insets = useSafeAreaInsets();
  const columnMetrics = useNativeColumnLayoutMetrics();
  const headerInset = Platform.OS === "ios" ? (columnMetrics?.safeArea.top ?? insets.top) : 0;
  const {
    onLoadDirectory,
    onPreviewFile,
    onSelectFile,
    loadingDirectories,
    selectedPath: controlledSelectedPath,
  } = props;
  const controlledSelectedPathRef = useRef(controlledSelectedPath);
  const pendingSelectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  controlledSelectedPathRef.current = controlledSelectedPath;

  const selectedPath =
    pendingSelection?.selectedPathAtPress === controlledSelectedPath
      ? pendingSelection.path
      : controlledSelectedPath;
  const tree = useMemo(() => cachedFileTree(props.entries), [props.entries]);
  const visibleNodes = useMemo(
    () =>
      flattenFileTree({
        nodes: tree,
        expanded: expandedPaths,
        searchQuery: props.searchQuery,
      }),
    [expandedPaths, props.searchQuery, tree],
  );

  useEffect(() => {
    if (!controlledSelectedPath) {
      return;
    }
    setExpandedPaths((current) => {
      const ancestors = ancestorPaths(controlledSelectedPath);
      if (ancestors.every((ancestor) => current.has(ancestor))) {
        return current;
      }
      const next = new Set(current);
      for (const ancestor of ancestors) {
        next.add(ancestor);
      }
      return next;
    });
  }, [controlledSelectedPath]);

  useEffect(() => {
    for (const path of expandedPaths) onLoadDirectory(path);
  }, [expandedPaths, onLoadDirectory]);

  useEffect(
    () => () => {
      if (pendingSelectionTimeoutRef.current !== null) {
        clearTimeout(pendingSelectionTimeoutRef.current);
      }
    },
    [],
  );

  const toggleDirectory = useCallback(
    (path: string, expand: boolean) => {
      if (expand) onLoadDirectory(path);
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
    },
    [onLoadDirectory],
  );
  const handleSelectFile = useCallback(
    (path: string) => {
      if (pendingSelectionTimeoutRef.current !== null) {
        clearTimeout(pendingSelectionTimeoutRef.current);
      }
      setPendingSelection({
        path,
        selectedPathAtPress: controlledSelectedPathRef.current,
      });
      pendingSelectionTimeoutRef.current = setTimeout(() => {
        pendingSelectionTimeoutRef.current = null;
        setPendingSelection((current) => (current?.path === path ? null : current));
      }, OPTIMISTIC_SELECTION_TIMEOUT_MS);
      onSelectFile(path);
    },
    [onSelectFile],
  );
  const renderItem = useCallback(
    ({ item }: { readonly item: VisibleFileTreeNode }) => (
      <FileTreeRow
        item={item}
        selected={item.node.kind === "file" && item.node.path === selectedPath}
        expanded={expandedPaths.has(item.node.path)}
        loading={loadingDirectories.has(item.node.path)}
        onPressDirectory={toggleDirectory}
        onPreviewFile={onPreviewFile}
        onPressFile={handleSelectFile}
      />
    ),
    [
      expandedPaths,
      handleSelectFile,
      onPreviewFile,
      loadingDirectories,
      selectedPath,
      toggleDirectory,
    ],
  );

  const extraData = useMemo(
    () => ({ expandedPaths, loadingDirectories, selectedPath }),
    [expandedPaths, loadingDirectories, selectedPath],
  );

  // UIKit owns the header inset on every supported iOS version. Keep the
  // list as direct screen content so automatic inset adjustment can find it.
  return (
    <LegendList
      contentInsetStartAdjustment={headerInset}
      alwaysBounceVertical
      className="flex-1"
      data={visibleNodes}
      keyExtractor={(item) => item.node.path}
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      estimatedItemSize={42}
      recycleItems
      maintainVisibleContentPosition
      extraData={extraData}
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 8 }}
      refreshControl={
        <RefreshControl refreshing={props.isRefreshing} onRefresh={props.onRefresh} />
      }
      renderItem={renderItem}
      ListHeaderComponent={
        <>
          {props.error && props.entries.length > 0 ? (
            <Text accessibilityRole="alert" className="mx-4 my-2 text-xs text-foreground-muted">
              {props.error}
            </Text>
          ) : null}
          {props.searchTruncated ? (
            <Text className="mx-4 my-2 text-xs text-foreground-muted">
              More search results available. Refine your search to see them.
            </Text>
          ) : null}
        </>
      }
      ListEmptyComponent={
        <View className="px-4 py-5">
          {props.error && props.entries.length === 0 ? (
            <>
              <Text className="text-sm font-t3-bold text-foreground">Files unavailable</Text>
              <Text
                accessibilityRole="alert"
                className="mt-1 text-xs leading-normal text-foreground-muted"
              >
                {props.error}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={props.onRefresh}
                disabled={props.isPending}
                className="mt-3 min-h-11 self-start justify-center rounded-full bg-subtle px-4 active:opacity-70 disabled:opacity-50"
              >
                <Text className="text-sm font-t3-medium text-foreground">Try again</Text>
              </Pressable>
            </>
          ) : props.isPending ? (
            <ActivityIndicator size="small" />
          ) : (
            <>
              <Text className="text-sm font-t3-bold text-foreground">No files found</Text>
              <Text className="mt-1 text-xs leading-normal text-foreground-muted">
                {props.searchQuery.trim().length > 0
                  ? "Try a different search."
                  : "The workspace is empty."}
              </Text>
            </>
          )}
        </View>
      }
    />
  );
}
