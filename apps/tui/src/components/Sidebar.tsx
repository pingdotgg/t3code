import { MouseButton, type MouseEvent, type ScrollBoxRenderable } from "@opentui/core";
import * as React from "react";

import { padClip } from "../format.ts";
import type { Store } from "../store.ts";
import { ansi, relativeTime, resolveThreadStatus, usePalette } from "../theme.ts";
import { type Row, rowHeight, type Selection, selectionEquals } from "./Sidebar.logic.ts";
import { StatusDot } from "./ThreadStatusIndicators.tsx";

export const THREAD_CONTEXT_LONG_PRESS_MS = 500;

const SidebarThreadRow = React.memo(function SidebarThreadRow({
  row,
  selected,
  innerWidth,
  store,
  onContextMenu,
}: {
  readonly row: Extract<Row, { kind: "thread" }>;
  readonly selected: boolean;
  readonly innerWidth: number;
  readonly store: Store;
  readonly onContextMenu: (
    row: Extract<Row, { kind: "thread" }>,
    position: { readonly x: number; readonly y: number },
  ) => void;
}): React.ReactNode {
  const palette = usePalette();
  const status = resolveThreadStatus(row.thread);
  const time = relativeTime(row.timestamp);
  const active = row.section === "active";
  const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressOriginRef = React.useRef<{ readonly x: number; readonly y: number } | null>(null);
  const longPressOpenedRef = React.useRef(false);
  const cancelLongPress = React.useCallback(() => {
    if (longPressTimerRef.current !== null) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    pressOriginRef.current = null;
  }, []);
  React.useEffect(() => cancelLongPress, [cancelLongPress]);

  const handleMouseDown = (event: MouseEvent) => {
    event.stopPropagation();
    if (event.button === MouseButton.RIGHT) {
      event.preventDefault();
      cancelLongPress();
      onContextMenu(row, { x: event.x, y: event.y });
      return;
    }
    if (event.button !== MouseButton.LEFT) return;
    event.preventDefault();
    cancelLongPress();
    longPressOpenedRef.current = false;
    const position = { x: event.x, y: event.y };
    pressOriginRef.current = position;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressOpenedRef.current = true;
      onContextMenu(row, position);
    }, THREAD_CONTEXT_LONG_PRESS_MS);
  };
  const handleMouseUp = (event: MouseEvent) => {
    event.stopPropagation();
    if (event.button !== MouseButton.LEFT) return;
    const openedContextMenu = longPressOpenedRef.current;
    longPressOpenedRef.current = false;
    cancelLongPress();
    if (!openedContextMenu) store.select({ kind: "thread", id: row.id });
  };
  const handleMouseDrag = (event: MouseEvent) => {
    const origin = pressOriginRef.current;
    if (!origin || Math.abs(event.x - origin.x) + Math.abs(event.y - origin.y) <= 1) return;
    cancelLongPress();
  };

  if (!active) {
    const titleBudget = Math.max(1, innerWidth - 4 - time.length - 1);
    return (
      <box
        height={1}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseDrag={handleMouseDrag}
        onMouseOut={cancelLongPress}
      >
        <text selectable={false}>
          <span fg={palette.accent}>{selected ? "▌ " : "  "}</span>
          <StatusDot status={status} />
          <span fg={palette.text}>{` ${padClip(row.thread.title, titleBudget)}`}</span>
          <span fg={palette.dim}>{` ${time}`}</span>
        </text>
      </box>
    );
  }

  const contentWidth = Math.max(6, innerWidth - 2);
  const topTrailing = status.key === "idle" ? time : status.label;
  const projectBudget = Math.max(1, contentWidth - 5 - Bun.stringWidth(topTrailing));
  return (
    <box
      flexDirection="column"
      height={4}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseDrag={handleMouseDrag}
      onMouseOut={cancelLongPress}
    >
      <box
        flexDirection="column"
        height={3}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={selected ? palette.selectedBg : palette.bg}
      >
        <text selectable={false}>
          <span fg={palette.accent}>{selected ? "▌ " : "  "}</span>
          <StatusDot status={status} />
          <span fg={palette.dim}>{` ${padClip(row.projectTitle, projectBudget)} `}</span>
          <span fg={status.key === "idle" ? palette.dim : ansi(status.color)}>{topTrailing}</span>
        </text>
        <text selectable={false} fg={palette.text}>
          <span>{"  "}</span>
          <strong>{padClip(row.thread.title, Math.max(1, contentWidth - 2))}</strong>
        </text>
        <text selectable={false} fg={palette.dim}>
          {row.thread.branch
            ? `  ${padClip(row.thread.branch, Math.max(1, contentWidth - 2))}`
            : ""}
        </text>
      </box>
      <box height={1} />
    </box>
  );
});

const SidebarSectionRow = React.memo(function SidebarSectionRow({
  row,
  selected,
  store,
}: {
  readonly row: Extract<Row, { kind: "section" }>;
  readonly selected: boolean;
  readonly store: Store;
}): React.ReactNode {
  const palette = usePalette();
  const color = row.section === "snoozed" || selected ? palette.accent : palette.dim;
  return (
    <box onMouseDown={() => store.toggleSection(row.section)}>
      <text fg={color}>
        {`${selected ? "▌" : " "} ${row.expanded ? "▾" : "▸"} ${row.title}${row.expanded ? "" : ` (${row.count})`} ─`}
      </text>
    </box>
  );
});

const SidebarMoreRow = React.memo(function SidebarMoreRow({
  row,
  selected,
  store,
}: {
  readonly row: Extract<Row, { kind: "more" }>;
  readonly selected: boolean;
  readonly store: Store;
}): React.ReactNode {
  const palette = usePalette();
  return (
    <box onMouseDown={() => store.loadMore(row.id)}>
      <text fg={selected ? palette.accent : palette.dim}>
        {`  ${selected ? "▶" : "+"} Show ${Math.min(row.hiddenCount, 25)} more`}
      </text>
    </box>
  );
});

export const Sidebar = React.memo(function Sidebar({
  rows,
  selection,
  width,
  height,
  listHeight,
  store,
  filter,
  projectScopeLabel,
  searchFocused,
  onSearchInput,
  onFocusSearch,
  onChooseProjectScope,
  onAddProject,
  onThreadContextMenu,
}: {
  readonly rows: ReadonlyArray<Row>;
  readonly selection: Selection | null;
  readonly width: number;
  readonly height: number;
  readonly listHeight: number;
  readonly store: Store;
  readonly filter: string;
  readonly projectScopeLabel: string;
  readonly searchFocused: boolean;
  readonly onSearchInput: (value: string) => void;
  readonly onFocusSearch: () => void;
  readonly onChooseProjectScope: () => void;
  readonly onAddProject: () => void;
  readonly onThreadContextMenu: (
    row: Extract<Row, { kind: "thread" }>,
    position: { readonly x: number; readonly y: number },
  ) => void;
}): React.ReactNode {
  const palette = usePalette();
  const innerWidth = Math.max(8, width - 4);
  const scrollRef = React.useRef<ScrollBoxRenderable | null>(null);

  // Keyboard selection scrolls the list only when it reaches a viewport edge;
  // in between (and for the mouse wheel) the scrollbox owns the position.
  React.useEffect(() => {
    const apply = () => {
      const scrollbox = scrollRef.current;
      if (!scrollbox) return;
      const index = rows.findIndex((row) => selectionEquals(selection, row));
      if (index < 0) return;
      let top = 0;
      for (let i = 0; i < index; i += 1) top += rowHeight(rows[i]!);
      const bottom = top + rowHeight(rows[index]!);
      const viewport = Math.max(1, listHeight);
      if (top < scrollbox.scrollTop) scrollbox.scrollTop = top;
      else if (bottom > scrollbox.scrollTop + viewport) scrollbox.scrollTop = bottom - viewport;
    };
    apply();
    // The scrollbox clamps scrollTop to its laid-out content height, which is
    // still zero when this effect fires on mount — re-apply on the next tick
    // so a selection restored deep in the list starts on screen.
    const timer = setTimeout(apply, 0);
    return () => clearTimeout(timer);
  }, [rows, selection, listHeight]);

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      border
      borderStyle="rounded"
      borderColor={palette.faint}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      <text>
        <strong>T3</strong>
        <span fg={palette.dim}> Code</span>
      </text>
      <box
        flexDirection="row"
        marginTop={1}
        border
        borderStyle="rounded"
        borderColor={searchFocused ? palette.accent : palette.faint}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        onMouseDown={onFocusSearch}
      >
        <text>
          <span fg={searchFocused ? palette.accent : palette.dim}>{"⌕ "}</span>
        </text>
        {searchFocused ? (
          <input
            value={filter}
            onInput={onSearchInput}
            focused
            flexGrow={1}
            placeholder="Search threads…"
            textColor={palette.text}
            cursorColor={palette.accent}
            placeholderColor={palette.dim}
          />
        ) : (
          <text>
            {filter.length > 0 ? (
              <span fg={palette.text}>{filter}</span>
            ) : (
              <span fg={palette.dim}>Search threads…</span>
            )}
          </text>
        )}
      </box>
      <box flexDirection="row" marginTop={1} marginBottom={1} flexShrink={0}>
        <box flexGrow={1} overflow="hidden" onMouseDown={onChooseProjectScope}>
          <text>
            <span fg={palette.dim}>Project </span>
            <span fg={projectScopeLabel === "All projects" ? palette.text : palette.accent}>
              {padClip(projectScopeLabel, Math.max(1, innerWidth - 12))}
            </span>
            <span fg={palette.dim}> ▾</span>
          </text>
        </box>
        <box marginLeft={1} onMouseDown={onAddProject}>
          <text fg={palette.accent}>+</text>
        </box>
      </box>
      <text fg={palette.accent}>Threads</text>
      {rows.length === 0 ? (
        <text fg={palette.dim}>No threads here. Press ^N.</text>
      ) : (
        <scrollbox
          ref={scrollRef}
          height={listHeight}
          flexShrink={0}
          scrollX={false}
          style={{
            rootOptions: { backgroundColor: "transparent" },
            contentOptions: { width: "100%", maxWidth: "100%", overflow: "hidden" },
          }}
        >
          {rows.map((row) => {
            const selected = selectionEquals(selection, row);
            if (row.kind === "section") {
              return (
                <SidebarSectionRow
                  key={`s:${row.id}`}
                  row={row}
                  selected={selected}
                  store={store}
                />
              );
            }
            if (row.kind === "more") {
              return (
                <SidebarMoreRow key={`m:${row.id}`} row={row} selected={selected} store={store} />
              );
            }
            return (
              <SidebarThreadRow
                key={`t:${row.id}`}
                row={row}
                selected={selected}
                innerWidth={innerWidth}
                store={store}
                onContextMenu={onThreadContextMenu}
              />
            );
          })}
        </scrollbox>
      )}
    </box>
  );
});
