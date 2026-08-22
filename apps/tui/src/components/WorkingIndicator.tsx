import * as React from "react";

import { usePalette } from "../theme.ts";

// A streamed event will repaint the timeline when useful work lands. Keeping
// this marker static avoids scheduling terminal frames just to animate chrome.
export const WorkingIndicator = React.memo(function WorkingIndicator(): React.ReactNode {
  const palette = usePalette();
  return (
    <box marginBottom={1}>
      <text>
        <span fg={palette.accent}>{"● "}</span>
        <span fg={palette.dim}>Working…</span>
      </text>
    </box>
  );
});
