import type { ContextMenuItem } from "@t3tools/contracts";
import { RGBA, type MouseEvent } from "@opentui/core";
import * as React from "react";

import { clip } from "../format.ts";
import { usePalette } from "../theme.ts";

const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0);

export interface ContextMenuPosition {
  readonly x: number;
  readonly y: number;
}

export interface ContextMenuLayout extends ContextMenuPosition {
  readonly width: number;
  readonly height: number;
}

export function resolveContextMenuLayout(
  items: ReadonlyArray<ContextMenuItem>,
  position: ContextMenuPosition,
  viewport: { readonly width: number; readonly height: number },
): ContextMenuLayout {
  const labelWidth = Math.max(1, ...items.map((item) => item.label.length));
  const width = Math.min(viewport.width, Math.max(12, labelWidth + 6));
  const separatorCount = items.filter((item) => item.separatorBefore).length;
  const height = Math.min(viewport.height, items.length + separatorCount + 2);
  return {
    x: Math.max(0, Math.min(position.x, viewport.width - width)),
    y: Math.max(0, Math.min(position.y, viewport.height - height)),
    width,
    height,
  };
}

function isSelectable(item: ContextMenuItem | undefined): item is ContextMenuItem {
  return item !== undefined && item.disabled !== true && item.header !== true;
}

export function firstContextMenuIndex(items: ReadonlyArray<ContextMenuItem>): number {
  const index = items.findIndex(isSelectable);
  return index < 0 ? 0 : index;
}

export function moveContextMenuIndex(
  items: ReadonlyArray<ContextMenuItem>,
  selectedIndex: number,
  direction: -1 | 1,
): number {
  if (items.length === 0) return 0;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (selectedIndex + direction * offset + items.length) % items.length;
    if (isSelectable(items[index])) return index;
  }
  return selectedIndex;
}

export function contextMenuIndexAtRow(
  items: ReadonlyArray<ContextMenuItem>,
  row: number,
): number | null {
  let cursor = 1;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.separatorBefore) cursor += 1;
    if (row === cursor) return index;
    cursor += 1;
  }
  return null;
}

export const ContextMenu = React.memo(function ContextMenu({
  items,
  selectedIndex,
  position,
  viewport,
  onSelectIndex,
  onRun,
  onClose,
}: {
  readonly items: ReadonlyArray<ContextMenuItem>;
  readonly selectedIndex: number;
  readonly position: ContextMenuPosition;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly onSelectIndex: (index: number) => void;
  readonly onRun: (item: ContextMenuItem) => void;
  readonly onClose: () => void;
}): React.ReactNode {
  const palette = usePalette();
  const layout = resolveContextMenuLayout(items, position, viewport);
  const labelWidth = Math.max(1, layout.width - 4);
  const stopMouse = (event: MouseEvent) => event.stopPropagation();

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={viewport.width}
      height={viewport.height}
      zIndex={100}
    >
      <box
        position="absolute"
        top={0}
        left={0}
        width={viewport.width}
        height={viewport.height}
        backgroundColor={TRANSPARENT}
        onMouseDown={onClose}
      />
      <box
        position="absolute"
        top={layout.y}
        left={layout.x}
        width={layout.width}
        height={layout.height}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={palette.faint}
        paddingLeft={1}
        paddingRight={1}
        overflow="hidden"
        onMouseMove={(event) => {
          const index = contextMenuIndexAtRow(items, event.y - layout.y);
          if (index !== null && isSelectable(items[index])) onSelectIndex(index);
        }}
        onMouseDown={(event) => {
          stopMouse(event);
          const index = contextMenuIndexAtRow(items, event.y - layout.y);
          const item = index === null ? undefined : items[index];
          if (isSelectable(item)) onRun(item);
        }}
      >
        {items.map((item, index) => {
          const active = index === selectedIndex && isSelectable(item);
          const color = item.destructive
            ? palette.error
            : item.disabled || item.header
              ? palette.faint
              : active
                ? palette.text
                : palette.dim;
          return (
            <React.Fragment key={item.id}>
              {item.separatorBefore ? (
                <text fg={palette.faint}>{"─".repeat(labelWidth)}</text>
              ) : null}
              <box backgroundColor={active ? palette.selectedBg : palette.bg}>
                <text>
                  <span fg={active ? palette.accent : palette.faint}>{active ? "▸ " : "  "}</span>
                  <span fg={color}>{clip(item.label, labelWidth - 2)}</span>
                </text>
              </box>
            </React.Fragment>
          );
        })}
      </box>
    </box>
  );
});
