import type { GitStackedAction, VcsStatusResult } from "@t3tools/contracts";
import * as React from "react";

import { clip } from "../format.ts";
import { buildGitMenuItems, resolveGitQuickAction } from "../gitActions.logic.ts";
import { ansi, type Palette, usePalette } from "../theme.ts";

// The right-side source-control panel, mirroring the web's GitActionsControl +
// ThreadStatusIndicators: branch + PR status, a prominent quick action
// (Commit / Push / Push & create PR / View PR), and the contextual actions list.
// Driven by the live VcsStatusResult; clicking an action runs it via the store.

function prColor(state: string | undefined, palette: Palette): ReturnType<typeof ansi> {
  if (state === "open") return ansi("green");
  if (state === "merged") return ansi("magenta");
  return palette.dim;
}

export function RightPanel({
  status,
  busy,
  width,
  height,
  onRunAction,
  onPull,
  onOpenUrl,
}: {
  readonly status: VcsStatusResult | null;
  readonly busy: boolean;
  readonly width: number;
  readonly height: number;
  readonly onRunAction: (action: GitStackedAction) => void;
  readonly onPull: () => void;
  readonly onOpenUrl: (url: string) => void;
}): React.ReactNode {
  const palette = usePalette();
  const room = Math.max(6, width - 4);
  const quick = resolveGitQuickAction(status, busy);
  const items = buildGitMenuItems(status, busy);
  const pr = status?.pr ?? null;

  const runQuick = () => {
    if (quick.kind === "run_action") onRunAction(quick.action);
    else if (quick.kind === "open_pr" && pr) onOpenUrl(pr.url);
    else if (quick.kind === "run_pull") onPull();
  };
  // Publishing a repo needs a provider/visibility dialog the TUI doesn't host, so
  // it's surfaced as a hint rather than a runnable action.
  const quickActionable =
    quick.kind === "run_action" || quick.kind === "open_pr" || quick.kind === "run_pull";

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={palette.dim}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <strong>Source Control</strong>
      </text>

      {status === null ? (
        <text fg={palette.dim}>{busy ? "  working…" : "  no git status"}</text>
      ) : (
        <box flexDirection="column">
          <text>
            <span fg={palette.dim}>{"on "}</span>
            <span fg={palette.text}>{clip(status.refName ?? "(detached)", room)}</span>
          </text>
          {pr ? (
            <text>
              <span fg={prColor(pr.state, palette)}>{`◰ PR #${pr.number} `}</span>
              <span fg={palette.dim}>{pr.state}</span>
            </text>
          ) : null}
          {status.hasWorkingTreeChanges ? (
            <text fg={palette.dim}>{"  uncommitted changes"}</text>
          ) : null}

          {/* Prominent quick action. */}
          <box marginTop={1} {...(quickActionable ? { onMouseDown: runQuick } : {})}>
            <text>
              <span fg={quick.disabled ? palette.dim : palette.accent}>{"▸ "}</span>
              <span fg={quick.disabled ? palette.dim : palette.text}>{clip(quick.label, room)}</span>
            </text>
          </box>
          {quick.kind === "show_hint" ? <text fg={palette.dim}>{`  ${clip(quick.hint, room)}`}</text> : null}
          {quick.kind === "open_publish" ? (
            <text fg={palette.dim}>{"  publish from the terminal (^E)"}</text>
          ) : null}

          {/* Contextual actions menu. */}
          {items.length > 0 ? (
            <box flexDirection="column" marginTop={1}>
              <text fg={palette.dim}>{"actions"}</text>
              {items.map((item) => {
                const onClick = item.disabled
                  ? undefined
                  : item.action
                    ? () => onRunAction(item.action as GitStackedAction)
                    : item.openUrl
                      ? () => onOpenUrl(item.openUrl as string)
                      : undefined;
                return (
                  <box key={item.id} {...(onClick ? { onMouseDown: onClick } : {})}>
                    <text fg={item.disabled ? palette.dim : palette.text}>
                      {`  ${item.label}${item.openUrl ? " ↗" : ""}`}
                    </text>
                  </box>
                );
              })}
            </box>
          ) : null}
        </box>
      )}
    </box>
  );
}
