import type { ProjectEntry } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  buildFileTree,
  defaultExpandedTreePaths,
  flattenFileTree,
  type VisibleFileTreeNode,
} from "./fileTree";

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
  readonly selectedPath: string | null;
  readonly expanded: boolean;
  readonly iconColor: string;
  readonly onPressDirectory: (path: string) => void;
  readonly onPressFile: (path: string) => void;
}) {
  const { node, depth } = props.item;
  const selected = node.kind === "file" && node.path === props.selectedPath;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={node.path}
      onPress={() => {
        if (node.kind === "directory") {
          props.onPressDirectory(node.path);
          return;
        }
        props.onPressFile(node.path);
      }}
      className={cn(
        "mx-2 min-h-[42px] flex-row items-center gap-2 rounded-[12px] px-2 active:bg-subtle",
        selected && "bg-subtle-strong",
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
          "min-w-0 flex-1 text-[14px] leading-[19px]",
          selected ? "font-t3-bold text-foreground" : "font-t3-medium text-foreground-secondary",
        )}
        numberOfLines={1}
      >
        {node.name}
      </Text>
      {node.kind === "directory" ? (
        <Text className="text-[11px] font-t3-medium text-foreground-tertiary">
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
  readonly onRefresh: () => void;
  readonly onSelectFile: (path: string) => void;
}) {
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const iconColor = String(useThemeColor("--color-icon-muted"));

  const tree = useMemo(() => buildFileTree(props.entries), [props.entries]);
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
    if (!props.selectedPath) {
      return;
    }
    setExpandedPaths((current) => {
      const next = new Set(current);
      for (const ancestor of ancestorPaths(props.selectedPath ?? "")) {
        next.add(ancestor);
      }
      return next;
    });
  }, [props.selectedPath]);

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

  return (
    <View className="flex-1 bg-sheet">
      {props.error && props.entries.length === 0 ? (
        <View className="px-4 py-5">
          <Text className="text-[13px] font-t3-bold text-foreground">Files unavailable</Text>
          <Text className="mt-1 text-[12px] leading-[18px] text-foreground-muted">
            {props.error}
          </Text>
        </View>
      ) : (
        <FlatList
          data={visibleNodes}
          keyExtractor={(item) => item.node.path}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingVertical: 8 }}
          refreshControl={
            <RefreshControl refreshing={props.isPending} onRefresh={props.onRefresh} />
          }
          renderItem={({ item }) => (
            <FileTreeRow
              item={item}
              selectedPath={props.selectedPath}
              expanded={expandedPaths.has(item.node.path)}
              iconColor={iconColor}
              onPressDirectory={toggleDirectory}
              onPressFile={props.onSelectFile}
            />
          )}
          ListEmptyComponent={
            <View className="px-4 py-5">
              {props.isPending ? (
                <ActivityIndicator size="small" />
              ) : (
                <>
                  <Text className="text-[13px] font-t3-bold text-foreground">No files found</Text>
                  <Text className="mt-1 text-[12px] leading-[18px] text-foreground-muted">
                    {props.searchQuery.trim().length > 0
                      ? "Try a different search."
                      : "The workspace file index is empty."}
                  </Text>
                </>
              )}
            </View>
          }
        />
      )}
    </View>
  );
}
