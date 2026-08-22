import * as React from "react";

import { clip } from "../format.ts";
import { usePalette } from "../theme.ts";

export interface AddProjectRow {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export type AddProjectStatus = "ready" | "loading" | "empty" | "error";

export const AddProjectOverlay = React.memo(function AddProjectOverlay({
  title,
  query,
  placeholder,
  inputFocused,
  rows,
  selectedIndex,
  status,
  width,
  maxRows,
  context,
  actionLabel,
  emptyMessage,
  onInput,
  onFocusInput,
  onAction,
  onActivate,
}: {
  readonly title: string;
  readonly query: string;
  readonly placeholder: string;
  readonly inputFocused: boolean;
  readonly rows: ReadonlyArray<AddProjectRow>;
  readonly selectedIndex: number;
  readonly status: AddProjectStatus;
  readonly width: number;
  readonly maxRows: number;
  readonly context?: { readonly title: string; readonly description: string } | null;
  readonly actionLabel: string;
  readonly emptyMessage: string;
  readonly onInput: (value: string) => void;
  readonly onFocusInput: () => void;
  readonly onAction: () => void;
  readonly onActivate: (index: number) => void;
}): React.ReactNode {
  const palette = usePalette();
  const labelRoom = Math.max(8, width - 8);
  const contextRows = context ? 3 : 0;
  const windowSize = Math.max(1, Math.floor((maxRows - contextRows - 3) / 2));
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(windowSize / 2)),
    Math.max(0, rows.length - windowSize),
  );
  const visibleRows = rows.slice(start, start + windowSize);

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
          <span fg={palette.accent}>{"＋ "}</span>
        </text>
        {inputFocused ? (
          <input
            value={query}
            onInput={onInput}
            focused
            placeholder={placeholder}
            flexGrow={1}
            textColor={palette.text}
            cursorColor={palette.accent}
            placeholderColor={palette.dim}
          />
        ) : (
          <box flexGrow={1} onMouseDown={onFocusInput}>
            <text>
              <span fg={query.length > 0 ? palette.text : palette.dim}>
                {clip(query.length > 0 ? query : placeholder, labelRoom)}
              </span>
            </text>
          </box>
        )}
        <box onMouseDown={onAction}>
          <text>
            <span fg={palette.dim}>{"  "}</span>
            <span fg={palette.accent}>{actionLabel}</span>
          </text>
        </box>
      </box>
      <text>
        <span fg={palette.accent}>{`${title} ▸ `}</span>
        <span fg={palette.dim}>
          {inputFocused
            ? "Enter action · Tab browse · Esc back"
            : "↑/↓ navigate · Enter select · Tab edit · Esc back"}
        </span>
      </text>
      {context ? (
        <box flexDirection="column" paddingLeft={2}>
          <text fg={palette.dim}>Repository</text>
          <text>{clip(context.title, labelRoom)}</text>
          <text fg={palette.dim}>{clip(context.description, labelRoom)}</text>
        </box>
      ) : null}
      {status === "loading" ? (
        <text fg={palette.dim}>loading…</text>
      ) : status === "error" ? (
        <text fg={palette.error}>failed to load</text>
      ) : status === "empty" || rows.length === 0 ? (
        <text fg={palette.dim}>{emptyMessage}</text>
      ) : (
        visibleRows.map((row, offset) => {
          const index = start + offset;
          const active = index === selectedIndex;
          return (
            <box
              key={row.id}
              flexDirection="column"
              onMouseDown={() => {
                if (!row.disabled) onActivate(index);
              }}
              {...(active ? { backgroundColor: palette.selectedBg } : {})}
            >
              <text>
                <span fg={active ? palette.accent : palette.dim}>{active ? "▸ " : "  "}</span>
                <span fg={row.disabled ? palette.faint : active ? palette.text : palette.dim}>
                  {clip(row.title, labelRoom)}
                </span>
                {row.disabled ? <span fg={palette.warning}>{"  setup required"}</span> : null}
              </text>
              {row.description ? (
                <text fg={active ? palette.bg : palette.dim}>
                  {`    ${clip(row.description, labelRoom)}`}
                </text>
              ) : null}
            </box>
          );
        })
      )}
    </box>
  );
});
