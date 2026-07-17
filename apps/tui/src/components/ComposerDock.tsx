import * as React from "react";

import { clip } from "../format.ts";
import { usePalette } from "../theme.ts";

export interface ComposerDockContext {
  readonly workspace: string;
  readonly branch: string;
  readonly onOpenWorkspace?: () => void;
  readonly onOpenBranch?: () => void;
}

/**
 * Align the prompt with the conversation column while the terminal continues to
 * span the full application width. This mirrors the web layout: a bounded,
 * centered composer with lightweight checkout context directly beneath it.
 */
export function ComposerDock({
  leftWidth,
  mainWidth,
  rightWidth,
  surfaceWidth,
  context,
  children,
}: {
  readonly leftWidth: number;
  readonly mainWidth: number;
  readonly rightWidth: number;
  readonly surfaceWidth: number;
  readonly context: ComposerDockContext | null;
  readonly children: React.ReactNode;
}): React.ReactNode {
  const palette = usePalette();
  const contextRoom = Math.max(8, Math.floor(surfaceWidth / 2) - 2);
  return (
    <box flexDirection="row" flexShrink={0}>
      <box width={leftWidth} flexShrink={0} />
      <box width={mainWidth} flexDirection="column" alignItems="center" flexShrink={0}>
        <box width={surfaceWidth} flexShrink={0}>
          {children}
        </box>
        {context ? (
          <box
            width={surfaceWidth}
            flexDirection="row"
            justifyContent="space-between"
            paddingLeft={1}
            paddingRight={1}
            flexShrink={0}
          >
            <box
              flexShrink={0}
              {...(context.onOpenWorkspace ? { onMouseDown: context.onOpenWorkspace } : {})}
            >
              <text fg={palette.dim}>
                {clip(`${context.workspace}${context.onOpenWorkspace ? " ▾" : ""}`, contextRoom)}
              </text>
            </box>
            <box
              flexShrink={0}
              {...(context.onOpenBranch ? { onMouseDown: context.onOpenBranch } : {})}
            >
              <text fg={palette.dim}>
                {clip(`branch ${context.branch}${context.onOpenBranch ? " ▾" : ""}`, contextRoom)}
              </text>
            </box>
          </box>
        ) : null}
      </box>
      <box width={rightWidth} flexShrink={0} />
    </box>
  );
}
