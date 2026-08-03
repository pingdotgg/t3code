/**
 * The expanded commit detail.
 *
 * It is a SIBLING row in the virtualized list, never nested inside the commit
 * row: every row must have a height the virtualizer knows before it mounts, and
 * a nested expander does not. `HISTORY_DEFAULT_DRAWER_HEIGHT` is that height,
 * and this component scrolls internally rather than growing past it.
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyCommitDetail } from "@t3tools/contracts";

import { HISTORY_DEFAULT_DRAWER_HEIGHT } from "~/lib/sourceControl/historyRows";

import { changeLetter, splitDisplayPath } from "./sourceControlPanel.logic";

export function CommitDrawer(props: {
  readonly detail: WorkingCopyCommitDetail | null;
  readonly isLoading: boolean;
  readonly onCopy: (text: string) => void;
  readonly onOpenFile: (path: string, oldPath: string | undefined) => void;
}) {
  return (
    <div
      style={{ height: HISTORY_DEFAULT_DRAWER_HEIGHT }}
      className="flex flex-col overflow-hidden border-border/60 border-y bg-muted/24"
    >
      {props.isLoading || !props.detail ? (
        <p className="p-3 text-muted-foreground text-xs">Loading commit…</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2 px-3 pt-2 pb-1">
            <button
              type="button"
              className="font-mono text-muted-foreground text-xs hover:text-foreground"
              onClick={() => props.onCopy(props.detail?.hash ?? "")}
              title="Copy full hash"
            >
              {props.detail.hash}
            </button>
            <span className="ml-auto text-muted-foreground text-xs">
              {props.detail.authorName} &lt;{props.detail.authorEmail}&gt;
            </span>
          </div>
          {props.detail.body.trim().length > 0 ? (
            <pre className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 text-xs leading-snug">
              {props.detail.body}
            </pre>
          ) : null}
          <div className="flex items-center gap-2 px-3 pb-1 text-muted-foreground text-xs">
            <span>
              {props.detail.files.length} file{props.detail.files.length === 1 ? "" : "s"}
            </span>
            <span className="text-emerald-500">+{props.detail.insertions}</span>
            <span className="text-destructive-foreground">−{props.detail.deletions}</span>
            {props.detail.refs.map((ref) => (
              <span key={`${ref.kind}:${ref.name}`} className="rounded-sm bg-muted px-1">
                {ref.name}
              </span>
            ))}
          </div>
          <ul className="min-h-0 flex-1 overflow-auto pb-2">
            {props.detail.files.map((file) => {
              const { name, dir } = splitDisplayPath(file.path);
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    className="flex h-7 w-full items-center gap-2 px-3 text-left text-sm hover:bg-accent/50"
                    onClick={() => props.onOpenFile(file.path, file.oldPath)}
                  >
                    <span className="w-3 shrink-0 text-center font-mono text-muted-foreground text-xs">
                      {changeLetter(file.change)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {name}
                      {dir ? (
                        <span className="ml-1.5 text-muted-foreground text-xs">{dir}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums">
                      <span className="text-emerald-500">+{file.insertions ?? 0}</span>{" "}
                      <span className="text-destructive-foreground">−{file.deletions ?? 0}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
