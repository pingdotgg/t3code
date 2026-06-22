import type { EnvironmentId, GitPullRequestSummary } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  type LucideIcon,
} from "lucide-react";
import { type UIEvent, useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { gitEnvironment } from "~/state/git";
import { useEnvironmentQuery } from "~/state/query";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

type PullRequestVisualState = "open" | "draft" | "merged" | "closed";
type PullRequestStatusFilter = PullRequestVisualState | "all";

function resolvePullRequestVisualState(pr: GitPullRequestSummary): PullRequestVisualState {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.isDraft) return "draft";
  return "open";
}

// GitHub's own PR state icons + colors (open=green, draft=gray, merged=purple,
// closed=red). Light/dark tuned to GitHub's palette.
const PULL_REQUEST_STATE_PRESENTATION: Record<
  PullRequestVisualState,
  { readonly Icon: LucideIcon; readonly colorClass: string; readonly label: string }
> = {
  open: {
    Icon: GitPullRequestIcon,
    colorClass: "text-emerald-600 dark:text-emerald-400",
    label: "Open",
  },
  draft: {
    Icon: GitPullRequestDraftIcon,
    colorClass: "text-zinc-500 dark:text-zinc-400",
    label: "Draft",
  },
  merged: {
    Icon: GitMergeIcon,
    colorClass: "text-violet-600 dark:text-violet-400",
    label: "Merged",
  },
  closed: {
    Icon: GitPullRequestClosedIcon,
    colorClass: "text-red-600 dark:text-red-400",
    label: "Closed",
  },
};

// An open PR whose merge isn't blocked (GitHub `mergeStateStatus === "CLEAN"`,
// surfaced as `isReadyToMerge`) gets a distinct cyan tint to flag "ready to
// merge". Blocked PRs keep the normal open-green.
const PULL_REQUEST_READY_COLOR_CLASS = "text-cyan-600 dark:text-cyan-400";

export function PullRequestStateIcon({
  pr,
  className,
}: {
  pr: GitPullRequestSummary;
  className?: string;
}) {
  const visualState = resolvePullRequestVisualState(pr);
  const { Icon, colorClass } = PULL_REQUEST_STATE_PRESENTATION[visualState];
  const resolvedColorClass =
    visualState === "open" && pr.isReadyToMerge === true
      ? PULL_REQUEST_READY_COLOR_CLASS
      : colorClass;
  return <Icon className={cn(resolvedColorClass, className)} aria-hidden />;
}

const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: PullRequestStatusFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
];

// Shared box styling so the remote/status selects and the filter input share an
// identical height and border treatment. `appearance-none` hides the native
// arrow so we can place our own chevron with precise spacing.
const PICKER_CONTROL_CLASS =
  "h-9 w-full appearance-none rounded-lg border border-input bg-background pl-2 pr-8 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

const PICKER_SELECT_CHEVRON_CLASS =
  "pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground/70";

// Initial batch size + how much each scroll loads, and a hard ceiling so we
// never ask `gh` for an unbounded list.
const PULL_REQUEST_PAGE_SIZE = 100;
const PULL_REQUEST_MAX_LOADED = 1000;

interface PullRequestPickerDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  cwd: string | null;
  projectName: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (pr: GitPullRequestSummary, remote: string) => void;
}

export function PullRequestPickerDialog({
  open,
  environmentId,
  cwd,
  projectName,
  onOpenChange,
  onSelect,
}: PullRequestPickerDialogProps) {
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<PullRequestStatusFilter>("open");
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(PULL_REQUEST_PAGE_SIZE);
  const [loadedPullRequests, setLoadedPullRequests] = useState<readonly GitPullRequestSummary[]>(
    [],
  );
  const [reachedEnd, setReachedEnd] = useState(false);

  const remotesQuery = useEnvironmentQuery(
    open && cwd !== null ? gitEnvironment.listRemotes({ environmentId, input: { cwd } }) : null,
  );
  const remotes = remotesQuery.data?.remotes ?? [];

  // Reset transient state whenever the dialog is closed.
  useEffect(() => {
    if (!open) {
      setSelectedRemote(null);
      setStatusFilter("open");
      setFilter("");
    }
  }, [open]);

  // Default the remote to `origin` (then primary, then first) once loaded.
  useEffect(() => {
    if (selectedRemote !== null || remotes.length === 0) return;
    const preferred =
      remotes.find((remote) => remote.name === "origin") ??
      remotes.find((remote) => remote.isPrimary) ??
      remotes[0];
    if (preferred) {
      setSelectedRemote(preferred.name);
    }
  }, [remotes, selectedRemote]);

  // Reset pagination whenever the active remote changes.
  useEffect(() => {
    setLimit(PULL_REQUEST_PAGE_SIZE);
    setLoadedPullRequests([]);
    setReachedEnd(false);
  }, [selectedRemote]);

  const pullRequestsQuery = useEnvironmentQuery(
    open && cwd !== null && selectedRemote !== null
      ? gitEnvironment.listPullRequests({
          environmentId,
          input: { cwd, remote: selectedRemote, state: "all", limit },
        })
      : null,
  );

  // Retain the latest batch so the list doesn't flash empty while the next
  // (larger-limit) page loads — each fetch is a superset of the previous one.
  useEffect(() => {
    const data = pullRequestsQuery.data?.pullRequests;
    if (data) {
      setLoadedPullRequests(data);
      setReachedEnd(data.length < limit);
    }
  }, [pullRequestsQuery.data, limit]);

  // A pure "#123" / "123" filter targets one specific PR number.
  const numericFilter = useMemo(() => {
    const match = /^#?(\d+)$/.exec(filter.trim());
    return match ? Number(match[1]) : null;
  }, [filter]);
  const loadedMatch =
    numericFilter !== null
      ? (loadedPullRequests.find((pr) => pr.number === numericFilter) ?? null)
      : null;

  // When the typed number isn't in the loaded batch, fetch just that PR —
  // scoped to the selected remote's repository (returns a full summary).
  const fetchByNumber = numericFilter !== null && loadedMatch === null;
  const pullRequestByNumberQuery = useEnvironmentQuery(
    open && cwd !== null && selectedRemote !== null && fetchByNumber
      ? gitEnvironment.listPullRequests({
          environmentId,
          input: { cwd, remote: selectedRemote, number: numericFilter ?? undefined },
        })
      : null,
  );
  const fetchedPullRequest = pullRequestByNumberQuery.data?.pullRequests[0] ?? null;

  const displayedPullRequests = useMemo<readonly GitPullRequestSummary[]>(() => {
    if (numericFilter !== null) {
      if (loadedMatch) return [loadedMatch];
      return fetchedPullRequest ? [fetchedPullRequest] : [];
    }
    const query = filter.trim().toLowerCase();
    return loadedPullRequests.filter((pr) => {
      if (statusFilter !== "all" && resolvePullRequestVisualState(pr) !== statusFilter) {
        return false;
      }
      if (query.length === 0) return true;
      return (
        pr.title.toLowerCase().includes(query) ||
        (pr.author?.toLowerCase().includes(query) ?? false)
      );
    });
  }, [numericFilter, loadedMatch, fetchedPullRequest, filter, statusFilter, loadedPullRequests]);

  const isInitialLoading = pullRequestsQuery.isPending && loadedPullRequests.length === 0;
  const isLoadingMore = pullRequestsQuery.isPending && loadedPullRequests.length > 0;
  const canLoadMore = numericFilter === null && !reachedEnd && limit < PULL_REQUEST_MAX_LOADED;

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!canLoadMore || pullRequestsQuery.isPending) return;
      const element = event.currentTarget;
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 96) {
        setLimit((current) => Math.min(current + PULL_REQUEST_PAGE_SIZE, PULL_REQUEST_MAX_LOADED));
      }
    },
    [canLoadMore, pullRequestsQuery.isPending],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequestIcon className="size-4" />
            Review a pull request
          </DialogTitle>
          <DialogDescription>
            Select a remote, then choose a pull request from {projectName}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="flex items-end gap-2">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Remote</span>
              <div className="relative w-fit">
                <select
                  value={selectedRemote ?? ""}
                  onChange={(event) => setSelectedRemote(event.target.value)}
                  disabled={remotes.length === 0}
                  className={PICKER_CONTROL_CLASS}
                >
                  {remotes.length === 0 ? (
                    <option value="">{remotesQuery.isPending ? "Loading…" : "No remotes"}</option>
                  ) : null}
                  {remotes.map((remote) => (
                    <option key={remote.name} value={remote.name}>
                      {remote.name}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className={PICKER_SELECT_CHEVRON_CLASS} />
              </div>
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Status</span>
              <div className="relative w-fit">
                <select
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as PullRequestStatusFilter)
                  }
                  className={PICKER_CONTROL_CLASS}
                >
                  {STATUS_FILTER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className={PICKER_SELECT_CHEVRON_CLASS} />
              </div>
            </label>
            <label className="grid flex-1 gap-1.5">
              <span className="text-xs font-medium text-foreground">Filter</span>
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter by title, #number, or author"
                className="h-9 items-center"
              />
            </label>
          </div>

          <div
            className="max-h-80 overflow-y-auto rounded-xl border border-border/70"
            onScroll={handleScroll}
          >
            {isInitialLoading ? (
              <div className="flex items-center gap-2 p-3 text-muted-foreground text-xs">
                <Spinner className="size-3.5" />
                Loading pull requests…
              </div>
            ) : fetchByNumber && pullRequestByNumberQuery.isPending ? (
              <div className="flex items-center gap-2 p-3 text-muted-foreground text-xs">
                <Spinner className="size-3.5" />
                Looking up #{numericFilter}…
              </div>
            ) : displayedPullRequests.length === 0 ? (
              <div className="p-3 text-center text-muted-foreground text-xs">
                {numericFilter !== null
                  ? `Pull request #${numericFilter} was not found.`
                  : loadedPullRequests.length === 0
                    ? (pullRequestsQuery.error ?? "No pull requests found for this remote.")
                    : "No pull requests match your filters."}
              </div>
            ) : (
              <>
                <ul className="divide-y divide-border/60">
                  {displayedPullRequests.map((pr) => {
                    const presentation =
                      PULL_REQUEST_STATE_PRESENTATION[resolvePullRequestVisualState(pr)];
                    return (
                      <li key={pr.number}>
                        <button
                          type="button"
                          onClick={() => onSelect(pr, selectedRemote ?? "origin")}
                          className="flex w-full items-start gap-2.5 p-2.5 text-left transition-colors hover:bg-accent"
                        >
                          <PullRequestStateIcon pr={pr} className="mt-0.5 size-4 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-sm">{pr.title}</span>
                            <span className="block truncate text-muted-foreground text-xs">
                              #{pr.number} · {pr.headBranch} → {pr.baseBranch}
                              {pr.author ? ` · ${pr.author}` : ""}
                            </span>
                          </span>
                          <span
                            className={cn(
                              "shrink-0 text-[10px] font-medium uppercase tracking-wide",
                              presentation.colorClass,
                            )}
                          >
                            {presentation.label}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {isLoadingMore ? (
                  <div className="flex items-center justify-center gap-2 p-3 text-muted-foreground text-xs">
                    <Spinner className="size-3.5" />
                    Loading more…
                  </div>
                ) : null}
              </>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
