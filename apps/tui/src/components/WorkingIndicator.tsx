import * as React from "react";

import { usePalette } from "../theme.ts";
import { workingElapsedSeconds } from "../timeline.ts";

// The live "Working… Ns" row shown while a turn runs. It owns its own fast tick so
// the braille spinner animates (signalling liveness, like the web's pulse) WITHOUT
// re-rendering the rest of the conversation — only this component re-renders.

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TICK_MS = 120;

export const WorkingIndicator = React.memo(function WorkingIndicator({
  startedAt,
}: {
  readonly startedAt: string | null;
}): React.ReactNode {
  const palette = usePalette();
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const frame = SPINNER[tick % SPINNER.length];
  const elapsed = workingElapsedSeconds(startedAt, Date.now());
  const label = elapsed !== null ? `Working… ${elapsed}s` : "Working…";
  return (
    <box marginBottom={1}>
      <text>
        <span fg={palette.accent}>{`${frame} `}</span>
        <span fg={palette.dim}>{label}</span>
      </text>
    </box>
  );
});
