/**
 * The virtualized changes list.
 *
 * Three invariants, all of which exist because they are cheap to state and
 * expensive to rediscover:
 *
 *  1. `buildChangesRows` is the ONLY row order. The virtualizer, the keyboard,
 *     shift-range selection and the sticky header all index that one array.
 *  2. `changesRowHeight` is the ONLY height source, and it is handed to the
 *     virtualizer as a fixed size rather than measured — the rendered rows set
 *     the same constant explicitly, so the two cannot drift.
 *  3. The sticky group header is an always-mounted overlay, never
 *     `position: sticky`: a windowed row unmounts as it leaves the viewport and
 *     takes its sticky positioning with it.
 *
 * fork: f4 source-control panel
 */
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronDown, ChevronRight, Folder, Loader2, Minus, Plus, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CHANGES_GROUP_TITLE,
  CHANGES_GUTTER,
  CHANGES_ROW_HEIGHT,
  buildChangesRows,
  changesAllFolderKeys,
  changesGroupPaths,
  changesListEmptyState,
  changesMatchingFileCount,
  changesRowHeight,
  changesRowIndent,
  partiallyStagedPaths,
  type ChangesGroup,
  type ChangesGroupScope,
  type ChangesRow,
  type ChangesStatusFilter,
  type ChangesViewMode,
} from "~/lib/sourceControl/changesRows";
import type { WorkingCopyFile } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { ChangeRow } from "./ChangeRow";
import {
  actionTargetRows,
  moveChangesFocus,
  reconcileSelection,
  selectRowRange,
  selectSingleRow,
  stickyChangesGroup,
  targetPaths,
  toggleRowSelection,
  type ChangesSelection,
} from "./changesSelection.logic";
import { EMPTY_CHANGES_SELECTION } from "./changesSelection.logic";
import { anyPathBusy, groupHeaderCountLabel, groupIsCollapsible } from "./sourceControlPanel.logic";

/**
 * fork: f4 focus model — the keys this listbox consumes. Exported so the
 * scoping rule is testable without a DOM.
 */
export const CHANGES_LIST_OWNED_KEYS: ReadonlySet<string> = new Set([
  "j",
  "k",
  "s",
  "u",
  "x",
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "Enter",
  "Backspace",
  "Delete",
  "Escape",
]);

/** fork: f4 redesign — the house eyebrow (`DiagnosticsSettings.tsx:98`). */
const EYEBROW_CLASS =
  "font-medium text-[11px] text-muted-foreground/70 uppercase tracking-[0.08em]";

export interface ChangesListProps {
  readonly files: ReadonlyArray<WorkingCopyFile>;
  readonly viewMode: ChangesViewMode;
  readonly filter: ChangesStatusFilter;
  readonly query: string;
  readonly collapsedGroups: ReadonlyArray<string>;
  readonly collapsedFolders: ReadonlyArray<string>;
  readonly busyPaths: ReadonlySet<string>;
  readonly onToggleGroup: (group: ChangesGroup) => void;
  readonly onToggleFolder: (folderKey: string) => void;
  readonly onSetCollapsedFolders: (folderKeys: ReadonlyArray<string>) => void;
  readonly onStage: (paths: ReadonlyArray<string>) => void;
  readonly onUnstage: (paths: ReadonlyArray<string>) => void;
  readonly onDiscard: (paths: ReadonlyArray<string>) => void;
  readonly onResolve: (path: string, side?: "ours" | "theirs") => void;
  readonly onOpenDiff: (file: WorkingCopyFile) => void;
  /** fork: f4 redesign — the "Clear filter" action on the filtered empty state. */
  readonly onClearFilters: () => void;
  /**
   * fork: f4 — a keyboard action that resolved to no rows. The list itself has
   * nothing useful to draw for that, and silence is the defect being fixed.
   */
  readonly onEmptyKeyboardTarget?: (action: "stage" | "unstage" | "discard") => void;
}

/** `aria-activedescendant` needs a DOM id, and row keys carry `/` and spaces. */
export function changesRowDomId(rowKey: string): string {
  return `sc-row-${fnv1a32Hex(rowKey)}`;
}

function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function ChangesList(props: ChangesListProps) {
  const listRef = useRef<LegendListRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<ChangesSelection>(EMPTY_CHANGES_SELECTION);
  const [scrollTop, setScrollTop] = useState(0);

  const collapsedGroups = useMemo(() => new Set(props.collapsedGroups), [props.collapsedGroups]);
  const collapsedFolders = useMemo(() => new Set(props.collapsedFolders), [props.collapsedFolders]);

  const rows = useMemo(
    () =>
      buildChangesRows({
        files: props.files,
        viewMode: props.viewMode,
        collapsedGroups,
        collapsedFolders,
        filter: props.filter,
        query: props.query,
      }),
    [collapsedFolders, collapsedGroups, props.files, props.filter, props.query, props.viewMode],
  );
  const matchingFileCount = useMemo(
    () => changesMatchingFileCount(props.files, props.filter, props.query),
    [props.files, props.filter, props.query],
  );

  // Computed once per status, not per row.
  const partialPaths = useMemo(() => partiallyStagedPaths(props.files), [props.files]);

  // fork: f4 — the scope every group-header bulk action is cut from. Built from
  // the full file list (not `rows`), so a collapsed folder cannot shrink what
  // "Stage all" means, and scoped to one group, so "Discard all" on a group
  // header cannot reach past that group. See F-08.
  const groupScope = useMemo<ChangesGroupScope>(
    () => ({ files: props.files, filter: props.filter, query: props.query }),
    [props.files, props.filter, props.query],
  );
  const groupPathsOf = useCallback(
    (group: ChangesGroup) => changesGroupPaths(groupScope, group),
    [groupScope],
  );

  /**
   * fork: f4 F-14 — collapse/expand every folder in THIS group, in one press.
   *
   * The old version built its key list from the visible rows, so it collapsed
   * exactly one more level per press, and its "expand" branch cleared the
   * collapse list for every group at once from a single group's header.
   */
  const toggleGroupFolders = useCallback(
    (group: ChangesGroup) => {
      const groupKeys = changesAllFolderKeys(groupScope, group);
      const current = new Set(props.collapsedFolders);
      const allCollapsed = groupKeys.length > 0 && groupKeys.every((key) => current.has(key));
      if (allCollapsed) {
        for (const key of groupKeys) current.delete(key);
      } else {
        for (const key of groupKeys) current.add(key);
      }
      props.onSetCollapsedFolders([...current]);
    },
    [groupScope, props],
  );

  // Drop keys whose rows are gone; identity is preserved when nothing moved so
  // an idle refresh does not re-render the list.
  useEffect(() => {
    setSelection((current) => reconcileSelection(current, rows));
  }, [rows]);

  const heightOptions = useMemo(
    () => ({ hasConflictActions: true, confirmingDiscardKey: null }) as const,
    [],
  );

  const pinnedGroup = useMemo(
    () => stickyChangesGroup(rows, heightOptions, scrollTop),
    [heightOptions, rows, scrollTop],
  );

  /**
   * fork: f4 M13 — the pinned overlay reuses the group's REAL header row, so
   * the counts it prints ("3 of 12") cannot disagree with the header that just
   * scrolled off. The overlay used to be handed `total === visible`, so the
   * label silently changed from "3 of 12" to "3" as you scrolled.
   */
  const pinnedRow = useMemo(
    () =>
      pinnedGroup === null
        ? null
        : (rows.find((row) => row.kind === "header" && row.group === pinnedGroup) ?? null),
    [pinnedGroup, rows],
  );

  /**
   * fork: f4 focus model — DOM focus must actually be inside the listbox, or
   * `s`/`j`/`u`/`x` land in whatever had focus before (the chat composer) and
   * type themselves into it. Selecting a row is therefore always accompanied by
   * a real `focus()` on the container, and the container carries
   * `aria-activedescendant` so the focused row is announced.
   */
  const takeFocus = useCallback(() => {
    const container = containerRef.current;
    if (container === null) return;
    if (container.contains(container.ownerDocument.activeElement)) return;
    container.focus({ preventScroll: true });
  }, []);

  const focusRow = useCallback(
    (key: string | null) => {
      if (key === null) return;
      setSelection(selectSingleRow(key));
      takeFocus();
      const index = rows.findIndex((row) => row.key === key);
      if (index >= 0) {
        listRef.current?.scrollToIndex({ index, viewPosition: 0.5 });
      }
    },
    [rows, takeFocus],
  );

  /**
   * Focusing the listbox with nothing selected seeds the first file row, so the
   * documented `s` / `u` / `x` keys act on something rather than returning
   * early with no feedback (F-15).
   */
  const handleContainerFocus = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (selection.focusedKey !== null) return;
      const first = moveChangesFocus(rows, null, "first");
      if (first !== null) setSelection(selectSingleRow(first));
    },
    [rows, selection.focusedKey],
  );

  const runOnTargets = useCallback(
    (
      kind: "stage" | "unstage" | "discard",
      action: (paths: ReadonlyArray<string>) => void,
      predicate: (row: ChangesRow) => boolean,
    ) => {
      const targets = actionTargetRows(rows, selection).filter(predicate);
      if (targets.length === 0) {
        // A keypress that resolves to nothing used to be indistinguishable from
        // a broken panel. Say so instead.
        props.onEmptyKeyboardTarget?.(kind);
        return;
      }
      // ONE call for a multi-file action, so a single undo toast covers it all.
      action(targetPaths(targets));
    },
    [props, rows, selection],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      // Bare keys are ignored while typing — `s` in the filter box must not stage.
      if (
        target?.closest("input, textarea, [contenteditable='true']") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      // fork: f4 focus model — a key this list owns stops here. Without it a
      // bare `s`/`x` keeps bubbling to the surfaces above the panel.
      if (CHANGES_LIST_OWNED_KEYS.has(event.key)) {
        event.stopPropagation();
      }
      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          focusRow(moveChangesFocus(rows, selection.focusedKey, "next"));
          return;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          focusRow(moveChangesFocus(rows, selection.focusedKey, "previous"));
          return;
        case "Home":
          event.preventDefault();
          focusRow(moveChangesFocus(rows, selection.focusedKey, "first"));
          return;
        case "End":
          event.preventDefault();
          focusRow(moveChangesFocus(rows, selection.focusedKey, "last"));
          return;
        case "Enter": {
          const row = rows.find((entry) => entry.key === selection.focusedKey);
          if (row?.file) {
            event.preventDefault();
            props.onOpenDiff(row.file);
          }
          return;
        }
        case "s":
          event.preventDefault();
          runOnTargets("stage", props.onStage, (row) => row.group !== "staged");
          return;
        case "u":
          event.preventDefault();
          runOnTargets("unstage", props.onUnstage, (row) => row.group === "staged");
          return;
        case "x":
        case "Backspace":
        case "Delete":
          event.preventDefault();
          runOnTargets("discard", props.onDiscard, (row) => row.group === "unstaged");
          return;
        case "Escape":
          event.preventDefault();
          setSelection(EMPTY_CHANGES_SELECTION);
          return;
        default:
          return;
      }
    },
    [focusRow, props, rows, runOnTargets, selection.focusedKey],
  );

  const handleSelect = useCallback(
    (row: ChangesRow, event: React.MouseEvent) => {
      // Every click path moves real focus into the list. Clicking a plain div
      // leaves `document.activeElement` where it was, which is how the panel's
      // keys ended up typing into the chat composer.
      takeFocus();
      if (event.shiftKey) {
        setSelection((current) => selectRowRange(rows, current, row.key));
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        setSelection((current) => toggleRowSelection(current, row.key));
        return;
      }
      setSelection(selectSingleRow(row.key));
      if (row.file) props.onOpenDiff(row.file);
    },
    [props, rows, takeFocus],
  );

  const renderRow = useCallback(
    (row: ChangesRow) => {
      if (row.kind === "header") {
        const paths = groupPathsOf(row.group);
        return (
          <GroupHeader
            row={row}
            collapsed={collapsedGroups.has(row.group)}
            busy={anyPathBusy(props.busyPaths, paths)}
            onToggle={() => props.onToggleGroup(row.group)}
            // fork: f4 F-08 — the group's OWN paths. `[]` used to travel up to
            // the panel and be re-expanded into the whole working copy.
            onStageAll={() => props.onStage(paths)}
            onUnstageAll={() => props.onUnstage(paths)}
            onDiscardAll={() => props.onDiscard(paths)}
            onCollapseAllFolders={() => toggleGroupFolders(row.group)}
            showFolderToggle={props.viewMode === "tree"}
          />
        );
      }
      if (row.kind === "folder") {
        const folderFiles = row.folderFiles ?? [];
        return (
          <FolderRow
            row={row}
            indentPx={changesRowIndent(row.depth)}
            busy={anyPathBusy(props.busyPaths, folderFiles)}
            onToggle={() => props.onToggleFolder(`${row.group}:${row.path ?? ""}`)}
            onStage={() => props.onStage(folderFiles)}
            onUnstage={() => props.onUnstage(folderFiles)}
            staged={row.group === "staged"}
          />
        );
      }
      if (row.kind === "empty") {
        return (
          <div
            style={{ height: CHANGES_ROW_HEIGHT.empty, paddingLeft: changesRowIndent(1) }}
            className="flex items-center pr-3 text-muted-foreground/70 text-xs"
          >
            {row.detail ?? "No files match in this group."}
          </div>
        );
      }
      const file = row.file;
      if (!file) return null;
      return (
        <ChangeRow
          row={row}
          domId={changesRowDomId(row.key)}
          selected={selection.selectedKeys.has(row.key)}
          focused={selection.focusedKey === row.key}
          partial={partialPaths.has(file.path)}
          busy={props.busyPaths.has(file.path)}
          showDirectory={props.viewMode === "flat"}
          indentPx={changesRowIndent(row.depth)}
          onSelect={handleSelect}
          onOpen={(target) => target.file && props.onOpenDiff(target.file)}
          onStage={(target) => target.file && props.onStage([target.file.path])}
          onUnstage={(target) => target.file && props.onUnstage([target.file.path])}
          onDiscard={(target) => target.file && props.onDiscard([target.file.path])}
          onResolve={(target, side) => target.file && props.onResolve(target.file.path, side)}
        />
      );
    },
    [
      collapsedGroups,
      groupPathsOf,
      handleSelect,
      partialPaths,
      props,
      selection,
      toggleGroupFolders,
    ],
  );

  const activeDescendantId =
    selection.focusedKey === null ? undefined : changesRowDomId(selection.focusedKey);

  /**
   * fork: f4 redesign (audit §8 / M7) — the two designed empty states. The list
   * used to render a 32px "Nothing here." row that could not tell "your tree is
   * clean" from "your filter matched nothing".
   */
  const emptyState = changesListEmptyState({
    fileCount: props.files.length,
    matchingFileCount,
  });

  if (emptyState !== null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <p className="text-xs text-muted-foreground">
          {emptyState === "clean"
            ? "There are no changes."
            : props.query.trim().length > 0
              ? `No files match “${props.query.trim()}”.`
              : "No files match the current status filter."}
        </p>
        {emptyState === "filtered" ? (
          <Button size="xs" variant="ghost" onClick={props.onClearFilters}>
            Clear filter
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-ring/60"
      role="listbox"
      aria-multiselectable
      aria-label="Changed files"
      aria-activedescendant={activeDescendantId}
      tabIndex={0}
      onFocus={handleContainerFocus}
      onKeyDown={handleKeyDown}
    >
      <LegendList<ChangesRow>
        ref={listRef}
        data={rows as ChangesRow[]}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        getFixedItemSize={(row) => changesRowHeight(row, heightOptions)}
        estimatedItemSize={CHANGES_ROW_HEIGHT.file}
        drawDistance={400}
        recycleItems
        renderItem={({ item }) => renderRow(item)}
        onScroll={(event) => setScrollTop(event.nativeEvent.contentOffset.y)}
        className="size-full overflow-x-hidden"
      />
      {pinnedRow ? (
        <div className="pointer-events-none absolute inset-x-0 top-0">
          <div className="pointer-events-auto">
            <GroupHeader
              row={pinnedRow}
              pinned
              collapsed={collapsedGroups.has(pinnedRow.group)}
              busy={anyPathBusy(props.busyPaths, groupPathsOf(pinnedRow.group))}
              onToggle={() => props.onToggleGroup(pinnedRow.group)}
              onStageAll={() => props.onStage(groupPathsOf(pinnedRow.group))}
              onUnstageAll={() => props.onUnstage(groupPathsOf(pinnedRow.group))}
              onDiscardAll={() => props.onDiscard(groupPathsOf(pinnedRow.group))}
              onCollapseAllFolders={() => toggleGroupFolders(pinnedRow.group)}
              showFolderToggle={props.viewMode === "tree"}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GroupHeader(props: {
  row: ChangesRow;
  collapsed: boolean;
  pinned?: boolean;
  showFolderToggle: boolean;
  /** One of this group's files has an action in flight. */
  busy: boolean;
  onToggle: () => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscardAll: () => void;
  onCollapseAllFolders: () => void;
}) {
  const { row } = props;
  const collapsible = groupIsCollapsible(row.group);
  return (
    <div
      style={{ height: CHANGES_ROW_HEIGHT.header, paddingLeft: CHANGES_GUTTER }}
      className={cn(
        "group flex items-center gap-1.5 border-border/50 border-b bg-background pr-3",
        row.group === "conflicted" && "bg-warning/8",
      )}
    >
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          EYEBROW_CLASS,
          collapsible && "hover:text-foreground/80",
        )}
        onClick={collapsible ? props.onToggle : undefined}
        disabled={!collapsible}
        tabIndex={-1}
      >
        {collapsible ? (
          props.collapsed ? (
            <ChevronRight className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )
        ) : (
          <span className="size-3" />
        )}
        <span className="truncate">{CHANGES_GROUP_TITLE[row.group]}</span>
        <span className="shrink-0 text-[11px] font-normal tracking-normal text-muted-foreground tabular-nums">
          {groupHeaderCountLabel(row.total ?? 0, row.visible ?? row.total ?? 0)}
        </span>
        {row.insertions !== undefined || row.deletions !== undefined ? (
          <span
            className="flex shrink-0 items-center gap-1.5 text-[11px] font-normal tracking-normal tabular-nums"
            aria-label={`${row.insertions ?? 0} additions, ${row.deletions ?? 0} deletions`}
          >
            <span className="text-success-foreground">+{row.insertions ?? 0}</span>
            <span className="text-destructive-foreground">−{row.deletions ?? 0}</span>
          </span>
        ) : null}
      </button>
      {row.group === "conflicted" ? (
        <span className={cn(EYEBROW_CLASS, "shrink-0")}>Stage to resolve</span>
      ) : (
        <span
          className={cn(
            "flex shrink-0 items-center opacity-0 transition-opacity",
            "group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          {props.showFolderToggle ? (
            <HeaderAction label="Collapse folders" onClick={props.onCollapseAllFolders}>
              <Folder />
            </HeaderAction>
          ) : null}
          {row.group === "staged" ? (
            <HeaderAction
              label={`Unstage all ${CHANGES_GROUP_TITLE[row.group]}`}
              busy={props.busy}
              onClick={props.onUnstageAll}
            >
              <Minus />
            </HeaderAction>
          ) : (
            <>
              <HeaderAction
                label={`Stage all ${CHANGES_GROUP_TITLE[row.group]}`}
                busy={props.busy}
                onClick={props.onStageAll}
              >
                <Plus />
              </HeaderAction>
              <HeaderAction
                // The label names the group: this rung discards THIS group, and
                // the whole-working-copy discard lives in the overflow menu.
                label={`Discard all ${CHANGES_GROUP_TITLE[row.group]}`}
                busy={props.busy}
                onClick={props.onDiscardAll}
              >
                <Undo2 />
              </HeaderAction>
            </>
          )}
        </span>
      )}
    </div>
  );
}

function HeaderAction(props: {
  label: string;
  busy?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            tabIndex={-1}
            // fork: f4 F-04/F-06 — disabled while its own action is in flight.
            // The press used to be accepted, dropped by the busy guard and
            // never reported.
            disabled={props.busy === true}
            aria-busy={props.busy === true}
            onClick={props.onClick}
          >
            {props.busy === true ? <Loader2 className="animate-spin" /> : props.children}
          </Button>
        }
      />
      {/* fork: f4 redesign (M18) — one tooltip system in the list, not a mix of
          `title=` on headers and `Tooltip` on rows. */}
      <TooltipPopup>{props.busy === true ? `${props.label} — working…` : props.label}</TooltipPopup>
    </Tooltip>
  );
}

function FolderRow(props: {
  row: ChangesRow;
  indentPx: number;
  staged: boolean;
  busy: boolean;
  onToggle: () => void;
  onStage: () => void;
  onUnstage: () => void;
}) {
  const { row } = props;
  return (
    <div
      style={{ height: CHANGES_ROW_HEIGHT.folder, paddingLeft: props.indentPx }}
      className="group relative flex items-center gap-1.5 pr-3 text-sm hover:bg-accent/50"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={props.onToggle}
        tabIndex={-1}
      >
        {row.collapsed ? (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" />
        ) : (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/50" />
        )}
        <Folder className="size-3.5 shrink-0 text-muted-foreground/60" />
        <span className="truncate font-medium text-muted-foreground/80">{row.name}</span>
        <span className="shrink-0 text-muted-foreground/50 text-xs tabular-nums transition-opacity group-hover:opacity-0 pointer-coarse:opacity-0">
          {row.folderFiles?.length ?? 0}
        </span>
      </button>
      <span
        className={cn(
          "absolute right-3 top-1/2 flex -translate-y-1/2 items-center justify-end rounded-sm bg-background opacity-0 transition-opacity group-hover:bg-accent",
          "group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100",
          props.busy && "opacity-100",
        )}
      >
        {props.staged ? (
          <HeaderAction label="Unstage folder" busy={props.busy} onClick={props.onUnstage}>
            <Minus />
          </HeaderAction>
        ) : (
          <HeaderAction label="Stage folder" busy={props.busy} onClick={props.onStage}>
            <Plus />
          </HeaderAction>
        )}
      </span>
    </div>
  );
}
