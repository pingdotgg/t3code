import { ReviewPath } from "../../diffs/ReviewPath";
import { Checkbox } from "../../ui/checkbox";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestReviewGuideStop } from "@t3tools/contracts";
import {
  ArrowRightIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
} from "lucide-react";
import { useId, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";

import { getDiffLineStat } from "~/lib/diffRendering";
import { useTheme } from "~/hooks/useTheme";
import { PierreEntryIcon } from "../../chat/PierreEntryIcon";

import { DiffWorkerPoolProvider } from "../../DiffWorkerPoolProvider";
import { Button } from "../../ui/button";
import { PullRequestDiffStat } from "../pullRequestPresentation";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { GuideExcerpt, type ExcerptCommenting } from "./GuideExcerpt";
import { ReviewChapterHeader } from "../ReviewChapterHeader";
import { GuideFileDiff } from "./GuideFileDiff";
import { GuideProse } from "./GuideProse";
import { letterStopNotes, stopFilePaths } from "@t3tools/client-runtime/review-guide-tour";

export interface GuideStopHandle {
  revealFile: (path: string) => void;
}

/**
 * One stop of the tour: what it is about, where to look, and the two things a reader does with
 * it: comment on its lines for the review, or ask an agent about it.
 */
export function GuideStop({
  stop,
  index,
  stopCount,
  railOpen,
  onRailOpenChange,
  stopList,
  nextTitle,
  files,
  loadDiffFiles,
  diffLoading,
  commenting,
  onStep,
  onAsk,
  onFinish,
  onOpenFile,
  isViewed,
  onSetViewed,
  navigationRef,
}: {
  navigationRef: Ref<GuideStopHandle>;
  stop: PullRequestReviewGuideStop;
  index: number;
  stopCount: number;
  /** Whether the stop list is folded open under the header, on a narrow panel. */
  railOpen: boolean;
  onRailOpenChange: (open: boolean) => void;
  /** The tour's stop list, folded under the header on a narrow panel. */
  stopList: ReactNode;
  /** The following stop's title, null on the last stop. */
  nextTitle: string | null;
  files: ReadonlyMap<string, FileDiffMetadata>;
  /** Loads a file's unchanged lines for the bars between hunks. */
  loadDiffFiles: FileDiffContentsLoader;
  diffLoading: boolean;
  /** Commenting on excerpt lines; null where the reader can neither comment nor ask. */
  commenting: ExcerptCommenting | null;
  onStep: (delta: 1 | -1) => void;
  /** Opens an agent thread about this stop, with the question prefilled or empty. */
  onAsk: ((question: string) => void) | null;
  /** Opens the review composer, on the last stop. Null where the reader cannot review. */
  onFinish: (() => void) | null;
  onOpenFile: (path: string) => void;
  isViewed: (path: string) => boolean;
  onSetViewed: ((paths: ReadonlyArray<string>, viewed: boolean) => void) | null;
}) {
  const { resolvedTheme } = useTheme();
  const { byExcerpt } = letterStopNotes(stop);
  const otherFiles = stopFilePaths(stop).map((path) => ({
    path,
    note: stop.files.find((file) => file.path === path)?.note,
  }));

  const [filePanels, setFilePanels] = useState<Record<string, { viewed: boolean; open: boolean }>>(
    {},
  );

  const reviewCheckboxPrefix = useId();
  const fileRows = useRef(new Map<string, HTMLLIElement>());
  useImperativeHandle(
    navigationRef,
    () => ({
      revealFile: (path) => {
        setFilePanels((current) => ({
          ...current,
          [path]: { viewed: isViewed(path), open: true },
        }));
        requestAnimationFrame(() => {
          const row = fileRows.current.get(path);
          const scroller = row?.closest("[data-guide-diff-scroll]");
          if (!row || !(scroller instanceof HTMLElement)) return;
          const top =
            scroller.scrollTop +
            row.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top;
          scroller.scrollTo({ top: Math.max(top - 8, 0) });
        });
      },
    }),
    [isViewed],
  );

  return (
    <article className="flex min-w-0 flex-col gap-4">
      <div className="border-b border-border/60 px-4 py-2">
        <ReviewChapterHeader
          index={index}
          count={stopCount}
          railOpen={railOpen}
          onRailOpenChange={onRailOpenChange}
          rail={stopList}
          onStep={onStep}
          keyboardHints
        />
      </div>
        {stop.excerpts.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-4">
            <DiffWorkerPoolProvider>
              {stop.excerpts.map((excerpt, excerptIndex) => (
                <GuideExcerpt
                  key={`${excerpt.path}:${excerpt.side}:${excerpt.start}-${excerpt.end}`}
                  excerpt={excerpt}
                  file={files.get(excerpt.path) ?? null}
                  loading={diffLoading}
                  notes={byExcerpt[excerptIndex] ?? []}
                  commenting={commenting}
                  loadDiffFiles={loadDiffFiles}
                  onOpenFile={onOpenFile}
                  viewed={isViewed(excerpt.path)}
                  onSetViewed={onSetViewed ? (value) => onSetViewed([excerpt.path], value) : null}
                />
              ))}
            </DiffWorkerPoolProvider>
          </div>
        ) : null}

        {otherFiles.length > 0 ? (
          <section className="flex flex-col gap-1.5">
          <h3 className="px-4 text-xs font-medium text-muted-foreground">Files in this chapter</h3>
            <DiffWorkerPoolProvider>
            <ul className="flex flex-col border-y border-border/60">
                {otherFiles.map((file) => {
                  const diff = files.get(file.path);
                  const stat = diff === undefined ? null : getDiffLineStat([diff]);
                  const viewed = isViewed(file.path);
                  const panel = filePanels[file.path];
                  const open = panel?.viewed === viewed ? panel.open : !viewed;
                  const reviewCheckboxId = `${reviewCheckboxPrefix}-${encodeURIComponent(file.path)}`;
                  return (
                    <li
                      key={file.path}
                      ref={(node) => {
                        if (node === null) fileRows.current.delete(file.path);
                        else fileRows.current.set(file.path, node);
                      }}
                      className="scroll-mt-4 border-border/60 not-first:border-t"
                    >
                      <Collapsible
                        open={open}
                        onOpenChange={(open) =>
                          setFilePanels((current) => ({
                            ...current,
                            [file.path]: { viewed, open },
                          }))
                        }
                      >
                      <div className="flex min-w-0 items-center gap-2 bg-foreground/7 px-3 py-2 text-xs">
                          <CollapsibleTrigger
                            render={<Button size="icon-xs" variant="ghost" />}
                            aria-label={`${open ? "Collapse" : "Expand"} diff for ${file.path}`}
                          >
                          <ChevronRightIcon
                            aria-hidden
                              className={`size-3.5 shrink-0 text-muted-foreground ${open ? "rotate-90" : ""}`}
                          />
                          </CollapsibleTrigger>
                        <PierreEntryIcon
                          pathValue={file.path}
                          kind="file"
                          theme={resolvedTheme}
                          className="size-3.5"
                          />
                          <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left font-mono"
                            onClick={() => onOpenFile(file.path)}
                          >
                            <ReviewPath path={file.path} />
                          </button>
                          {file.note !== undefined && file.note.trim() !== "" ? (
                            <span className="ml-auto min-w-0 truncate text-muted-foreground @max-[30rem]/guide:hidden">
                              <GuideProse text={file.note} plain />
                            </span>
                          ) : null}
                          {stat !== null ? (
                            <PullRequestDiffStat
                              additions={stat.additions}
                              deletions={stat.deletions}
                              className="shrink-0 font-mono"
                            />
                          ) : null}
                          {onSetViewed ? (
                            <div className="flex shrink-0 items-center gap-1.5">
                              <Checkbox
                                id={reviewCheckboxId}
                                aria-label={`Reviewed ${file.path}`}
                                checked={viewed}
                              onCheckedChange={(value) => onSetViewed([file.path], value === true)}
                              />
                              <label
                                htmlFor={reviewCheckboxId}
                                className="cursor-pointer text-muted-foreground"
                              >
                                Viewed
                              </label>
                            </div>
                          ) : null}
                        </div>
                        <CollapsiblePanel animate={false}>
                          {diff !== undefined ? (
                            <GuideFileDiff file={diff} loadDiffFiles={loadDiffFiles} />
                          ) : (
                            <p className="px-3 py-2 text-xs text-muted-foreground">
                              {diffLoading
                                ? "Loading the diff..."
                                : "This file is not in the loaded diff."}
                            </p>
                          )}
                        </CollapsiblePanel>
                      </Collapsible>
                    </li>
                  );
                })}
              </ul>
            </DiffWorkerPoolProvider>
          </section>
        ) : null}

        {stop.questions.length > 0 || onAsk !== null ? (
        <section className="flex flex-col gap-1.5 px-4">
            {stop.questions.length > 0 ? (
              <h3 className="text-xs font-medium text-muted-foreground">Questions to consider</h3>
            ) : null}
            <div className="flex flex-col items-start gap-1.5">
              {stop.questions.map((question) =>
                onAsk === null ? (
                  <div key={question} className="text-sm text-foreground">
                    <GuideProse text={question} />
                  </div>
                ) : (
                // A question is a sentence, so it wraps rather than truncating as a button would.
                  <button
                    key={question}
                    type="button"
                    onClick={() => onAsk(question)}
                    className="flex min-w-0 items-start gap-2 rounded-lg border border-border/60 px-3 py-1.5 text-left text-sm text-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <MessageCircleQuestionIcon
                      aria-hidden
                      className="size-3.5 h-lh shrink-0 text-muted-foreground"
                    />
                    <span className="sr-only">Ask an agent: </span>
                    <span>
                      <GuideProse text={question} plain />
                    </span>
                  </button>
                ),
              )}
              {onAsk !== null ? (
                <Button size="sm" variant="ghost-muted" onClick={() => onAsk("")}>
                  <MessageCircleQuestionIcon aria-hidden />
                  Ask about this chapter
                </Button>
              ) : null}
            </div>
          </section>
        ) : null}

      <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-border/60 p-4">
          {nextTitle !== null ? (
            <Button className="min-w-0" onClick={() => onStep(1)}>
              <span className="min-w-0 truncate">Next: {nextTitle}</span>
              <ArrowRightIcon aria-hidden />
            </Button>
          ) : onFinish !== null ? (
            <Button onClick={onFinish}>
              <MessageSquareIcon aria-hidden />
              Finish review
            </Button>
          ) : null}
        </footer>
      </article>
  );
}
