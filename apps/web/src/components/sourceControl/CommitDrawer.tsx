/**
 * The expanded commit detail.
 *
 * It is a SIBLING row in the virtualized list, never nested inside the commit
 * row: every row must have a height the virtualizer knows before it mounts, and
 * a nested expander does not.
 *
 * fork: f4 redesign (audit §8 / M6) — that height is now MEASURED. It used to
 * be a hard-coded 280px whose own comment said "used until the open drawer has
 * been measured", and nothing ever measured it: a one-file commit opened 280px
 * of empty panel, and a sixty-file commit opened a nested scroller inside the
 * already-scrolling virtual list (a scroll trap — the wheel stops working when
 * the pointer crosses into the drawer).
 *
 * The measurement cannot loop: the outer box is the fixed row height, the
 * scroller inside it is `size-full`, and the measured element is the CONTENT,
 * whose natural height does not depend on either. `clampHistoryDrawerHeight`
 * bounds the result so one pathological commit cannot eat the list.
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyCommitDetail } from "@t3tools/contracts";
import { Copy } from "lucide-react";
import { useEffect, useRef } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { PathLabel } from "./PathLabel";
import { changeLetter, splitDisplayPath } from "./sourceControlPanel.logic";

export function CommitDrawer(props: {
  readonly detail: WorkingCopyCommitDetail | null;
  readonly isLoading: boolean;
  /** The row height the virtualizer is currently reserving for this drawer. */
  readonly height: number;
  /** Natural content height, in px, reported after every layout change. */
  readonly onMeasure: (height: number) => void;
  readonly onCopy: (text: string, label?: string) => void;
  readonly onOpenFile: (path: string, oldPath: string | undefined) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastReported = useRef<number>(-1);
  const { onMeasure } = props;

  useEffect(() => {
    const element = contentRef.current;
    if (element === null) return;
    const report = () => {
      const measured = element.scrollHeight;
      // Report only real changes: an unconditional report on every observer
      // callback is how a measure/render pair turns into a repaint loop.
      if (Math.abs(measured - lastReported.current) < 2) return;
      lastReported.current = measured;
      onMeasure(measured);
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [onMeasure, props.detail, props.isLoading]);

  return (
    <div
      style={{ height: props.height }}
      className="overflow-hidden border-border/60 border-y bg-muted/50"
    >
      <div className="size-full overflow-y-auto overscroll-contain">
        <div ref={contentRef} className="flex flex-col gap-1 px-3 py-2">
          {props.isLoading || !props.detail ? (
            <div className="space-y-2 py-1" role="status" aria-live="polite">
              <Skeleton className="h-3.5 w-40 rounded-full" />
              <Skeleton className="h-3.5 w-full rounded-full" />
              <Skeleton className="h-3.5 w-3/4 rounded-full" />
              <span className="sr-only">Loading commit…</span>
            </div>
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="xs"
                        variant="ghost"
                        className="max-w-40 shrink-0 font-mono text-muted-foreground"
                        onClick={() => props.onCopy(props.detail?.hash ?? "", "the commit hash")}
                      />
                    }
                  >
                    <span className="truncate">{props.detail.shortHash}</span>
                    <Copy />
                  </TooltipTrigger>
                  <TooltipPopup>Copy the full hash</TooltipPopup>
                </Tooltip>
                {/* fork: f4 M22 — was an unbounded `ml-auto` span that pushed
                    the hash off the left edge for a long address. */}
                <span className="min-w-0 flex-1 truncate text-right text-muted-foreground text-xs">
                  {props.detail.authorName} &lt;{props.detail.authorEmail}&gt;
                </span>
              </div>

              {props.detail.refs.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  {props.detail.refs.map((ref) => (
                    <Badge
                      key={`${ref.kind}:${ref.name}`}
                      size="sm"
                      variant={ref.kind === "tag" ? "warning" : "secondary"}
                      className="max-w-40 truncate"
                    >
                      {ref.name}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {props.detail.body.trim().length > 0 ? (
                <pre className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap break-words text-xs leading-snug">
                  {props.detail.body}
                </pre>
              ) : null}

              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <span>
                  {props.detail.files.length} file{props.detail.files.length === 1 ? "" : "s"}
                </span>
                <DiffStatLabel
                  additions={props.detail.insertions}
                  deletions={props.detail.deletions}
                  className="gap-1"
                />
              </div>

              <ul className="-mx-3">
                {props.detail.files.map((file) => {
                  const { name, dir } = splitDisplayPath(file.path);
                  return (
                    <li key={file.path}>
                      <button
                        type="button"
                        className="flex h-7 w-full items-center gap-2 px-3 text-left text-sm outline-none hover:bg-accent/50 focus-visible:inset-ring-2 focus-visible:inset-ring-ring"
                        onClick={() => props.onOpenFile(file.path, file.oldPath)}
                      >
                        <span className="w-3 shrink-0 text-center font-mono text-muted-foreground text-xs">
                          {changeLetter(file.change)}
                        </span>
                        <PathLabel name={name} dir={dir} />
                        <span className="shrink-0 text-xs">
                          <DiffStatLabel
                            additions={file.insertions ?? 0}
                            deletions={file.deletions ?? 0}
                            className="gap-1"
                          />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
