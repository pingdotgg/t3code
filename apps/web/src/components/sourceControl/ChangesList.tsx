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
  CHANGES_ROW_HEIGHT,
  buildChangesRows,
  changesAllFolderKeys,
  changesGroupPaths,
  changesRowHeight,
  partiallyStagedPaths,
  type ChangesGroup,
  type ChangesGroupScope,
  type ChangesRow,
  type ChangesStatusFilter,
  type ChangesViewMode,
} from "~/lib/sourceControl/changesRows";
import type { WorkingCopyFile } from "@t3tools/contracts";
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

/** Tree indent, matching 2code's 13 px per level from a 16 px base inset. */
const INDENT_PER_LEVEL = 13;

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
            indentPx={row.depth * INDENT_PER_LEVEL}
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
            style={{ height: CHANGES_ROW_HEIGHT.empty }}
            className="flex items-center px-4 text-muted-foreground text-xs"
          >
            {row.detail ?? "Nothing here."}
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
          indentPx={row.depth * INDENT_PER_LEVEL}
          onSelect={handleSelect}
          onOpen={(target) => target.file && props.onOpenDiff(target.file)}
          onStage={(target) => target.file && props.onStage([target.file.path])}
          onUnstage={(target) => target.file && props.onUnstage([target.file.path])}
          onDiscard={(target) => target.file && props.onDiscard([target.file.path])}
          onResolve={(target, side) => target.file && props.onResolve(target.file.path, side)}
        />
      );
    },
    [collapsedGroups, groupPathsOf, groupScope, handleSelect, partialPaths, props, selection],
  );

  const activeDescendantId =
    selection.focusedKey === null ? undefined : changesRowDomId(selection.focusedKey);

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 outline-none"
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
      {pinnedGroup ? (
        <div className="pointer-events-none absolute inset-x-0 top-0">
          <div className="pointer-events-auto">
            <GroupHeader
              row={{
                key: `${pinnedGroup}:pinned`,
                kind: "header",
                group: pinnedGroup,
                depth: 0,
                total: countInGroup(rows, pinnedGroup),
                visible: countInGroup(rows, pinnedGroup),
              }}
              pinned
              collapsed={collapsedGroups.has(pinnedGroup)}
              busy={anyPathBusy(props.busyPaths, groupPathsOf(pinnedGroup))}
              onToggle={() => props.onToggleGroup(pinnedGroup)}
              onStageAll={() => props.onStage(groupPathsOf(pinnedGroup))}
              onUnstageAll={() => props.onUnstage(groupPathsOf(pinnedGroup))}
              onDiscardAll={() => props.onDiscard(groupPathsOf(pinnedGroup))}
              onCollapseAllFolders={() => toggleGroupFolders(pinnedGroup)}
              showFolderToggle={props.viewMode === "tree"}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function countInGroup(rows: ReadonlyArray<ChangesRow>, group: ChangesGroup): number {
  let count = 0;
  for (const row of rows) {
    if (row.kind === "file" && row.group === group) count += 1;
  }
  return count;
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
      style={{ height: CHANGES_ROW_HEIGHT.header }}
      className={cn(
        "group flex items-center gap-1.5 border-border/50 border-b bg-background px-2 text-xs",
        props.pinned && "shadow-sm",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left font-medium text-muted-foreground uppercase tracking-wide"
        onClick={collapsible ? props.onToggle : undefined}
        disabled={!collapsible}
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
        <span className="text-muted-foreground/70">
          {groupHeaderCountLabel(row.total ?? 0, row.visible ?? row.total ?? 0)}
        </span>
      </button>
      {row.group === "conflicted" ? (
        <span className="text-muted-foreground/70">stage to resolve</span>
      ) : (
        <span className="hidden items-center gap-0.5 group-hover:flex">
          {props.showFolderToggle ? (
            <HeaderAction label="Collapse folders" onClick={props.onCollapseAllFolders}>
              <Folder className="size-3.5" />
            </HeaderAction>
          ) : null}
          {row.group === "staged" ? (
            <HeaderAction
              label={`Unstage all ${CHANGES_GROUP_TITLE[row.group]}`}
              busy={props.busy}
              onClick={props.onUnstageAll}
            >
              <Minus className="size-3.5" />
            </HeaderAction>
          ) : (
            <>
              <HeaderAction
                label={`Stage all ${CHANGES_GROUP_TITLE[row.group]}`}
                busy={props.busy}
                onClick={props.onStageAll}
              >
                <Plus className="size-3.5" />
              </HeaderAction>
              <HeaderAction
                // The label names the group: this rung discards THIS group, and
                // the whole-working-copy discard lives in the overflow menu.
                label={`Discard all ${CHANGES_GROUP_TITLE[row.group]}`}
                busy={props.busy}
                onClick={props.onDiscardAll}
              >
                <Undo2 className="size-3.5" />
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
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      // fork: f4 F-04/F-06 — disabled while its own action is in flight. The
      // press used to be accepted, dropped by the busy guard and never
      // reported.
      disabled={props.busy === true}
      aria-busy={props.busy === true}
      className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      onClick={props.onClick}
    >
      {props.busy === true ? <Loader2 className="size-3.5 animate-spin" /> : props.children}
    </button>
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
      style={{ height: CHANGES_ROW_HEIGHT.folder, paddingLeft: 8 + props.indentPx }}
      className="group flex items-center gap-1 pr-1.5 text-sm hover:bg-accent/50"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
        onClick={props.onToggle}
      >
        {row.collapsed ? (
          <ChevronRight className="size-3 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3 text-muted-foreground" />
        )}
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{row.name}</span>
        <span className="text-muted-foreground text-xs">{row.folderFiles?.length ?? 0}</span>
      </button>
      <span className="hidden items-center gap-0.5 group-hover:flex">
        {props.staged ? (
          <HeaderAction label="Unstage folder" busy={props.busy} onClick={props.onUnstage}>
            <Minus className="size-3.5" />
          </HeaderAction>
        ) : (
          <HeaderAction label="Stage folder" busy={props.busy} onClick={props.onStage}>
            <Plus className="size-3.5" />
          </HeaderAction>
        )}
      </span>
    </div>
  );
}
