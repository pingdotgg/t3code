import * as React from "react";

import type { Command } from "../commands.ts";
import { clip } from "../format.ts";
import { usePalette } from "../theme.ts";

// The command palette (mirrors the web CommandPalette): a focused filter input
// over a windowed, fuzzy-ranked command list. ChatView owns the query/selection
// state + the already-filtered list; this is purely presentational. Rows are
// clickable and keyboard-navigable (↑/↓ + Enter via the "command" keymode).

export const CommandPalette = React.memo(function CommandPalette({
  commands,
  selectedIndex,
  query,
  width,
  maxRows,
  onInput,
  onRun,
}: {
  readonly commands: ReadonlyArray<Command>;
  readonly selectedIndex: number;
  readonly query: string;
  readonly width: number;
  /** Content rows available for the list (header + input + hint excluded). */
  readonly maxRows: number;
  readonly onInput: (value: string) => void;
  readonly onRun: (index: number) => void;
}): React.ReactNode {
  const palette = usePalette();
  const labelRoom = Math.max(8, width - 12);
  const window = Math.max(1, maxRows);
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(window / 2)),
    Math.max(0, commands.length - window),
  );
  const visible = commands.slice(start, start + window);

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
      <box flexDirection="row">
        <text>
          <span fg={palette.accent}>{"⌘ "}</span>
        </text>
        <input
          value={query}
          onInput={onInput}
          focused
          placeholder="Type a command…"
          flexGrow={1}
          textColor={palette.text}
          cursorColor={palette.accent}
          placeholderColor={palette.dim}
        />
      </box>
      {commands.length === 0 ? (
        <text fg={palette.dim}>no matching command</text>
      ) : (
        visible.map((command, offset) => {
          const index = start + offset;
          const active = index === selectedIndex;
          return (
            <box
              key={command.id}
              onMouseDown={() => onRun(index)}
              {...(active ? { backgroundColor: palette.selectedBg } : {})}
            >
              <text>
                <span fg={active ? palette.accent : palette.dim}>{active ? "▸ " : "  "}</span>
                <span fg={active ? palette.text : palette.dim}>{clip(command.title, labelRoom)}</span>
                {command.hint ? <span fg={palette.dim}>{`  ${command.hint}`}</span> : null}
              </text>
            </box>
          );
        })
      )}
      <text fg={palette.dim}>{"↑/↓ select · Enter run · Esc close"}</text>
    </box>
  );
});
