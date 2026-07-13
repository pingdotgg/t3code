import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import * as React from "react";

import { filetypeForPath } from "../diffSplit.ts";
import type { FlatTreeRow } from "../fileTree.ts";
import { clip } from "../format.ts";
import { fileTypeColor } from "../icons.ts";
import { ansi, usePalette } from "../theme.ts";

// The workspace file browser (mirrors the web's Files surface), adapted to the
// TUI: it replaces the conversation pane with a navigable file tree; opening a
// file shows its syntax-highlighted contents in the same pane. Purely
// presentational — the entry list, selection, collapse state, and the loaded
// file all live in ChatView.

export type FilesStatus = "loading" | "ready" | "empty" | "error";

export interface ViewingFile {
  readonly path: string;
  readonly status: "loading" | "ready" | "error";
  readonly content: string;
}

function keyedTextLines(
  content: string,
): ReadonlyArray<{ readonly key: string; readonly line: string }> {
  const occurrences = new Map<string, number>();
  return content.split("\n").map((line) => {
    const occurrence = (occurrences.get(line) ?? 0) + 1;
    occurrences.set(line, occurrence);
    return { key: `${line}\u0000${occurrence}`, line };
  });
}

export const FilesView = React.memo(function FilesView({
  cwdLabel,
  status,
  rows,
  selectedIndex,
  viewing,
  width,
  height,
  syntaxStyle,
  scrollRef,
  purpose = "browse",
}: {
  /** A short label for the workspace root (shown in the header). */
  readonly cwdLabel: string;
  readonly status: FilesStatus;
  /** The flattened, collapse-aware file tree (dirs + files). */
  readonly rows: ReadonlyArray<FlatTreeRow>;
  readonly selectedIndex: number;
  /** When set, the pane shows this file's contents instead of the tree. */
  readonly viewing: ViewingFile | null;
  readonly width: number;
  readonly height: number;
  readonly syntaxStyle: SyntaxStyle;
  readonly scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>;
  readonly purpose?: "browse" | "attach-image";
}): React.ReactNode {
  const palette = usePalette();
  const bodyHeight = Math.max(1, height - 3);
  const nameRoom = Math.max(8, width - 18);

  let body: React.ReactNode;
  if (viewing) {
    const filetype = filetypeForPath(viewing.path);
    const content = viewing.content.length > 0 ? viewing.content : "(empty file)";
    body =
      viewing.status === "loading" ? (
        <text fg={palette.dim}>loading…</text>
      ) : viewing.status === "error" ? (
        <text fg={ansi("red")}>failed to read file</text>
      ) : (
        <scrollbox
          ref={scrollRef}
          height={bodyHeight}
          style={{ rootOptions: { backgroundColor: "transparent" } }}
        >
          {filetype ? (
            // Highlight when OpenTUI bundles the grammar; otherwise show plain
            // rows (a bare <text> doesn't split on newlines).
            <code content={content} filetype={filetype} syntaxStyle={syntaxStyle} />
          ) : (
            keyedTextLines(content).map(({ key, line }) => (
              <text key={key} fg={palette.text}>
                {line.length > 0 ? line : " "}
              </text>
            ))
          )}
        </scrollbox>
      );
  } else if (status === "loading") {
    body = <text fg={palette.dim}>loading…</text>;
  } else if (status === "error") {
    body = <text fg={ansi("red")}>failed to list files</text>;
  } else if (status === "empty" || rows.length === 0) {
    body = <text fg={palette.dim}>no files</text>;
  } else {
    // Window the list around the selection so the highlight stays on screen.
    const start = Math.min(
      Math.max(0, selectedIndex - Math.floor(bodyHeight / 2)),
      Math.max(0, rows.length - bodyHeight),
    );
    const visible = rows.slice(start, start + bodyHeight);
    body = (
      <>
        {visible.map((row, offset) => {
          const index = start + offset;
          const active = index === selectedIndex;
          const indent = "  ".repeat(row.depth);
          const marker = active ? "▸ " : "  ";
          if (row.kind === "dir") {
            return (
              <text key={`d:${row.path}`} {...(active ? { bg: palette.selectedBg } : {})}>
                <span
                  fg={active ? palette.accent : palette.dim}
                >{`${marker}${indent}${row.collapsed ? "▸" : "▾"} `}</span>
                <span fg={active ? palette.text : palette.dim}>
                  {clip(`${row.name}/`, nameRoom)}
                </span>
              </text>
            );
          }
          const typeColor = fileTypeColor(row.path);
          return (
            <text key={`f:${row.path}`} {...(active ? { bg: palette.selectedBg } : {})}>
              <span fg={typeColor ? ansi(typeColor) : palette.dim}>{`${marker}${indent}◦ `}</span>
              <span fg={active ? palette.text : palette.dim}>{clip(row.name, nameRoom)}</span>
            </text>
          );
        })}
      </>
    );
  }

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      height={height}
      border
      borderStyle="rounded"
      borderColor={palette.accent}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <span fg={palette.accent}>
          {viewing
            ? `file · ${clip(viewing.path, 40)}`
            : purpose === "attach-image"
              ? `attach image · ${clip(cwdLabel, 34)}`
              : `files · ${clip(cwdLabel, 40)}`}
        </span>
        <span fg={palette.dim}>
          {viewing
            ? "  ·  PgUp/PgDn scroll · Esc back"
            : purpose === "attach-image"
              ? "  ·  ↑/↓ select · Enter attach/expand · Esc cancel"
              : "  ·  ↑/↓ select · Enter open/expand · Esc close"}
        </span>
      </text>
      {body}
    </box>
  );
});
