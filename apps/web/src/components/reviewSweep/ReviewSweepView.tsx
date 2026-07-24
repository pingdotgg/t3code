import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
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
  isSweepCandidate,
  retrySweepItem,
  sortSweepCandidates,
  startReviewSweep,
  SWEEP_MAX_THREADS,
  useReviewSweepStore,
  type SweepItem,
} from "../../reviewSweepStore";
import { useClientSettings } from "../../hooks/useSettings";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
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

/** Cost-transparency threshold: at or above this many candidate threads the
    pre-run screen calls out that the sweep may be slow/expensive. */
const SWEEP_COST_NOTE_THRESHOLD = 15;

/** Pre-run summary: how many threads a sweep would cover and which model
    each environment's server will use, so starting is an informed choice. */
function SweepPreRunSummary() {
  const shells = useThreadShells();
  const serverConfigs = useServerConfigs();
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);

  const { candidateCount, reviewedCount, modelsByEnvironment } = useMemo(() => {
    const now = new Date().toISOString();
    const candidates = sortSweepCandidates(
      shells.filter((shell) =>
        isSweepCandidate(shell, serverConfigs.get(shell.environmentId)?.environment.capabilities, {
          now,
          autoSettleAfterDays,
        }),
      ),
    );
    // Aggregate only what a run would actually review: the cap is applied
    // here, in the same most-recently-active order startReviewSweep uses,
    // so the environment/model rows never overstate the calls.
    const reviewed = candidates.slice(0, SWEEP_MAX_THREADS);
    const models = new Map<
      string,
      { environmentId: string; label: string; model: string; threads: number }
    >();
    for (const shell of reviewed) {
      const config = serverConfigs.get(shell.environmentId);
      const entry = models.get(shell.environmentId);
      if (entry) {
        entry.threads += 1;
      } else {
        const selection = config?.settings.textGenerationModelSelection;
        models.set(shell.environmentId, {
          environmentId: shell.environmentId,
          label: config?.environment.label ?? shell.environmentId,
          model: selection ? `${selection.model}` : "server default",
          threads: 1,
        });
      }
    }
    return {
      candidateCount: candidates.length,
      reviewedCount: reviewed.length,
      modelsByEnvironment: [...models.values()],
    };
  }, [autoSettleAfterDays, serverConfigs, shells]);

  if (candidateCount === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>All caught up</EmptyTitle>
          <EmptyDescription>No unsettled threads to review right now.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Review your in-progress work</EmptyTitle>
        <EmptyDescription>
          This sweep runs one AI review per thread to summarize it, catch stale titles, and find
          threads ready to settle. Nothing is applied without your click.
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex w-full max-w-md flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">{reviewedCount}</span>{" "}
          {reviewedCount === 1 ? "thread" : "threads"} will be reviewed
          {candidateCount > SWEEP_MAX_THREADS
            ? ` (${candidateCount - SWEEP_MAX_THREADS} least-recently-active skipped)`
            : ""}
        </div>
        {modelsByEnvironment.map((entry) => (
          <div key={entry.environmentId} className="truncate">
            {entry.label}: <span className="text-foreground">{entry.model}</span> · {entry.threads}{" "}
            {entry.threads === 1 ? "thread" : "threads"}
          </div>
        ))}
        {reviewedCount >= SWEEP_COST_NOTE_THRESHOLD ? (
          <div className="text-warning-foreground">
            Heads up: {reviewedCount} model calls may take a few minutes and use noticeable credits.
            You can change the model under Settings → Models.
          </div>
        ) : (
          <div>Model is configurable under Settings → Models (text generation).</div>
        )}
      </div>
      <Button size="sm" onClick={() => startReviewSweep()}>
        <ListChecksIcon className="me-1.5 size-4" />
        Review {reviewedCount} {reviewedCount === 1 ? "thread" : "threads"}
      </Button>
    </Empty>
  );
}

export function ReviewSweepView() {
  const phase = useReviewSweepStore((state) => state.phase);
  const order = useReviewSweepStore((state) => state.order);
  const items = useReviewSweepStore((state) => state.items);
  const truncatedCount = useReviewSweepStore((state) => state.truncatedCount);
  const projects = useProjects();

  // Projects are only unique per (environmentId, projectId) — ids can
  // collide across connected environments.
  const projectTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const project of projects) {
      titles.set(
        scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
        project.title,
      );
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
    const byProject = new Map<string, SweepItem[]>();
    for (const item of visibleItems) {
      const key = scopedProjectKey(scopeProjectRef(item.ref.environmentId, item.projectId));
      const group = byProject.get(key);
      if (group) {
        group.push(item);
      } else {
        byProject.set(key, [item]);
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
            {phase !== "idle" ? (
              <div className="ms-auto flex items-center gap-2">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={running}
                  onClick={() => startReviewSweep()}
                >
                  <RotateCcwIcon className="mx-1 size-3.5" />
                  Re-run
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
            ) : null}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
          {phase === "idle" ? (
            <SweepPreRunSummary />
          ) : visibleItems.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>All caught up</EmptyTitle>
                <EmptyDescription>No unsettled threads to review right now.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
              {truncatedCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Reviewing the {visibleItems.length} most recent threads; {truncatedCount} more
                  were skipped this run.
                </p>
              ) : null}
              {groups.map(([projectKey, groupItems]) => (
                <section key={projectKey} className="flex flex-col gap-2">
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
                    {projectTitles.get(projectKey) ?? "Unknown project"}
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
