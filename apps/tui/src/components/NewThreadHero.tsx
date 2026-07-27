import * as React from "react";

import { clip } from "../format.ts";
import { usePalette } from "../theme.ts";

/**
 * New-thread destination prompt, mirroring the web DraftHeroHeadline: the
 * project name is an action, not passive copy, so the destination can be
 * inspected and changed before the first message is sent.
 */
export function NewThreadHero({
  projectTitle,
  width,
  height,
  onOpenProject,
}: {
  readonly projectTitle: string | null;
  readonly width: number;
  readonly height: number;
  readonly onOpenProject: () => void;
}): React.ReactNode {
  const palette = usePalette();
  const projectLabel = clip(projectTitle ?? "Choose a project", Math.max(8, width - 34));

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      width={width}
      height={height}
      justifyContent="center"
      alignItems="center"
      border
      borderStyle="rounded"
      borderColor={palette.dim}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      <box
        flexDirection="row"
        justifyContent="center"
        width={Math.max(1, width - 2)}
        height={1}
        flexShrink={0}
      >
        <text fg={palette.text}>What should we build in </text>
        <box onMouseDown={onOpenProject} flexShrink={0}>
          <text>
            <u>
              <span fg={palette.accent}>{projectLabel}</span>
            </u>
            <span fg={palette.accent}>{" ▾"}</span>
          </text>
        </box>
        <text fg={palette.text}>?</text>
      </box>
      <box
        width={Math.max(1, width - 2)}
        height={1}
        justifyContent="center"
        marginTop={1}
        flexShrink={0}
      >
        <text fg={palette.dim}>click the project or use ^K → Change project</text>
      </box>
    </box>
  );
}
