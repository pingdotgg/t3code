import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import * as React from "react";

import { ansi, usePalette } from "../theme.ts";

// A turn diff viewer (mirrors the web DiffPanel): fetches a turn's unified diff
// and renders it with OpenTUI's <diff>. Replaces the conversation pane while open;
// ↑/↓ switch turns, PgUp/PgDn scroll, Esc closes. Purely presentational — the
// fetch + selection live in ChatView.

export type DiffStatus = "loading" | "ready" | "empty" | "error";

export const DiffViewer = React.memo(function DiffViewer({
  turnCount,
  fileCount,
  status,
  diff,
  height,
  syntaxStyle,
  scrollRef,
}: {
  readonly turnCount: number;
  readonly fileCount: number;
  readonly status: DiffStatus;
  readonly diff: string;
  readonly height: number;
  readonly syntaxStyle: SyntaxStyle;
  readonly scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>;
}): React.ReactNode {
  const palette = usePalette();
  const bodyHeight = Math.max(1, height - 3);
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
        <span fg={palette.accent}>{`diff · turn ${turnCount}`}</span>
        <span fg={palette.dim}>
          {`  ${fileCount} file${fileCount === 1 ? "" : "s"} · ↑/↓ turn · PgUp/PgDn scroll · Esc close`}
        </span>
      </text>
      {status === "loading" ? (
        <text fg={palette.dim}>loading…</text>
      ) : status === "error" ? (
        <text fg={ansi("red")}>failed to load diff</text>
      ) : status === "empty" ? (
        <text fg={palette.dim}>no changes in this turn</text>
      ) : (
        <scrollbox
          ref={scrollRef}
          height={bodyHeight}
          style={{ rootOptions: { backgroundColor: "transparent" } }}
        >
          <diff diff={diff} view="unified" syntaxStyle={syntaxStyle} />
        </scrollbox>
      )}
    </box>
  );
});
