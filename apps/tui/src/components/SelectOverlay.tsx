import type { SelectOption } from "@opentui/core";
import * as React from "react";

import { clip } from "../format.ts";
import { ansi, usePalette } from "../theme.ts";

// A picker for the composer controls (model / runtime access / reasoning), shaped
// like the web's name+description dropdowns. Rows are clickable (onMouseDown) AND
// keyboard-navigable (ChatView drives ↑/↓ + Enter via the "select" keymode), since
// OpenTUI's native <select> has no reliable click-to-select.

export type SelectStatus = "loading" | "ready" | "empty" | "error";

const WINDOW = 6;

export const SelectOverlay = React.memo(function SelectOverlay({
  title,
  status,
  options,
  selectedIndex,
  width,
  onSelect,
}: {
  readonly title: string;
  readonly status: SelectStatus;
  readonly options: ReadonlyArray<SelectOption>;
  readonly selectedIndex: number;
  readonly width: number;
  /** Apply the option at this index (click or Enter). */
  readonly onSelect: (index: number, option: SelectOption | null) => void;
}): React.ReactNode {
  const palette = usePalette();
  const labelRoom = Math.max(8, width - 6);

  let body: React.ReactNode;
  if (status === "loading") {
    body = <text fg={palette.dim}>loading…</text>;
  } else if (status === "error") {
    body = <text fg={ansi("red")}>failed to load</text>;
  } else if (status === "empty" || options.length === 0) {
    body = <text fg={palette.dim}>nothing to choose</text>;
  } else {
    const start = Math.min(
      Math.max(0, selectedIndex - Math.floor(WINDOW / 2)),
      Math.max(0, options.length - WINDOW),
    );
    const visible = options.slice(start, start + WINDOW);
    body = (
      <>
        {visible.map((option, offset) => {
          const index = start + offset;
          const active = index === selectedIndex;
          const description =
            option.description && option.description !== option.name ? option.description : null;
          return (
            <box
              key={option.name + index}
              flexDirection="column"
              onMouseDown={() => onSelect(index, option)}
              {...(active ? { backgroundColor: palette.selectedBg } : {})}
            >
              <text>
                <span fg={active ? palette.accent : palette.dim}>{active ? "▸ " : "  "}</span>
                <span fg={active ? palette.text : palette.dim}>{clip(option.name, labelRoom)}</span>
              </text>
              {description ? (
                <text fg={palette.dim}>{`    ${clip(description, labelRoom)}`}</text>
              ) : null}
            </box>
          );
        })}
      </>
    );
  }

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={palette.accent}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text>
        <span fg={palette.accent}>{`${title} ▸ `}</span>
        <span fg={palette.dim}>↑/↓ or click · Enter apply · Esc cancel</span>
      </text>
      {body}
    </box>
  );
});
