import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  ListChecksIcon,
  LoaderIcon,
  PencilLineIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { useClientSettings } from "../../hooks/useSettings";
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
import {
  readThreadShell,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";

// ---------------------------------------------------------------------------
// Triage buckets: ordered by "how fast can you clear this" — one-click
// settles first, quick title fixes second, then threads that need real
// reading, then no-action-possible tails.
// ---------------------------------------------------------------------------

type SweepBucket = "settle" | "title" | "attention" | "inFlight" | "failed" | "reviewing";

const BUCKET_ORDER: readonly SweepBucket[] = [
  "settle",
  "title",
  "attention",
  "inFlight",
  "failed",
  "reviewing",
];

const BUCKET_META: Record<
  SweepBucket,
  { title: string; hint: string; accent: string; icon: typeof ArchiveIcon }
> = {
  settle: {
    title: "Ready to settle",
    hint: "Work concluded — one click clears each from your active list.",
    accent: "border-s-emerald-500/70",
    icon: ArchiveIcon,
  },
  title: {
    title: "Title fixes",
    hint: "Still in progress, but the name no longer matches the work.",
    accent: "border-s-sky-500/70",
    icon: PencilLineIcon,
  },
  attention: {
    title: "Needs your attention",
    hint: "Waiting on you — review, input, or a decision.",
    accent: "border-s-amber-500/70",
    icon: CircleAlertIcon,
  },
  inFlight: {
    title: "In flight",
    hint: "Agents are still working; nothing to do yet.",
    accent: "border-s-border",
    icon: LoaderIcon,
  },
  failed: {
    title: "Review failed",
    hint: "The reviewer couldn't process these — retry or open them directly.",
    accent: "border-s-red-500/70",
    icon: CircleAlertIcon,
  },
  reviewing: {
    title: "Still reviewing",
    hint: "",
    accent: "border-s-border",
    icon: LoaderIcon,
  },
};

function classifySweepItem(item: SweepItem): SweepBucket {
  if (item.status === "error") return "failed";
  if (item.status !== "done" || item.result === null) return "reviewing";
  if (item.result.recommendSettle && !item.settleApplied) return "settle";
  if (item.result.suggestedTitle && !item.titleApplied) return "title";
  // Live shell wins over review-time knowledge: a thread blocked on the user
  // right now belongs in "attention" even if the review predates the block.
  const shell = readThreadShell(item.ref);
  const working = shell?.session?.status === "running" || shell?.session?.status === "starting";
  const blocked = shell?.hasPendingApprovals === true || shell?.hasPendingUserInput === true;
  if (blocked) return "attention";
  if (working) return "inFlight";
  return "attention";
}

function DiffStatsLabel({ item }: { item: SweepItem }) {
  const stats = item.result?.diffStats;
  if (!stats || stats.files === 0) return null;
  return (
    <span className="flex items-center gap-1 font-mono text-[11px]">
      <span className="text-emerald-500">+{stats.additions}</span>
      <span className="text-red-400">−{stats.deletions}</span>
      <span className="text-muted-foreground/70">
        · {stats.files} {stats.files === 1 ? "file" : "files"}
      </span>
    </span>
  );
}

function SweepItemMetaRow({
  item,
  projectTitle,
  workspaceRoot,
}: {
  item: SweepItem;
  projectTitle: string;
  workspaceRoot: string | null;
}) {
  const age = formatRelativeTimeLabel(item.lastActivityAt);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5">
        {workspaceRoot ? (
          <ProjectFavicon
            environmentId={item.ref.environmentId}
            cwd={workspaceRoot}
            className="size-3.5 shrink-0"
          />
        ) : null}
        <span className="truncate">{projectTitle}</span>
      </span>
      {item.branch ? (
        <span className="max-w-56 truncate font-mono text-[11px] text-muted-foreground/80">
          {item.branch}
        </span>
      ) : null}
      {age ? <span className="shrink-0">{age}</span> : null}
      <DiffStatsLabel item={item} />
    </div>
  );
}

function SweepItemCard({
  item,
  bucket,
  projectTitle,
  workspaceRoot,
}: {
  item: SweepItem;
  bucket: SweepBucket;
  projectTitle: string;
  workspaceRoot: string | null;
}) {
  const key = scopedThreadKey(item.ref);
  const [applying, setApplying] = useState(false);
  const result = item.result;
  const meta = BUCKET_META[bucket];

  const primaryAction =
    bucket === "settle" ? (
      <Button
        size="xs"
        variant="outline"
        className="shrink-0"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          void applySweepSettle(key).finally(() => setApplying(false));
        }}
      >
        <ArchiveIcon className="me-1 size-3.5" />
        Settle
      </Button>
    ) : bucket === "title" ? (
      <Button
        size="xs"
        variant="outline"
        className="shrink-0"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          void applySweepTitle(key).finally(() => setApplying(false));
        }}
      >
        Apply title
      </Button>
    ) : bucket === "failed" ? (
      <Button size="xs" variant="outline" className="shrink-0" onClick={() => retrySweepItem(key)}>
        Retry
      </Button>
    ) : null;

  return (
    <Card className={cn("gap-1.5 border-s-2 p-3", meta.accent)}>
      <div className="flex items-center gap-2">
        {item.status === "pending" || item.status === "running" ? (
          <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(item.ref)}
          className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
        >
          {item.threadTitle}
        </Link>
        {bucket === "settle" && item.settleApplied ? (
          <Badge variant="outline">Settled</Badge>
        ) : null}
        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          {primaryAction}
          <Button
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground"
            aria-label="Dismiss recommendation"
            onClick={() => dismissSweepItem(key)}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <SweepItemMetaRow item={item} projectTitle={projectTitle} workspaceRoot={workspaceRoot} />

      {item.status === "error" ? (
        <p className="text-sm text-red-400/90">{item.errorMessage}</p>
      ) : result !== null ? (
        <p className="text-sm text-muted-foreground">{result.summary}</p>
      ) : (
        <p className="text-sm text-muted-foreground/60">Reviewing…</p>
      )}

      {bucket === "settle" && result?.settleReason ? (
        <p className="text-xs italic text-muted-foreground/80">{result.settleReason}</p>
      ) : null}

      {bucket === "title" && result?.suggestedTitle ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground/70 line-through">{item.threadTitle}</span>
          <ArrowRightIcon className="size-3.5 text-muted-foreground/70" />
          <span className="font-medium text-foreground">{result.suggestedTitle}</span>
        </div>
      ) : null}
      {result?.suggestedTitle && item.titleApplied ? (
        <p className="text-xs text-muted-foreground">
          Renamed to <span className="font-medium text-foreground">{result.suggestedTitle}</span>.
        </p>
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
  // Recompute when the sidebar publishes fresh PR states — merged-PR
  // auto-settle changes which threads count as unsettled.
  const candidateVersion = useReviewSweepStore((state) => state.candidateVersion);

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
  }, [autoSettleAfterDays, candidateVersion, serverConfigs, shells]);

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
  const projectsByKey = useMemo(() => {
    const byKey = new Map<string, { title: string; workspaceRoot: string }>();
    for (const project of projects) {
      byKey.set(scopedProjectKey(scopeProjectRef(project.environmentId, project.id)), {
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      });
    }
    return byKey;
  }, [projects]);

  const visibleItems = useMemo(
    () =>
      order
        .map((key) => items[key])
        .filter((item): item is SweepItem => item !== undefined && !item.dismissed),
    [items, order],
  );

  const buckets = useMemo(() => {
    const grouped = new Map<SweepBucket, SweepItem[]>();
    for (const item of visibleItems) {
      const bucket = classifySweepItem(item);
      const group = grouped.get(bucket);
      if (group) {
        group.push(item);
      } else {
        grouped.set(bucket, [item]);
      }
    }
    // Within a bucket, smallest diff first — clear the easy ones, build
    // momentum. Unknown diff sizes sink to the bottom.
    for (const group of grouped.values()) {
      group.sort((a, b) => {
        const sizeOf = (item: SweepItem) => {
          const stats = item.result?.diffStats;
          return stats ? stats.additions + stats.deletions : Number.MAX_SAFE_INTEGER;
        };
        return sizeOf(a) - sizeOf(b);
      });
    }
    return BUCKET_ORDER.flatMap((bucket) => {
      const group = grouped.get(bucket);
      return group && group.length > 0 ? [[bucket, group] as const] : [];
    });
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
              {buckets.map(([bucket, bucketItems]) => {
                const meta = BUCKET_META[bucket];
                const BucketIcon = meta.icon;
                return (
                  <section key={bucket} className="flex flex-col gap-2">
                    <div className="flex items-baseline gap-2">
                      <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground/80">
                        <BucketIcon className="size-3.5" />
                        {meta.title}
                        <span className="font-normal text-muted-foreground">
                          · {bucketItems.length}
                        </span>
                      </h2>
                      {meta.hint ? (
                        <span className="truncate text-xs text-muted-foreground/70">
                          {meta.hint}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-col gap-2">
                      {bucketItems.map((item) => {
                        const projectKey = scopedProjectKey(
                          scopeProjectRef(item.ref.environmentId, item.projectId),
                        );
                        const project = projectsByKey.get(projectKey);
                        return (
                          <SweepItemCard
                            key={scopedThreadKey(item.ref)}
                            item={item}
                            bucket={bucket}
                            projectTitle={project?.title ?? "Unknown project"}
                            workspaceRoot={project?.workspaceRoot ?? null}
                          />
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
