import type { ProjectEntry } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  buildFileTree,
  defaultExpandedTreePaths,
  flattenFileTree,
  type FileTreeNode,
  type VisibleFileTreeNode,
} from "./fileTree";

const fileTreeCache = new WeakMap<ReadonlyArray<ProjectEntry>, ReadonlyArray<FileTreeNode>>();
const FILE_TREE_INITIAL_RENDER_COUNT = 20;
const FILE_TREE_RENDER_BATCH_SIZE = 12;
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
  readonly iconColor: string;
  readonly onPressDirectory: (path: string) => void;
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
          props.onPressDirectory(node.path);
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
          tintColor={props.iconColor}
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
            : "font-t3-medium text-foreground-secondary",
        )}
        numberOfLines={1}
      >
        {node.name}
      </Text>
      {node.kind === "directory" ? (
        <Text className="text-2xs font-t3-medium text-foreground-tertiary">
          {node.children.length}
        </Text>
      ) : null}
    </Pressable>
  );
});

export function FileTreeBrowser(props: {
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly searchQuery: string;
  readonly selectedPath: string | null;
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
  // Native transparent-header height ≈ safe-area top + nav bar (~44). Matches the
  // observed adjustedContentInset bottom (~102) seen in the native trace.
  const headerInset = Platform.OS === "ios" ? insets.top + 44 : 0;
  const iconColor = String(useThemeColor("--color-icon-muted"));
  const { onPreviewFile, onSelectFile, selectedPath: controlledSelectedPath } = props;
  const controlledSelectedPathRef = useRef(controlledSelectedPath);
  const pendingSelectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  controlledSelectedPathRef.current = controlledSelectedPath;

  const selectedPath =
    pendingSelection?.selectedPathAtPress === controlledSelectedPath
      ? pendingSelection.path
      : controlledSelectedPath;
  const tree = useMemo(() => cachedFileTree(props.entries), [props.entries]);
  const defaultExpanded = useMemo(() => defaultExpandedTreePaths(tree), [tree]);
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
    setExpandedPaths((current) => {
      if (current.size > 0 || defaultExpanded.size === 0) {
        return current;
      }
      return new Set(defaultExpanded);
    });
  }, [defaultExpanded]);

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

  useEffect(
    () => () => {
      if (pendingSelectionTimeoutRef.current !== null) {
        clearTimeout(pendingSelectionTimeoutRef.current);
      }
    },
    [],
  );

  const toggleDirectory = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);
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
        iconColor={iconColor}
        onPressDirectory={toggleDirectory}
        onPreviewFile={onPreviewFile}
        onPressFile={handleSelectFile}
      />
    ),
    [expandedPaths, handleSelectFile, iconColor, onPreviewFile, selectedPath, toggleDirectory],
  );

  if (props.error && props.entries.length === 0) {
    return (
      <View className="flex-1 bg-sheet px-4 py-5">
        <Text className="text-sm font-t3-bold text-foreground">Files unavailable</Text>
        <Text className="mt-1 text-xs leading-normal text-foreground-muted">{props.error}</Text>
      </View>
    );
  }

  // SPIKE: render the FlatList as the screen's DIRECT content (no wrapping View), and
  // mirror the Home ScrollView exactly — `contentInsetAdjustmentBehavior: "automatic"`
  // with NO manual contentInset. iOS only applies the nav-bar top inset + scroll-edge
  // blur to a scroll view in the screen's primary position; a scroll view buried in
  // flex-1 Views is ignored, which is why the tree rendered under the header with no blur.
  return (
    <FlatList
      className="flex-1"
      data={visibleNodes}
      keyExtractor={(item) => item.node.path}
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      scrollIndicatorInsets={
        Platform.OS === "ios" ? { top: headerInset, left: 0, right: 0, bottom: 0 } : undefined
      }
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      initialNumToRender={FILE_TREE_INITIAL_RENDER_COUNT}
      maxToRenderPerBatch={FILE_TREE_RENDER_BATCH_SIZE}
      updateCellsBatchingPeriod={16}
      windowSize={5}
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 8 }}
      refreshControl={<RefreshControl refreshing={props.isPending} onRefresh={props.onRefresh} />}
      renderItem={renderItem}
      ListEmptyComponent={
        <View className="px-4 py-5">
          {props.isPending ? (
            <ActivityIndicator size="small" />
          ) : (
            <>
              <Text className="text-sm font-t3-bold text-foreground">No files found</Text>
              <Text className="mt-1 text-xs leading-normal text-foreground-muted">
                {props.searchQuery.trim().length > 0
                  ? "Try a different search."
                  : "The workspace file index is empty."}
              </Text>
            </>
          )}
        </View>
      }
    />
  );
}
