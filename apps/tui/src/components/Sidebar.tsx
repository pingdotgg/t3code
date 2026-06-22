import * as React from "react";

import { padClip } from "../format.ts";
import type { Store } from "../store.ts";
import { relativeTime, resolveThreadStatus, usePalette } from "../theme.ts";
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { type Row, type Selection, selectionEquals } from "./Sidebar.logic.ts";
import { StatusDot } from "./ThreadStatusIndicators.tsx";

// The project/thread list pane (mirrors apps/web/src/components/Sidebar.tsx). Row
// components are memoized and take the stable `store` (not per-render onClick
// closures) so conversation streaming — which only updates the detail pane —
// never re-renders the list. Mirrors SidebarProjectItem / SidebarThreadRow /
// SidebarProjectThreadList from the web.

const SidebarProjectItem = React.memo(function SidebarProjectItem({
  row,
  selected,
  innerWidth,
  store,
}: {
  readonly row: Extract<Row, { kind: "project" }>;
  readonly selected: boolean;
  readonly innerWidth: number;
  readonly store: Store;
}): React.ReactNode {
  const palette = usePalette();
  const caret = row.expanded ? "▾" : "▸";
  const count = ` (${row.count})`;
  const dotWidth = row.status ? 2 : 0;
  const titleBudget = innerWidth - 3 - count.length - dotWidth;
  return (
    <box onMouseDown={() => store.toggleProject(row.id)} {...(selected ? { backgroundColor: palette.selectedBg } : {})}>
      <text>
        <span fg={selected ? palette.accent : palette.text}>
          {`${selected ? "▌" : " "}${caret} ${padClip(row.title, titleBudget)}${count}${row.status ? " " : ""}`}
        </span>
        {row.status ? <StatusDot status={row.status} /> : null}
      </text>
    </box>
  );
});

const SidebarThreadRow = React.memo(function SidebarThreadRow({
  thread,
  selected,
  innerWidth,
  store,
}: {
  readonly thread: OrchestrationThreadShell;
  readonly selected: boolean;
  readonly innerWidth: number;
  readonly store: Store;
}): React.ReactNode {
  const palette = usePalette();
  const status = resolveThreadStatus(thread);
  const time = ` ${relativeTime(thread.updatedAt)}`;
  const titleBudget = innerWidth - 4 - time.length;
  return (
    <box onMouseDown={() => store.select({ kind: "thread", id: thread.id })} {...(selected ? { backgroundColor: palette.selectedBg } : {})}>
      <text>
        <span fg={palette.accent}>{selected ? "▌ " : "  "}</span>
        <StatusDot status={status} />
        <span fg={palette.text}>{` ${padClip(thread.title, titleBudget)}`}</span>
        <span fg={palette.dim}>{time}</span>
      </text>
    </box>
  );
});

const SidebarMoreRow = React.memo(function SidebarMoreRow({
  projectId,
  hiddenCount,
  selected,
  store,
}: {
  readonly projectId: string;
  readonly hiddenCount: number;
  readonly selected: boolean;
  readonly store: Store;
}): React.ReactNode {
  const palette = usePalette();
  return (
    <box onMouseDown={() => store.loadMore(projectId)} {...(selected ? { backgroundColor: palette.selectedBg } : {})}>
      <text fg={selected ? palette.accent : palette.dim}>
        {`   ${selected ? "▶" : " "}… show ${hiddenCount} more`}
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
}: {
  readonly rows: ReadonlyArray<Row>;
  readonly selection: Selection | null;
  readonly moreAbove: boolean;
  readonly moreBelow: boolean;
  readonly width: number;
  readonly height: number;
  readonly store: Store;
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
      borderColor={palette.dim}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <strong>T3</strong>
        <span fg={palette.dim}> Code</span>
      </text>
      <text>
        <span fg={palette.accent}>Projects</span>
        {moreAbove ? <span fg={palette.dim}>{"  ↑ more"}</span> : null}
      </text>
      {rows.length === 0 ? (
        <text fg={palette.dim}>No projects yet. Press ^N.</text>
      ) : (
        rows.map((row) => {
          const selected = selectionEquals(selection, row);
          if (row.kind === "project") {
            return (
              <SidebarProjectItem
                key={`p:${row.id}`}
                row={row}
                selected={selected}
                innerWidth={innerWidth}
                store={store}
              />
            );
          }
          if (row.kind === "more") {
            return (
              <SidebarMoreRow
                key={`m:${row.id}`}
                projectId={row.id}
                hiddenCount={row.hiddenCount}
                selected={selected}
                store={store}
              />
            );
          }
          return (
            <SidebarThreadRow
              key={`t:${row.id}`}
              thread={row.thread}
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
