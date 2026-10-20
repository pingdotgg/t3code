import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { reviewFileTreeRows, reviewFolderContains } from "@t3tools/client-runtime/review-workspace";
import {
  reviewTreeRowKey,
  selectReviewTreeRows,
  reviewTreeActionFiles,
  type ReviewTreeRow,
  type ReviewTreeSelection,
} from "@t3tools/client-runtime/review-tree-selection";
import { ChevronDown, ChevronRight, Minus, Plus, Undo2, PanelsTopLeft } from "lucide";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "~/hooks/useTheme";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuPopup } from "../ui/menu";
import { ReviewPath } from "./ReviewPath";
import type { DiffFileTreeEntry } from "./diffFileTree.logic";

type Scope = "staged" | "unstaged";
type Row =
  | { kind: "section"; scope: Scope; path: string }
  | (ReturnType<typeof reviewFileTreeRows<DiffFileTreeEntry>>[number] & { scope: Scope });

/** One virtualized list keeps Git sections adjacent and exposes actions beside every row. */
export function WorkingChangesTree({
  staged,
  unstaged,
  selected,
  disabled,
  revertDisabled,
  onSelect,
  onStage,
  onRevert,
  onViewAll,
}: {
  staged: ReadonlyArray<DiffFileTreeEntry>;
  unstaged: ReadonlyArray<DiffFileTreeEntry>;
  selected: { scope: Scope; path: string } | null;
  disabled: boolean;
  revertDisabled: boolean;
  onSelect: (scope: Scope, path: string) => void;
  onStage: (scope: Scope, paths: ReadonlyArray<string> | null) => void;
  onRevert: (paths: ReadonlyArray<string> | null) => void;
  onViewAll: (scope: Scope) => void;
}) {
  const { resolvedTheme } = useTheme();
  const list = useRef<LegendListRef | null>(null);
  const [open, setOpen] = useState({ staged: true, unstaged: true });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selection, setSelection] = useState<ReviewTreeSelection>(() => ({
    rows: selected ? [{ ...selected, kind: "file" }] : [],
    anchor: selected ? { ...selected, kind: "file" } : null,
  }));
  const [contextMenu, setContextMenu] = useState<{
    row: ReviewTreeRow;
    x: number;
    y: number;
  } | null>(null);
  const menuAnchor = contextMenu
    ? { getBoundingClientRect: () => new DOMRect(contextMenu.x, contextMenu.y, 0, 0) }
    : undefined;
  const lastRevealed = useRef<string | null>(null);
  const sections = { staged, unstaged };
  const sectionPaths = {
    staged: staged.map((file) => file.path),
    unstaged: unstaged.map((file) => file.path),
  };
  const rows = (["staged", "unstaged"] as const).flatMap((scope) => [
    { kind: "section" as const, scope, path: scope },
    ...(open[scope]
      ? reviewFileTreeRows(
          scope === "staged" ? staged : unstaged,
          (entry) => entry.path,
          new Set(
            [...collapsed]
              .filter((key) => key.startsWith(`${scope}:`))
              .map((key) => key.slice(scope.length + 1)),
          ),
        ).map((row) => ({ ...row, scope }))
      : []),
  ]) satisfies Row[];
  const selectableRows = rows.filter((row) => row.kind !== "section");
  const selectedKeys = new Set(selection.rows.map(reviewTreeRowKey));
  const selectedFolders = selection.rows.filter((row) => row.kind === "folder");
  const isInSelection = (row: ReviewTreeRow) =>
    selectedKeys.has(reviewTreeRowKey(row)) ||
    selectedFolders.some(
      (folder) => folder.scope === row.scope && reviewFolderContains(folder.path, row.path),
    );
  const contextPaths = contextMenu
    ? reviewTreeActionFiles(sectionPaths[contextMenu.row.scope], selection.rows, contextMenu.row)
    : [];
  const revealScope = selected?.scope;
  const revealPath = selected?.path;
  const revealKey = selected ? reviewTreeRowKey(selected) : null;
  useEffect(() => {
    if (revealKey === lastRevealed.current) return;
    const index = rows.findIndex(
      (row) => row.kind === "file" && row.scope === revealScope && row.path === revealPath,
    );
    if (index >= 0) {
      lastRevealed.current = revealKey;
      list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
    }
    if (revealKey === null) lastRevealed.current = null;
  }, [rows, revealScope, revealPath, revealKey]);
  const toggleFolder = (row: ReviewTreeRow) =>
    setCollapsed((current) => {
      const next = new Set(current);
      const key = `${row.scope}:${row.path}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const actions = (scope: Scope, row: ReviewTreeRow | null) => {
    const path = row?.path ?? null;
    const groupTarget = row && isInSelection(row);
    const label =
      groupTarget && (selection.rows.length > 1 || row.kind === "folder")
        ? "selected files"
        : (path ?? "all files");
    const targets = () => reviewTreeActionFiles(sectionPaths[scope], selection.rows, row);
    return (
      <div className="flex shrink-0 items-center gap-0">
        {scope === "unstaged" ? (
          <Button
            size="icon-micro"
            variant="ghost"
            disabled={revertDisabled || unstaged.length === 0}
            aria-label={path ? `Revert ${label}` : "Revert all unstaged changes"}
            onClick={() => onRevert(row ? targets() : null)}
          >
            <MorphIcon icon={Undo2} />
          </Button>
        ) : null}
        <Button
          size="icon-micro"
          variant="ghost"
          disabled={disabled || sections[scope].length === 0}
          aria-label={`${scope === "staged" ? "Unstage" : "Stage"} ${label}`}
          onClick={() => onStage(scope, row ? targets() : null)}
        >
          <MorphIcon icon={scope === "staged" ? Minus : Plus} />
        </Button>
      </div>
    );
  };
  return (
    <div
      role="tree"
      aria-label="Git files"
      aria-multiselectable="true"
      className="flex min-h-0 flex-1 flex-col"
    >
      <LegendList
        ref={list}
        data={rows}
        keyExtractor={(row) => `${row.scope}:${row.kind}:${row.path}`}
        estimatedItemSize={24}
        drawDistance={240}
        className="min-h-0 flex-1 overflow-x-hidden px-4"
        extraData={{ selected, selectedKeys, disabled, revertDisabled, resolvedTheme }}
        renderItem={({ item: row }) => {
          if (row.kind === "section")
            return (
              <div className="flex h-6 items-center gap-1 px-1.5" data-git-section={row.scope}>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium"
                  aria-expanded={open[row.scope]}
                  onClick={() =>
                    setOpen((current) => ({ ...current, [row.scope]: !current[row.scope] }))
                  }
                >
                  <MorphIcon
                    className="size-3.5"
                    icon={open[row.scope] ? ChevronDown : ChevronRight}
                  />
                  {row.scope === "staged" ? "Staged" : "Unstaged"}
                </button>
                <Badge variant="info" size="sm">
                  {sections[row.scope].length}
                </Badge>
                <Button
                  size="icon-micro"
                  variant="ghost"
                  aria-label={`View all ${row.scope} changes`}
                  disabled={sections[row.scope].length === 0}
                  onClick={() => onViewAll(row.scope)}
                >
                  <MorphIcon icon={PanelsTopLeft} />
                </Button>
                {actions(row.scope, null)}
              </div>
            );
          const folder = row.kind === "folder";
          const batchSelected = selectedKeys.has(reviewTreeRowKey(row));
          const current = selected?.scope === row.scope && selected.path === row.path;
          const status = folder ? "modified" : row.file.status;
          const statusColor =
            status === "added" || status === "untracked"
              ? "light-dark(#16a994, #00cab1)"
              : status === "deleted"
                ? "light-dark(#ff2e3f, #ff6762)"
                : status === "renamed"
                  ? "light-dark(#d5a910, #ffd452)"
                  : "light-dark(#1ca1c7, #08c0ef)";
          return (
            <div
              data-git-scope={row.scope}
              data-git-path={row.path}
              data-git-active={current || undefined}
              role="treeitem"
              aria-selected={batchSelected}
              aria-level={row.depth + 1}
              aria-expanded={folder ? !collapsed.has(`${row.scope}:${row.path}`) : undefined}
              className={`group relative flex h-6 min-w-0 items-center gap-1 rounded-md pr-1.5 text-xs ${batchSelected ? "bg-foreground/10" : "hover:bg-foreground/5"} ${current ? "ring-1 ring-inset ring-ring" : ""}`}
              style={{
                paddingLeft: `calc(6.4px + min(${row.depth * 18.7}px, max(0px, 100% - 180px)))`,
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!isInSelection(row)) setSelection({ rows: [row], anchor: row });
                setContextMenu({ row, x: event.clientX, y: event.clientY });
              }}
            >
              {folder ? (
                <button
                  type="button"
                  aria-label={`${collapsed.has(`${row.scope}:${row.path}`) ? "Expand" : "Collapse"} ${row.path}`}
                  className="flex size-4 shrink-0 items-center justify-center text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => toggleFolder(row)}
                >
                  <MorphIcon
                    className="size-4"
                    icon={collapsed.has(`${row.scope}:${row.path}`) ? ChevronRight : ChevronDown}
                  />
                </button>
              ) : null}
              <button
                type="button"
                className={`flex min-w-0 flex-1 items-center gap-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${row.scope === "unstaged" ? "group-hover:pr-11 group-focus-within:pr-11" : "group-hover:pr-6 group-focus-within:pr-6"}`}
                aria-label={`${row.scope}: ${row.path}`}
                aria-current={!folder && current ? "true" : undefined}
                onMouseDown={(event) => {
                  if (event.shiftKey) event.preventDefault();
                }}
                onClick={(event) => {
                  const toggle = event.metaKey || event.ctrlKey;
                  setSelection((previous) =>
                    selectReviewTreeRows(previous, selectableRows, row, {
                      toggle,
                      range: event.shiftKey,
                    }),
                  );
                  if (toggle || event.shiftKey) return;
                  if (folder) toggleFolder(row);
                  else {
                    lastRevealed.current = reviewTreeRowKey(row);
                    onSelect(row.scope, row.path);
                  }
                }}
              >
                {!folder ? (
                  <PierreEntryIcon pathValue={row.path} kind="file" theme={resolvedTheme} />
                ) : null}
                <ReviewPath path={row.path} className="min-w-0 flex-1 truncate">
                  <span
                    style={{ color: folder ? undefined : statusColor, colorScheme: resolvedTheme }}
                  >
                    {folder ? row.label.replaceAll("/", " / ") : row.path.split("/").at(-1)}
                  </span>
                </ReviewPath>
              </button>
              <div className="pointer-events-none absolute right-6 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                {actions(row.scope, row)}
              </div>
              <span
                className={`w-3 shrink-0 text-center ${folder ? "opacity-50" : ""}`}
                style={{ color: statusColor, colorScheme: resolvedTheme }}
                aria-label={folder ? "Contains changes" : row.file.status}
              >
                {folder
                  ? "•"
                  : row.file.status === "added"
                    ? "A"
                    : row.file.status === "deleted"
                      ? "D"
                      : row.file.status === "renamed"
                        ? "R"
                        : "M"}
              </span>
            </div>
          );
        }}
      />
      <Menu
        open={contextMenu !== null}
        onOpenChange={(open) => {
          if (!open) setContextMenu(null);
        }}
      >
        <MenuPopup anchor={menuAnchor} align="start">
          {contextMenu ? (
            <>
              <MenuItem
                disabled={disabled || contextPaths.length === 0}
                onClick={() => {
                  onStage(contextMenu.row.scope, contextPaths);
                  setContextMenu(null);
                }}
              >
                <MorphIcon icon={contextMenu.row.scope === "staged" ? Minus : Plus} />
                {contextMenu.row.scope === "staged" ? "Unstage changes" : "Stage changes"}
              </MenuItem>
              {contextMenu.row.scope === "unstaged" ? (
                <MenuItem
                  variant="destructive"
                  disabled={revertDisabled || contextPaths.length === 0}
                  onClick={() => {
                    onRevert(contextPaths);
                    setContextMenu(null);
                  }}
                >
                  <MorphIcon icon={Undo2} />
                  Revert changes
                </MenuItem>
              ) : null}
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}
