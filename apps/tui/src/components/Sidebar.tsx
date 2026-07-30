import * as React from "react";

import { padClip } from "../format.ts";
import type { Store } from "../store.ts";
import { relativeTime, resolveThreadStatus, usePalette } from "../theme.ts";
import { type Row, type Selection, selectionEquals } from "./Sidebar.logic.ts";
import { StatusDot } from "./ThreadStatusIndicators.tsx";

const SidebarThreadRow = React.memo(function SidebarThreadRow({
  row,
  selected,
  innerWidth,
  store,
}: {
  readonly row: Extract<Row, { kind: "thread" }>;
  readonly selected: boolean;
  readonly innerWidth: number;
  readonly store: Store;
}): React.ReactNode {
  const palette = usePalette();
  const status = resolveThreadStatus(row.thread);
  const time = relativeTime(row.timestamp);
  const active = row.section === "active";
  const titleBudget = Math.max(1, innerWidth - (active ? 5 : 4) - (active ? 0 : time.length + 1));
  return (
    <box
      flexDirection="column"
      height={active ? 2 : 1}
      onMouseDown={() => store.select({ kind: "thread", id: row.id })}
    >
      <text>
        <span fg={palette.accent}>{selected ? "▌ " : "  "}</span>
        <StatusDot status={status} />
        <span fg={palette.text}>{` ${padClip(row.thread.title, titleBudget)}`}</span>
        {!active ? <span fg={palette.dim}>{` ${time}`}</span> : null}
        {active ? (
          <span fg={palette.dim}>
            {`\n    ${padClip(row.projectTitle, Math.max(1, innerWidth - time.length - 7))} · ${time}`}
          </span>
        ) : null}
      </text>
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
  moreAbove,
  moreBelow,
  width,
  height,
  store,
  filter,
  projectScopeLabel,
  searchFocused,
  onSearchInput,
  onFocusSearch,
  onChooseProjectScope,
  onAddProject,
}: {
  readonly rows: ReadonlyArray<Row>;
  readonly selection: Selection | null;
  readonly moreAbove: boolean;
  readonly moreBelow: boolean;
  readonly width: number;
  readonly height: number;
  readonly store: Store;
  readonly filter: string;
  readonly projectScopeLabel: string;
  readonly searchFocused: boolean;
  readonly onSearchInput: (value: string) => void;
  readonly onFocusSearch: () => void;
  readonly onChooseProjectScope: () => void;
  readonly onAddProject: () => void;
}): React.ReactNode {
  const palette = usePalette();
  const innerWidth = Math.max(8, width - 4);
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
      <text>
        <span fg={palette.accent}>Threads</span>
        {moreAbove ? <span fg={palette.dim}>{"  ↑ more"}</span> : null}
      </text>
      {rows.length === 0 ? (
        <text fg={palette.dim}>No threads here. Press ^N.</text>
      ) : (
        rows.map((row) => {
          const selected = selectionEquals(selection, row);
          if (row.kind === "section") {
            return (
              <SidebarSectionRow key={`s:${row.id}`} row={row} selected={selected} store={store} />
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
            />
          );
        })
      )}
      {moreBelow ? <text fg={palette.dim}>{"  ↓ more"}</text> : null}
    </box>
  );
});
