import * as React from "react";

import { clip } from "../format.ts";
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
        <span fg={palette.dim}>Esc cancel</span>
      </text>
    </box>
  );
});
