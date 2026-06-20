import * as React from "react";

import { type ComposerControls, interactionModeLabel, runtimeModeLabel } from "../controls.ts";
import { usePalette } from "../theme.ts";

// The composer controls toolbar (mirrors the web ChatComposer's bottom controls
// row): the always-visible state of plan/build, runtime access, model, and
// reasoning, each with the key that changes it. Purely presentational.

export const ControlsRow = React.memo(function ControlsRow({
  controls,
}: {
  readonly controls: ComposerControls;
}): React.ReactNode {
  const palette = usePalette();
  const planActive = controls.interactionMode === "plan";
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <text>
        <span fg={planActive ? palette.accent : palette.dim}>{"^B "}</span>
        <span fg={planActive ? palette.accent : palette.text}>
          {interactionModeLabel(controls.interactionMode)}
        </span>
        <span fg={palette.dim}>{"  ·  ^O "}</span>
        <span fg={palette.text}>{runtimeModeLabel(controls.runtimeMode)}</span>
        {controls.model ? (
          <>
            <span fg={palette.dim}>{"  ·  "}</span>
            <span fg={palette.text}>{controls.model}</span>
          </>
        ) : null}
        {controls.reasoning ? (
          <>
            <span fg={palette.dim}>{"  ·  "}</span>
            <span fg={palette.text}>{controls.reasoning}</span>
          </>
        ) : null}
        <span fg={palette.dim}>{"   (^K m model · e reasoning)"}</span>
      </text>
    </box>
  );
});
