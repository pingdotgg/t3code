import * as React from "react";

import { type ComposerControls, interactionModeLabel, runtimeModeLabel } from "../controls.ts";
import { ansi, usePalette } from "../theme.ts";

// The composer controls toolbar (mirrors the web ChatComposer's bottom controls
// row): the always-visible state of plan/build, runtime access, model, and
// reasoning. Each chip is a clickable box labelled with the key that also changes
// it.

function Chip({
  keyHint,
  label,
  active,
  muted,
  onClick,
}: {
  readonly keyHint: string;
  readonly label: string;
  readonly active?: boolean;
  readonly muted?: boolean;
  readonly onClick: () => void;
}): React.ReactNode {
  const palette = usePalette();
  const labelColor = active ? palette.accent : muted ? palette.dim : palette.text;
  return (
    <box onMouseDown={onClick} flexShrink={0} marginRight={3}>
      <text>
        <span fg={active ? palette.accent : palette.dim}>{`${keyHint} `}</span>
        <span fg={labelColor}>{label}</span>
      </text>
    </box>
  );
}

// A prominent red stop button shown only while the agent is running, mirroring the
// web composer swapping its send button for a stop button. Clickable (mouse) and
// also reachable via Esc.
function StopButton({ onStop }: { readonly onStop: () => void }): React.ReactNode {
  const palette = usePalette();
  return (
    <box onMouseDown={onStop} flexShrink={0}>
      <text>
        <span fg={ansi("red")}>■ Stop</span>
        <span fg={palette.dim}> Esc</span>
      </text>
    </box>
  );
}

export const ControlsRow = React.memo(function ControlsRow({
  controls,
  working,
  onTogglePlan,
  onOpenAccess,
  onOpenModel,
  onOpenReasoning,
  onStop,
}: {
  readonly controls: ComposerControls;
  readonly working: boolean;
  readonly onTogglePlan: () => void;
  readonly onOpenAccess: () => void;
  readonly onOpenModel: () => void;
  readonly onOpenReasoning: () => void;
  readonly onStop: () => void;
}): React.ReactNode {
  // Order mirrors the web composer footer (model first, then reasoning, mode,
  // access). Rendered inside the composer's bordered box, so no own padding.
  return (
    <box flexDirection="row" marginTop={1} flexShrink={0}>
      <Chip keyHint="model" label={controls.model ?? "—"} muted={!controls.model} onClick={onOpenModel} />
      <Chip
        keyHint="reasoning"
        label={controls.reasoning ?? "—"}
        muted={!controls.reasoning}
        onClick={onOpenReasoning}
      />
      <Chip
        keyHint="^B"
        label={interactionModeLabel(controls.interactionMode)}
        active={controls.interactionMode === "plan"}
        onClick={onTogglePlan}
      />
      <Chip keyHint="^O" label={runtimeModeLabel(controls.runtimeMode)} onClick={onOpenAccess} />
      {working ? (
        <>
          <box flexGrow={1} />
          <StopButton onStop={onStop} />
        </>
      ) : null}
    </box>
  );
});
