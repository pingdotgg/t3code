import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { reviewFileTreeRows } from "@t3tools/client-runtime/review-workspace";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { PierreEntryIcon } from "../../components/PierreEntryIcon";
import type { ReviewRenderableFile } from "./reviewModel";
import { ReviewRenamePath } from "./ReviewRenamePath";

export type WorkingScope = "staged" | "unstaged";
type Row =
  | { kind: "section"; scope: WorkingScope; path: string }
  | (ReturnType<typeof reviewFileTreeRows<ReviewRenderableFile>>[number] & { scope: WorkingScope });

/** Compact Git navigation matches the existing native Files tree row density. */
export function WorkingChangesTree({
  staged,
  unstaged,
  selected,
  disabled,
  revertDisabled,
  onSelect,
  onStage,
  onRevert,
  onOpenScope,
  onRefresh,
  refreshing = false,
}: {
  staged: ReadonlyArray<ReviewRenderableFile>;
  unstaged: ReadonlyArray<ReviewRenderableFile>;
  selected: { scope: WorkingScope; path: string } | null;
  disabled: boolean;
  revertDisabled: boolean;
  onSelect: (scope: WorkingScope, path: string) => void;
  onStage: (scope: WorkingScope, path: string | null) => void;
  onRevert: (path: string | null) => void;
  onOpenScope: (scope: WorkingScope) => void;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean;
}) {
  const [open, setOpen] = useState({ staged: true, unstaged: true });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [width, setWidth] = useState(0);
  const rows = useMemo<Row[]>(
    () =>
      (["staged", "unstaged"] as const).flatMap((scope) => [
        { kind: "section" as const, scope, path: scope },
        ...(open[scope]
          ? reviewFileTreeRows(
              scope === "staged" ? staged : unstaged,
              (file) => file.path,
              new Set(
                [...collapsed]
                  .filter((key) => key.startsWith(`${scope}:`))
                  .map((key) => key.slice(scope.length + 1)),
              ),
            ).map((row) => ({ ...row, scope }))
          : []),
      ]),
    [staged, unstaged, open, collapsed],
  );
  const actions = (scope: WorkingScope, path: string | null) => (
    <View className="flex-row">
      {scope === "unstaged" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={path ? `Revert ${path}` : "Revert all unstaged changes"}
          accessibilityState={{ disabled: revertDisabled || unstaged.length === 0 }}
          disabled={revertDisabled || unstaged.length === 0}
          onPress={() => onRevert(path)}
          className="size-10 items-center justify-center active:bg-secondary"
        >
          <SymbolView
            name="arrow.uturn.backward"
            size={17}
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${scope === "staged" ? "Unstage" : "Stage"} ${path ?? "all files"}`}
        accessibilityState={{
          disabled: disabled || (scope === "staged" ? staged : unstaged).length === 0,
        }}
        disabled={disabled || (scope === "staged" ? staged : unstaged).length === 0}
        onPress={() => onStage(scope, path)}
        className="size-10 items-center justify-center active:bg-secondary"
      >
        <SymbolView
          name={scope === "staged" ? "minus" : "plus"}
          size={17}
          tintColorClassName="accent-icon"
        />
      </Pressable>
    </View>
  );
  return (
    <View className="min-h-0 flex-1" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <AnimatedLegendList
        style={{ flex: 1 }}
        refreshControl={
          onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined
        }
        data={rows}
        keyExtractor={(row) => `${row.scope}:${row.kind}:${row.path}`}
        estimatedItemSize={42}
        recycleItems
        extraData={{ selected, disabled, revertDisabled, width }}
        renderItem={({ item: row }) => {
          if (row.kind === "section")
            return (
              <View className="min-h-[42px] flex-row items-center border-b border-border-subtle pl-3">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={row.scope === "staged" ? "Staged" : "Unstaged"}
                  accessibilityState={{ expanded: open[row.scope] }}
                  className="min-h-[42px] min-w-0 flex-1 flex-row items-center gap-2"
                  onPress={() =>
                    setOpen((current) => ({ ...current, [row.scope]: !current[row.scope] }))
                  }
                >
                  <SymbolView
                    name={open[row.scope] ? "chevron.down" : "chevron.right"}
                    size={12}
                    tintColorClassName="accent-icon-muted"
                  />
                  <Text numberOfLines={1} className="min-w-0 flex-1 text-sm font-t3-semibold">
                    {row.scope === "staged" ? "Staged" : "Unstaged"}
                  </Text>
                </Pressable>
                <Text className="rounded-md bg-secondary px-1.5 text-xs text-foreground-muted">
                  {(row.scope === "staged" ? staged : unstaged).length}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`View all ${row.scope} changes`}
                  disabled={(row.scope === "staged" ? staged : unstaged).length === 0}
                  onPress={() => onOpenScope(row.scope)}
                  className="size-10 items-center justify-center active:bg-secondary"
                >
                  <SymbolView name="doc.text" size={17} tintColorClassName="accent-icon" />
                </Pressable>
                {actions(row.scope, null)}
              </View>
            );
          const folder = row.kind === "folder";
          const active = selected?.scope === row.scope && selected.path === row.path;
          return (
            <View className={`min-h-[42px] flex-row items-center ${active ? "bg-secondary" : ""}`}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${row.scope}: ${row.path}`}
                accessibilityState={
                  folder
                    ? { expanded: !collapsed.has(`${row.scope}:${row.path}`) }
                    : { selected: active }
                }
                className="min-h-[42px] min-w-0 flex-1 flex-row items-center gap-2 pr-1"
                style={{ paddingLeft: 12 + Math.min(row.depth * 16, Math.max(0, width - 300)) }}
                onPress={() =>
                  folder
                    ? setCollapsed((current) => {
                        const next = new Set(current);
                        const key = `${row.scope}:${row.path}`;
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    : onSelect(row.scope, row.path)
                }
              >
                {folder ? (
                  <SymbolView
                    name={
                      collapsed.has(`${row.scope}:${row.path}`) ? "chevron.right" : "chevron.down"
                    }
                    size={12}
                    tintColorClassName="accent-icon-muted"
                  />
                ) : (
                  <View className="w-3" />
                )}
                <PierreEntryIcon kind={folder ? "directory" : "file"} path={row.path} size={17} />
                {!folder && row.file.previousPath && row.file.previousPath !== row.path ? (
                  <ReviewRenamePath
                    path={row.path}
                    previousPath={row.file.previousPath}
                    directory={false}
                  />
                ) : (
                  <Text numberOfLines={1} ellipsizeMode="tail" className="min-w-0 flex-1 text-sm">
                    {folder ? row.label.replaceAll("/", " / ") : row.path.split("/").at(-1)}
                  </Text>
                )}
              </Pressable>
              <Text className="w-4 text-center text-xs text-foreground-muted">
                {folder
                  ? "•"
                  : row.file.previousPath && row.file.previousPath !== row.path
                    ? "R"
                    : row.file.changeType === "new"
                      ? "A"
                      : row.file.changeType === "deleted"
                        ? "D"
                        : "M"}
              </Text>
              {actions(row.scope, row.path)}
            </View>
          );
        }}
      />
    </View>
  );
}
