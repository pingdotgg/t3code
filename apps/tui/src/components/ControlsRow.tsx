import * as React from "react";

import { type ComposerControls, interactionModeLabel, runtimeModeLabel } from "../controls.ts";
import { usePalette } from "../theme.ts";

// The composer controls toolbar (mirrors the web ChatComposer's bottom controls
// row): the always-visible state of plan/build, runtime access, model, and
// reasoning. Each chip is clickable (onMouseDown) and labelled with the key that
// also changes it.

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
    <box onMouseDown={onClick} flexShrink={0}>
      <text>
        <span fg={active ? palette.accent : palette.dim}>{`${keyHint} `}</span>
        <span fg={labelColor}>{label}</span>
      </text>
    </box>
  );
}

export const ControlsRow = React.memo(function ControlsRow({
  controls,
  onTogglePlan,
  onOpenAccess,
  onOpenModel,
  onOpenReasoning,
}: {
  readonly controls: ComposerControls;
  readonly onTogglePlan: () => void;
  readonly onOpenAccess: () => void;
  readonly onOpenModel: () => void;
  readonly onOpenReasoning: () => void;
}): React.ReactNode {
  const palette = usePalette();
  const dot = (
    <text>
      <span fg={palette.dim}>{"  ·  "}</span>
    </text>
  );
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <Chip
        keyHint="^B"
        label={interactionModeLabel(controls.interactionMode)}
        active={controls.interactionMode === "plan"}
        onClick={onTogglePlan}
      />
      {dot}
      <Chip keyHint="^O" label={runtimeModeLabel(controls.runtimeMode)} onClick={onOpenAccess} />
      {dot}
      <Chip keyHint="model" label={controls.model ?? "—"} muted={!controls.model} onClick={onOpenModel} />
      {dot}
      <Chip
        keyHint="reasoning"
        label={controls.reasoning ?? "—"}
        muted={!controls.reasoning}
        onClick={onOpenReasoning}
      />
    </box>
  );
});
