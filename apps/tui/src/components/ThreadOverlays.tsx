import type { OrchestrationCheckpointSummary } from "@t3tools/contracts";
import * as React from "react";

import { clip } from "../format.ts";
import { relativeTime, usePalette } from "../theme.ts";

// Bottom-slot confirmation/picker overlays opened from the command palette (^K):
// the destructive delete confirm-step and the checkpoint-revert picker. Purely
// presentational — key handling lives in useKeyBindings, the actions in ChatView.

/** The delete confirm-step (palette → "Delete thread"): y deletes, n/Esc cancels. */
export const ConfirmDeleteMenu = React.memo(function ConfirmDeleteMenu({
  title,
}: {
  readonly title: string;
}): React.ReactNode {
  const palette = usePalette();
  const danger = palette.error;
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
        <span fg={palette.text}>{clip(title, 48)}</span>
        <span fg={palette.dim}>{" — this can't be undone"}</span>
      </text>
      <text fg={palette.dim}>y delete · n / Esc cancel</text>
    </box>
  );
});

/** The checkpoint-revert picker (palette → "Revert"): ↑/↓ to choose a turn, Enter reverts. */
export const RevertMenu = React.memo(function RevertMenu({
  checkpoints,
  selected,
}: {
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
  readonly selected: number;
}): React.ReactNode {
  const palette = usePalette();
  const danger = palette.error;
  const windowSize = 8;
  const windowStart = Math.min(
    Math.max(0, selected - windowSize + 1),
    Math.max(0, checkpoints.length - windowSize),
  );
  const visible = checkpoints.slice(windowStart, windowStart + windowSize);
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
        const active = windowStart + index === selected;
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
