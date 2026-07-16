import type { VcsStatusResult } from "@t3tools/contracts";
import * as React from "react";

import { clip } from "../format.ts";
import type { GitPanelAction } from "../gitActions.logic.ts";
import { deferMouseAction } from "../mouse.ts";
import { ansi, type Palette, usePalette } from "../theme.ts";

function prColor(state: string | undefined, palette: Palette): ReturnType<typeof ansi> {
  if (state === "open") return ansi("green");
  if (state === "merged") return ansi("magenta");
  return palette.dim;
}

export function RightPanel({
  status,
  busy,
  actions,
  selectedIndex,
  focused,
  width,
  height,
  onSelect,
  onActivate,
}: {
  readonly status: VcsStatusResult | null;
  readonly busy: boolean;
  readonly actions: ReadonlyArray<GitPanelAction>;
  readonly selectedIndex: number;
  readonly focused: boolean;
  readonly width: number;
  readonly height: number;
  readonly onSelect: (index: number) => void;
  readonly onActivate: (action: GitPanelAction) => void;
}): React.ReactNode {
  const palette = usePalette();
  const room = Math.max(6, width - 4);
  const pr = status?.pr ?? null;
  const selectedAction = actions[selectedIndex] ?? null;
  const fileCount = status?.workingTree.files.length ?? 0;

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={focused ? palette.accent : palette.dim}
      paddingLeft={1}
      paddingRight={1}
    >
      <text>
        <strong>Source Control</strong>
        {busy ? <span fg={ansi("yellow")}>{" · working…"}</span> : null}
      </text>
      <text fg={palette.dim}>
        {focused ? "↑/↓ select · Enter activate · Esc back" : "^L focus panel"}
      </text>

      {status === null ? (
        <text fg={palette.dim}>{busy ? "  loading git status…" : "  no git status"}</text>
      ) : (
        <box flexDirection="column">
          <text>
            <span fg={palette.dim}>{"on "}</span>
            <span fg={palette.text}>{clip(status.refName ?? "(detached)", room)}</span>
          </text>
          {status.aheadCount > 0 || status.behindCount > 0 ? (
            <text fg={palette.dim}>
              {`${status.aheadCount > 0 ? `↑${status.aheadCount}` : ""}${
                status.aheadCount > 0 && status.behindCount > 0 ? " " : ""
              }${status.behindCount > 0 ? `↓${status.behindCount}` : ""} upstream`}
            </text>
          ) : status.hasUpstream ? (
            <text fg={palette.dim}>up to date with upstream</text>
          ) : null}
          {pr ? (
            <text>
              <a href={pr.url}>
                <span fg={prColor(pr.state, palette)}>{`◰ PR #${pr.number} `}</span>
                <span fg={palette.dim}>{`${pr.state} ↗`}</span>
              </a>
            </text>
          ) : null}
          {status.hasWorkingTreeChanges ? (
            <text fg={palette.dim}>
              {clip(
                `${fileCount} ${fileCount === 1 ? "file" : "files"} · +${status.workingTree.insertions} -${status.workingTree.deletions}`,
                room,
              )}
            </text>
          ) : (
            <text fg={palette.dim}>working tree clean</text>
          )}
        </box>
      )}

      <box flexDirection="column" marginTop={1}>
        <text fg={palette.dim}>actions</text>
        {actions.map((action, index) => {
          const selected = index === selectedIndex;
          const color = action.disabled
            ? palette.dim
            : selected && focused
              ? palette.accent
              : action.primary
                ? palette.accent
                : palette.text;
          const activateFromMouse = deferMouseAction(() => {
            onSelect(index);
            if (!action.disabled) onActivate(action);
          });
          const label = clip(`${action.label}${action.kind === "url" ? " ↗" : ""}`, room - 2);
          return (
            <box
              key={action.id}
              onMouseDown={activateFromMouse}
              marginBottom={action.primary ? 1 : 0}
            >
              <text>
                <span fg={selected ? palette.accent : palette.dim}>{selected ? "▸ " : "  "}</span>
                {action.kind === "url" ? (
                  <a href={action.url}>
                    <span fg={color}>{label}</span>
                  </a>
                ) : (
                  <span fg={color}>{label}</span>
                )}
              </text>
            </box>
          );
        })}
      </box>

      {selectedAction?.hint ? (
        <text fg={selectedAction.disabled ? ansi("yellow") : palette.dim}>
          {clip(`  ${selectedAction.hint}`, room)}
        </text>
      ) : null}
    </box>
  );
}
