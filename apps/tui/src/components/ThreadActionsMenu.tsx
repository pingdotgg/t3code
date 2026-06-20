import type { OrchestrationCheckpointSummary } from "@t3tools/contracts";
import * as React from "react";

import { clip } from "../format.ts";
import { relativeTime } from "../theme.ts";
import { ansi, usePalette } from "../theme.ts";

// The thread-actions overlay (^K), mirroring the web sidebar's per-thread menu.
// Keeps the global keymap clean: mnemonic keys drive rename/archive/delete/stop on
// the selected thread, and a confirm step guards the destructive delete. Purely
// presentational — key handling lives in useKeyBindings, the actions in ChatView.

export const ThreadActionsMenu = React.memo(function ThreadActionsMenu({
  overlay,
  title,
  archived,
  sessionRunning,
}: {
  readonly overlay: "actions" | "confirmDelete";
  readonly title: string;
  readonly archived: boolean;
  readonly sessionRunning: boolean;
}): React.ReactNode {
  const palette = usePalette();
  const danger = ansi("red");
  const heading = clip(title, 48);

  if (overlay === "confirmDelete") {
    return (
      <box
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={danger}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
      >
        <text>
          <span fg={danger}>delete </span>
          <span fg={palette.text}>{heading}</span>
          <span fg={palette.dim}>{" — this can't be undone"}</span>
        </text>
        <text fg={palette.dim}>y delete · n / Esc cancel</text>
      </box>
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
        <span fg={palette.accent}>actions ▸ </span>
        <span fg={palette.text}>{heading}</span>
      </text>
      <text>
        <span fg={palette.text}>r</span>
        <span fg={palette.dim}>{" rename   "}</span>
        <span fg={palette.text}>a</span>
        <span fg={palette.dim}>{archived ? " unarchive   " : " archive   "}</span>
        <span fg={palette.text}>d</span>
        <span fg={palette.dim}>{" delete   "}</span>
        <span fg={sessionRunning ? palette.text : palette.dim}>s</span>
        <span fg={palette.dim}>{" stop   "}</span>
        <span fg={palette.text}>v</span>
        <span fg={palette.dim}>{" revert   "}</span>
        <span fg={palette.text}>g</span>
        <span fg={palette.dim}>{" diff   "}</span>
        <span fg={palette.text}>m</span>
        <span fg={palette.dim}>{" model   "}</span>
        <span fg={palette.dim}>Esc cancel</span>
      </text>
    </box>
  );
});

/** The checkpoint-revert picker (^K → v): ↑/↓ to choose a turn, Enter reverts. */
export const RevertMenu = React.memo(function RevertMenu({
  checkpoints,
  selected,
}: {
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
  readonly selected: number;
}): React.ReactNode {
  const palette = usePalette();
  const danger = ansi("red");
  const visible = checkpoints.slice(0, 8);
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={danger}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text>
        <span fg={danger}>revert ▸ </span>
        <span fg={palette.dim}>pick a checkpoint — discards changes made after it</span>
      </text>
      {visible.map((checkpoint, index) => {
        const active = index === selected;
        const fileCount = checkpoint.files.length;
        return (
          <text key={`${checkpoint.turnId}:${checkpoint.checkpointTurnCount}`}>
            <span fg={active ? palette.accent : palette.dim}>{active ? "▸ " : "  "}</span>
            <span fg={active ? palette.text : palette.dim}>
              {`turn ${checkpoint.checkpointTurnCount} · ${fileCount} file${fileCount === 1 ? "" : "s"} · ${relativeTime(checkpoint.completedAt)}`}
            </span>
          </text>
        );
      })}
      <text fg={palette.dim}>↑/↓ select · Enter revert · Esc cancel</text>
    </box>
  );
});
