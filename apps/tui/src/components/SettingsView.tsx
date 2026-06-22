import type { ScrollBoxRenderable } from "@opentui/core";
import type { VcsStatusResult } from "@t3tools/contracts";
import * as React from "react";

import { type ComposerControls, interactionModeLabel, runtimeModeLabel } from "../controls.ts";
import { clip } from "../format.ts";
import { KEYBINDING_GROUPS } from "../keymap.ts";
import { ansi, usePalette } from "../theme.ts";

// A read-only settings / reference overlay (the TUI form of the web Settings):
// the live provider + source-control state for the selected thread, plus the
// keybinding reference. Replaces the conversation pane; Esc closes, PgUp/PgDn
// scroll. Editing settings (provider auth, custom keymaps) stays in the web.

function Row({
  label,
  value,
  width,
}: {
  readonly label: string;
  readonly value: string;
  readonly width: number;
}): React.ReactNode {
  const palette = usePalette();
  return (
    <text>
      <span fg={palette.dim}>{`  ${label.padEnd(16)}`}</span>
      <span fg={palette.text}>{clip(value, Math.max(8, width - 20))}</span>
    </text>
  );
}

export const SettingsView = React.memo(function SettingsView({
  controls,
  vcsStatus,
  width,
  height,
  scrollRef,
}: {
  readonly controls: ComposerControls;
  readonly vcsStatus: VcsStatusResult | null;
  readonly width: number;
  readonly height: number;
  readonly scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>;
}): React.ReactNode {
  const palette = usePalette();
  const bodyHeight = Math.max(1, height - 3);
  const keyCol = 16;
  const pr = vcsStatus?.pr ?? null;

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
        <span fg={palette.accent}>settings</span>
        <span fg={palette.dim}>{"  ·  PgUp/PgDn scroll · Esc close"}</span>
      </text>
      <scrollbox
        ref={scrollRef}
        height={bodyHeight}
        style={{ rootOptions: { backgroundColor: "transparent" } }}
      >
        <text fg={palette.accent}>Providers</text>
        <Row label="model" value={controls.model ?? "—"} width={width} />
        <Row label="reasoning" value={controls.reasoning ?? "—"} width={width} />
        <Row label="mode" value={interactionModeLabel(controls.interactionMode)} width={width} />
        <Row label="runtime access" value={runtimeModeLabel(controls.runtimeMode)} width={width} />

        <text> </text>
        <text fg={palette.accent}>Source control</text>
        <Row label="branch" value={vcsStatus?.refName ?? "—"} width={width} />
        <Row
          label="pull request"
          value={pr ? `#${pr.number} ${pr.state}` : "—"}
          width={width}
        />
        <Row
          label="working tree"
          value={vcsStatus ? (vcsStatus.hasWorkingTreeChanges ? "uncommitted changes" : "clean") : "—"}
          width={width}
        />

        {KEYBINDING_GROUPS.map((group) => (
          <box key={group.title} flexDirection="column">
            <text> </text>
            <text fg={palette.accent}>{group.title}</text>
            {group.bindings.map((binding) => (
              <text key={binding.keys + binding.description}>
                <span fg={ansi("cyan")}>{`  ${binding.keys.padEnd(keyCol)}`}</span>
                <span fg={palette.text}>{clip(binding.description, Math.max(8, width - keyCol - 4))}</span>
              </text>
            ))}
          </box>
        ))}
      </scrollbox>
    </box>
  );
});
