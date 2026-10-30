import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import type {
  PullRequestReviewGuideAttention,
  PullRequestReviewGuideStop,
} from "@t3tools/contracts";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  EyeIcon,
  FileIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { getDiffLineStat } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

import { DiffWorkerPoolProvider } from "../../DiffWorkerPoolProvider";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Kbd } from "../../ui/kbd";
import { PullRequestDiffStat } from "../pullRequestPresentation";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { GuideExcerpt, type ExcerptCommenting } from "./GuideExcerpt";
import { GuideFileDiff } from "./GuideFileDiff";
import { GuideNotes } from "./GuideNotes";
import { GuideProse } from "./GuideProse";
import { letterStopNotes } from "@t3tools/client-runtime/review-guide-tour";

const ATTENTION_LABELS = {
  tradeoff: "A tradeoff to weigh",
  contract: "A contract to check",
  product: "A product call",
  risk: "A risk to judge",
  accessibility: "An accessibility call",
} as const satisfies Record<PullRequestReviewGuideAttention["kind"], string>;

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
}: {
  stop: PullRequestReviewGuideStop;
  index: number;
  stopCount: number;
  railOpen: boolean;
  onRailOpenChange: (open: boolean) => void;
  stopList: ReactNode;
  nextTitle: string | null;
  files: ReadonlyMap<string, FileDiffMetadata>;
  loadDiffFiles: FileDiffContentsLoader;
  diffLoading: boolean;
  commenting: ExcerptCommenting | null;
  onStep: (delta: 1 | -1) => void;
  onAsk: ((question: string) => void) | null;
  onFinish: (() => void) | null;
  onOpenFile: (path: string) => void;
}) {
  const { lettered, byExcerpt } = letterStopNotes(stop);
  const excerptPaths = new Set(stop.excerpts.map((excerpt) => excerpt.path));
  const otherFiles = stop.files.filter((file) => !excerptPaths.has(file.path));

  const hasNotes = lettered.length > 0;

  return (
    <div
      className={cn("grid gap-8", hasNotes && "@min-[90rem]/guide:grid-cols-[minmax(0,1fr)_20rem]")}
    >
      <article className="flex min-w-0 flex-col gap-5">
        <Collapsible open={railOpen} onOpenChange={onRailOpenChange}>
          <header className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground tabular-nums @max-[56rem]/guide:hidden">
              Stop {index + 1} of {stopCount}
            </p>
            <CollapsibleTrigger
              render={
                <Button size="xs" variant="ghost-muted" className="@min-[56rem]/guide:hidden" />
              }
            >
              <span className="tabular-nums">
                Stop {index + 1} of {stopCount}
              </span>
              <ChevronDownIcon aria-hidden className={cn(railOpen && "rotate-180")} />
            </CollapsibleTrigger>
            <div className="flex items-center gap-1">
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="Previous stop"
                disabled={index === 0}
                onClick={() => onStep(-1)}
              >
                <ChevronUpIcon aria-hidden />
              </Button>
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="Next stop"
                disabled={index === stopCount - 1}
                onClick={() => onStep(1)}
              >
                <ChevronDownIcon aria-hidden />
              </Button>
              <span
                aria-hidden
                className="ml-1 flex items-center gap-0.5 @max-[30rem]/guide:hidden"
              >
                <Kbd>J</Kbd>
                <Kbd>K</Kbd>
              </span>
            </div>
          </header>
          <CollapsiblePanel className="@min-[56rem]/guide:hidden">
            <div className="pt-3">{stopList}</div>
          </CollapsiblePanel>
        </Collapsible>

        <div className="flex max-w-[60rem] flex-col gap-2">
          <h2 className="text-lg font-semibold text-foreground">{stop.title}</h2>
          {stop.summary.trim() !== "" ? (
            <div className="text-sm text-muted-foreground">
              <GuideProse text={stop.summary} />
            </div>
          ) : null}
        </div>

        {stop.attention !== null ? (
          <Alert controlAlignment="first-line">
            <EyeIcon />
            <AlertTitle>{ATTENTION_LABELS[stop.attention.kind]}</AlertTitle>
            <AlertDescription>
              <div>
                <GuideProse text={stop.attention.note} />
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

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
                />
              ))}
            </DiffWorkerPoolProvider>
          </div>
        ) : null}
        <GuideNotes notes={lettered} className="@min-[90rem]/guide:hidden" />

        {otherFiles.length > 0 ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">
              {stop.excerpts.length > 0 ? "Also in this stop" : "Files in this stop"}
            </h3>
            <DiffWorkerPoolProvider>
              <ul className="flex flex-col overflow-hidden rounded-lg border border-border/60">
                {otherFiles.map((file) => {
                  const diff = files.get(file.path);
                  const stat = diff === undefined ? null : getDiffLineStat([diff]);
                  return (
                    <li key={file.path} className="border-border/60 not-first:border-t">
                      <Collapsible>
                        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                          <ChevronRightIcon
                            aria-hidden
                            className="size-3.5 shrink-0 text-muted-foreground group-data-panel-open:rotate-90"
                          />
                          <FileIcon
                            aria-hidden
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0 truncate font-mono text-foreground">
                            {file.path}
                          </span>
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
                        </CollapsibleTrigger>
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
          <section className="flex flex-col gap-1.5">
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
                  Ask about this stop
                </Button>
              ) : null}
            </div>
          </section>
        ) : null}

        <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-border/60 pt-4">
          {nextTitle !== null ? (
            <Button className="min-w-0 shrink" onClick={() => onStep(1)}>
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
      {hasNotes ? (
        <aside className="hidden @min-[90rem]/guide:block @min-[90rem]/guide:sticky @min-[90rem]/guide:top-4 @min-[90rem]/guide:self-start">
          <GuideNotes notes={lettered} />
        </aside>
      ) : null}
    </div>
  );
}
