import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, ListChecksIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import {
  applyAllSweepRecommendations,
  applySweepSettle,
  applySweepTitle,
  dismissSweepItem,
  retrySweepItem,
  startReviewSweep,
  useReviewSweepStore,
  type SweepItem,
} from "../../reviewSweepStore";
import { useProjects } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";

function SweepRecommendationBadge({ item }: { item: SweepItem }) {
  if (item.status === "error") {
    return <Badge variant="error">Review failed</Badge>;
  }
  if (item.status !== "done" || item.result === null) {
    return null;
  }
  if (item.result.recommendSettle) {
    return item.settleApplied ? (
      <Badge variant="outline">Settled</Badge>
    ) : (
      <Badge variant="success">Recommend settle</Badge>
    );
  }
  return <Badge variant="secondary">Keep active</Badge>;
}

function SweepItemCard({ item }: { item: SweepItem }) {
  const key = scopedThreadKey(item.ref);
  const [applyingTitle, setApplyingTitle] = useState(false);
  const [applyingSettle, setApplyingSettle] = useState(false);
  const result = item.result;

  return (
    <Card className="gap-2 p-4">
      <div className="flex items-center gap-2">
        {item.status === "pending" || item.status === "running" ? (
          <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(item.ref)}
          className="truncate text-sm font-medium text-foreground hover:underline"
        >
          {item.threadTitle}
        </Link>
        <SweepRecommendationBadge item={item} />
        <Button
          size="icon-xs"
          variant="ghost"
          className="ms-auto shrink-0 text-muted-foreground"
          aria-label="Dismiss recommendation"
          onClick={() => dismissSweepItem(key)}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      {item.status === "error" ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{item.errorMessage}</span>
          <Button size="xs" variant="outline" onClick={() => retrySweepItem(key)}>
            Retry
          </Button>
        </div>
      ) : null}

      {result !== null ? (
        <p className="text-sm text-muted-foreground">{result.summary}</p>
      ) : item.status !== "error" ? (
        <p className="text-sm text-muted-foreground/60">Reviewing…</p>
      ) : null}

      {result?.suggestedTitle && !item.titleApplied ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
            Title
          </span>
          <span className="text-muted-foreground line-through">{item.threadTitle}</span>
          <ArrowRightIcon className="size-3.5 text-muted-foreground/70" />
          <span className="font-medium text-foreground">{result.suggestedTitle}</span>
          <Button
            size="xs"
            variant="outline"
            className="ms-auto"
            disabled={applyingTitle}
            onClick={() => {
              setApplyingTitle(true);
              void applySweepTitle(key).finally(() => setApplyingTitle(false));
            }}
          >
            Apply title
          </Button>
        </div>
      ) : null}
      {result?.suggestedTitle && item.titleApplied ? (
        <div className="text-sm text-muted-foreground">
          Renamed to <span className="font-medium text-foreground">{result.suggestedTitle}</span>.
        </div>
      ) : null}

      {result?.recommendSettle && !item.settleApplied ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
            Settle
          </span>
          <span className="italic text-muted-foreground">
            {result.settleReason ?? "Work appears concluded."}
          </span>
          <Button
            size="xs"
            variant="outline"
            className="ms-auto"
            disabled={applyingSettle}
            onClick={() => {
              setApplyingSettle(true);
              void applySweepSettle(key).finally(() => setApplyingSettle(false));
            }}
          >
            Settle thread
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

export function ReviewSweepView() {
  const phase = useReviewSweepStore((state) => state.phase);
  const order = useReviewSweepStore((state) => state.order);
  const items = useReviewSweepStore((state) => state.items);
  const truncatedCount = useReviewSweepStore((state) => state.truncatedCount);
  const projects = useProjects();

  const projectTitles = useMemo(() => {
    const titles = new Map<ProjectId, string>();
    for (const project of projects) {
      titles.set(project.id, project.title);
    }
    return titles;
  }, [projects]);

  const visibleItems = useMemo(
    () =>
      order
        .map((key) => items[key])
        .filter((item): item is SweepItem => item !== undefined && !item.dismissed),
    [items, order],
  );
  const groups = useMemo(() => {
    const byProject = new Map<ProjectId, SweepItem[]>();
    for (const item of visibleItems) {
      const group = byProject.get(item.projectId);
      if (group) {
        group.push(item);
      } else {
        byProject.set(item.projectId, [item]);
      }
    }
    return [...byProject.entries()];
  }, [visibleItems]);

  const reviewedCount = visibleItems.filter(
    (item) => item.status === "done" || item.status === "error",
  ).length;
  const applicableCount = visibleItems.filter(
    (item) =>
      (item.result?.suggestedTitle && !item.titleApplied) ||
      (item.result?.recommendSettle && !item.settleApplied),
  ).length;
  const running = phase === "running";
  const [applyingAll, setApplyingAll] = useState(false);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <header
          className={cn(
            "border-b border-border/60 px-3 py-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex min-h-7 items-center gap-3 sm:min-h-6">
            <span className="text-sm font-medium text-foreground">Work review</span>
            {phase !== "idle" ? (
              <span className="text-xs text-muted-foreground">
                {running ? (
                  <>
                    {reviewedCount} of {visibleItems.length} reviewed
                  </>
                ) : (
                  <>{visibleItems.length} threads reviewed</>
                )}
              </span>
            ) : null}
            <div className="ms-auto flex items-center gap-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={running}
                onClick={() => startReviewSweep()}
              >
                <RotateCcwIcon className="mx-1 size-3.5" />
                {phase === "idle" ? "Start review" : "Re-run"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={running || applyingAll || applicableCount === 0}
                onClick={() => {
                  setApplyingAll(true);
                  void applyAllSweepRecommendations().finally(() => setApplyingAll(false));
                }}
              >
                Apply all{applicableCount > 0 ? ` (${applicableCount})` : ""}
              </Button>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
          {visibleItems.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {phase === "idle" ? "Review your in-progress work" : "All caught up"}
                </EmptyTitle>
                <EmptyDescription>
                  {phase === "idle"
                    ? "Run a sweep to summarize every unsettled thread, catch stale titles, and find threads ready to settle."
                    : "No unsettled threads to review right now."}
                </EmptyDescription>
              </EmptyHeader>
              {phase === "idle" ? (
                <Button size="sm" onClick={() => startReviewSweep()}>
                  <ListChecksIcon className="me-1.5 size-4" />
                  Review unsettled work
                </Button>
              ) : null}
            </Empty>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
              {truncatedCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Reviewing the {visibleItems.length} most recent threads; {truncatedCount} more
                  were skipped this run.
                </p>
              ) : null}
              {groups.map(([projectId, groupItems]) => (
                <section key={projectId} className="flex flex-col gap-2">
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                    {projectTitles.get(projectId) ?? "Unknown project"}
                    <span className="ms-2 font-normal normal-case tracking-normal">
                      · {groupItems.length} {groupItems.length === 1 ? "thread" : "threads"}
                    </span>
                  </h2>
                  <div className="flex flex-col gap-2.5">
                    {groupItems.map((item) => (
                      <SweepItemCard key={scopedThreadKey(item.ref)} item={item} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
