import { type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core";
import * as React from "react";

import { splitUnifiedDiff } from "../diffSplit.ts";
import { ansi, usePalette } from "../theme.ts";

// A turn diff viewer (mirrors the web DiffPanel): fetches a turn's unified diff
// and renders each file in its own OpenTUI <diff> with that file's language
// highlighting + line numbers. `s` toggles stacked⇄split, like the web's view
// toggle. Replaces the conversation pane while open; ↑/↓ switch turns, PgUp/PgDn
// scroll, Esc closes. Purely presentational — fetch/selection live in ChatView.

export type DiffStatus = "loading" | "ready" | "empty" | "error";

export type DiffView = "unified" | "split";

export const DiffViewer = React.memo(function DiffViewer({
  turnCount,
  fileCount,
  status,
  diff,
  view,
  height,
  syntaxStyle,
  scrollRef,
}: {
  readonly turnCount: number;
  readonly fileCount: number;
  readonly status: DiffStatus;
  readonly diff: string;
  readonly view: DiffView;
  readonly height: number;
  readonly syntaxStyle: SyntaxStyle;
  readonly scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>;
}): React.ReactNode {
  const palette = usePalette();
  const bodyHeight = Math.max(1, height - 3);
  const files = React.useMemo(
    () => (status === "ready" ? splitUnifiedDiff(diff) : []),
    [status, diff],
  );
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
          {`  ${fileCount} file${fileCount === 1 ? "" : "s"} · ${view} · ↑/↓ turn · s ${
            view === "unified" ? "split" : "stacked"
          } · PgUp/PgDn scroll · Esc close`}
        </span>
      </text>
      {status === "loading" ? (
        <text fg={palette.dim}>loading…</text>
      ) : status === "error" ? (
        <text fg={ansi("red")}>failed to load diff</text>
      ) : status === "empty" || files.length === 0 ? (
        <text fg={palette.dim}>no changes in this turn</text>
      ) : (
        <scrollbox
          ref={scrollRef}
          height={bodyHeight}
          style={{ rootOptions: { backgroundColor: "transparent" } }}
        >
          {files.map((file) => (
            <box key={file.path} flexDirection="column" marginBottom={1} flexShrink={0}>
              <text>
                <strong>{file.path}</strong>
                {file.filetype ? <span fg={palette.dim}>{`  · ${file.filetype}`}</span> : null}
              </text>
              <diff
                diff={file.body}
                {...(file.filetype ? { filetype: file.filetype } : {})}
                view={view}
                showLineNumbers
                syntaxStyle={syntaxStyle}
              />
            </box>
          ))}
        </scrollbox>
      )}
    </box>
  );
});
