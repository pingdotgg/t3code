import type { ProjectId, PullRequestInvolvement, PullRequestListState } from "@t3tools/contracts";
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GitPullRequestIcon, LoaderCircleIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useDeferredValue, useEffect, useMemo } from "react";

import { PullRequestDetailPanel } from "../components/pullRequest/PullRequestDetailPanel";
import { PullRequestRow } from "../components/pullRequest/PullRequestRow";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import {
  pullRequestInvalidateMutationOptions,
  pullRequestListInfiniteQueryOptions,
  pullRequestListStatsQueryOptions,
} from "../lib/pullRequestReactQuery";
import { findGitHubPullRequestProject } from "../lib/openPullRequestLink";
import { cn } from "../lib/utils";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import type { Project } from "../types";

export interface PullRequestsSearch {
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly projectId?: ProjectId;
  readonly q?: string;
  readonly host?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly selectedProjectId?: ProjectId;
}
type PullRequestsSearchPatch = {
  readonly [Key in keyof PullRequestsSearch]?: PullRequestsSearch[Key] | undefined;
};

const LIST_STATES = ["all", "open", "closed", "merged"] as const;
const INVOLVEMENTS = ["all", "reviewing", "authored"] as const;
const PAGE_SIZE = 50;
const STATS_BATCH_SIZE = 500;
const EMPTY_PROJECTS: readonly Project[] = [];

function isListState(value: unknown): value is PullRequestListState {
  return typeof value === "string" && (LIST_STATES as readonly string[]).includes(value);
}

function isInvolvement(value: unknown): value is PullRequestInvolvement {
  return typeof value === "string" && (INVOLVEMENTS as readonly string[]).includes(value);
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (search: Record<string, unknown>): PullRequestsSearch => ({
    state: isListState(search.state) ? search.state : "open",
    involvement: isInvolvement(search.involvement) ? search.involvement : "all",
    ...(typeof search.projectId === "string" && search.projectId
      ? { projectId: search.projectId as ProjectId }
      : {}),
    ...(typeof search.q === "string" && search.q.trim() ? { q: search.q.slice(0, 200) } : {}),
    ...(typeof search.host === "string" && search.host ? { host: search.host.slice(0, 300) } : {}),
    ...(typeof search.repository === "string" && search.repository
      ? { repository: search.repository.slice(0, 300) }
      : {}),
    ...(typeof search.number === "number" &&
    Number.isSafeInteger(search.number) &&
    search.number > 0
      ? { number: search.number }
      : {}),
    ...(typeof search.selectedProjectId === "string" && search.selectedProjectId
      ? { selectedProjectId: search.selectedProjectId as ProjectId }
      : {}),
  }),
  component: PullRequestsRoute,
});

function PullRequestsRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const environmentId = usePrimaryEnvironmentId();
  const descriptor = usePrimaryEnvironmentDescriptor();
  const queryClient = useQueryClient();
  const allProjects = useStore(selectProjectsAcrossEnvironments);
  const projects = useMemo(
    () =>
      environmentId
        ? allProjects.filter((project) => project.environmentId === environmentId)
        : EMPTY_PROJECTS,
    [allProjects, environmentId],
  );
  const supported = descriptor?.capabilities.pullRequests === true;
  const deferredQuery = useDeferredValue(search.q ?? "");
  const listQuery = useInfiniteQuery(
    pullRequestListInfiniteQueryOptions({
      environmentId: supported ? environmentId : null,
      request: {
        state: search.state,
        involvement: search.involvement,
        limit: PAGE_SIZE,
        ...(search.projectId ? { projectId: search.projectId } : {}),
        ...(deferredQuery.trim() ? { query: deferredQuery.trim() } : {}),
      },
    }),
  );
  const entries = useMemo(
    () => listQuery.data?.pages.flatMap((page) => page.entries) ?? [],
    [listQuery.data?.pages],
  );
  const statReferenceBatches = useMemo(
    () =>
      Array.from({ length: Math.ceil(entries.length / STATS_BATCH_SIZE) }, (_, index) =>
        entries
          .slice(index * STATS_BATCH_SIZE, (index + 1) * STATS_BATCH_SIZE)
          .map(({ projectId, repository, number }) => ({ projectId, repository, number })),
      ),
    [entries],
  );
  const statsQueries = useQueries({
    queries: statReferenceBatches.map((refs) =>
      pullRequestListStatsQueryOptions({
        environmentId: supported ? environmentId : null,
        request: { refs },
      }),
    ),
  });
  const invalidateMutation = useMutation(
    pullRequestInvalidateMutationOptions({
      environmentId: supported ? environmentId : null,
      queryClient,
    }),
  );
  const entriesWithStats = useMemo(() => {
    const stats = new Map(
      statsQueries.flatMap((query) =>
        (query.data?.stats ?? []).map((stat) => [
          `${stat.projectId}:${stat.repository}#${stat.number}`,
          stat,
        ]),
      ),
    );
    return entries.map((entry) => {
      const stat = stats.get(`${entry.projectId}:${entry.repository}#${entry.number}`);
      return stat && entry.additions === 0 && entry.deletions === 0 ? { ...entry, ...stat } : entry;
    });
  }, [entries, statsQueries]);
  const explicitSelection = useMemo(
    () =>
      search.repository && search.number && search.selectedProjectId
        ? {
            projectId: search.selectedProjectId,
            repository: search.repository,
            number: search.number,
          }
        : null,
    [search.number, search.repository, search.selectedProjectId],
  );
  const inferredSelection = useMemo(() => {
    const repository = search.repository;
    const number = search.number;
    if (explicitSelection || !repository || !number) {
      return null;
    }
    const project = findGitHubPullRequestProject(projects, {
      environmentId,
      host: search.host,
      repository,
    });
    return project ? { projectId: project.id, repository, number } : null;
  }, [environmentId, explicitSelection, projects, search.host, search.number, search.repository]);
  const selected = explicitSelection ?? inferredSelection;
  const updateSearch = (patch: PullRequestsSearchPatch, clearSelection = false) => {
    void navigate({
      search: (previous: PullRequestsSearch) => {
        const next = { ...previous, ...patch };
        return {
          state: next.state ?? "open",
          involvement: next.involvement ?? "all",
          ...(next.projectId ? { projectId: next.projectId } : {}),
          ...(next.q ? { q: next.q } : {}),
          ...(!clearSelection && next.repository && next.number && next.selectedProjectId
            ? {
                ...(next.host ? { host: next.host } : {}),
                repository: next.repository,
                number: next.number,
                selectedProjectId: next.selectedProjectId,
              }
            : {}),
        };
      },
      replace: true,
    });
  };
  useEffect(() => {
    if (!inferredSelection || search.selectedProjectId) return;
    void navigate({
      search: (previous: PullRequestsSearch) => ({
        ...previous,
        repository: inferredSelection.repository,
        number: inferredSelection.number,
        selectedProjectId: inferredSelection.projectId,
      }),
      replace: true,
    });
  }, [inferredSelection, navigate, search.selectedProjectId]);
  const errors = listQuery.data?.pages.flatMap((page) => page.errors) ?? [];

  if (!descriptor) {
    return (
      <Surface>
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" /> Loading environment…
        </div>
      </Surface>
    );
  }

  if (!supported) {
    return (
      <Surface>
        <EmptyState
          title="Pull requests are unavailable"
          description="This environment does not advertise GitHub pull request support."
        />
      </Surface>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <SidebarTrigger className="size-7" />
          <GitPullRequestIcon className="size-4" />
          <h1 className="text-sm font-semibold">Pull Requests</h1>
          <Button
            aria-label="Refresh pull requests"
            className="ml-auto"
            disabled={listQuery.isFetching || invalidateMutation.isPending}
            size="icon-xs"
            variant="ghost"
            onClick={() => void invalidateMutation.mutateAsync({})}
          >
            <RefreshCwIcon
              className={cn(
                "size-3.5",
                (listQuery.isFetching || invalidateMutation.isPending) && "animate-spin",
              )}
            />
          </Button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(22rem,0.9fr)_minmax(28rem,1.1fr)]">
          <section className="flex min-h-0 flex-col border-r border-border">
            <div className="space-y-2 border-b border-border p-3">
              <label className="relative block">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  aria-label="Search pull requests"
                  className="h-8 w-full rounded border border-input bg-background py-1 pr-2 pl-8 text-sm"
                  placeholder="Search pull requests"
                  value={search.q ?? ""}
                  onChange={(event) =>
                    updateSearch({ q: event.currentTarget.value || undefined }, true)
                  }
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label="Pull request state"
                  className="h-8 rounded border border-input bg-background px-2 text-xs"
                  value={search.state}
                  onChange={(event) =>
                    updateSearch({ state: event.currentTarget.value as PullRequestListState }, true)
                  }
                >
                  {LIST_STATES.map((state) => (
                    <option key={state} value={state}>
                      {state}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Pull request involvement"
                  className="h-8 rounded border border-input bg-background px-2 text-xs"
                  value={search.involvement}
                  onChange={(event) =>
                    updateSearch(
                      { involvement: event.currentTarget.value as PullRequestInvolvement },
                      true,
                    )
                  }
                >
                  {INVOLVEMENTS.map((involvement) => (
                    <option key={involvement} value={involvement}>
                      {involvement}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Pull request project"
                  className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs"
                  value={search.projectId ?? ""}
                  onChange={(event) =>
                    updateSearch(
                      {
                        projectId: (event.currentTarget.value || undefined) as
                          | ProjectId
                          | undefined,
                      },
                      true,
                    )
                  }
                >
                  <option value="">All projects</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {listQuery.isPending ? (
                <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                  <LoaderCircleIcon className="size-4 animate-spin" /> Loading pull requests…
                </div>
              ) : null}
              {listQuery.error ? (
                <EmptyState
                  title="Could not load pull requests"
                  description={
                    listQuery.error instanceof Error ? listQuery.error.message : "Please try again."
                  }
                  action={
                    <Button size="sm" variant="outline" onClick={() => void listQuery.refetch()}>
                      Retry
                    </Button>
                  }
                />
              ) : null}
              {!listQuery.isPending && !listQuery.error && entriesWithStats.length === 0 ? (
                <EmptyState
                  title="No pull requests"
                  description={
                    search.q
                      ? "Nothing matches this search."
                      : "No pull requests match these filters."
                  }
                  action={
                    search.q ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => updateSearch({ q: undefined }, true)}
                      >
                        Clear search
                      </Button>
                    ) : undefined
                  }
                />
              ) : null}
              {entriesWithStats.map((entry) => (
                <PullRequestRow
                  entry={entry}
                  key={`${entry.projectId}:${entry.repository}#${entry.number}`}
                  selected={
                    selected?.projectId === entry.projectId &&
                    selected.repository === entry.repository &&
                    selected.number === entry.number
                  }
                  onSelect={(next) =>
                    updateSearch({
                      repository: next.repository,
                      number: next.number,
                      selectedProjectId: next.projectId,
                    })
                  }
                />
              ))}
              {listQuery.hasNextPage ? (
                <div className="flex justify-center p-3">
                  <Button
                    disabled={listQuery.isFetchingNextPage}
                    size="sm"
                    variant="outline"
                    onClick={() => void listQuery.fetchNextPage()}
                  >
                    {listQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
              {errors.length > 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  {errors.map((error) => `${error.projectTitle}: ${error.message}`).join(" · ")}
                </p>
              ) : null}
            </div>
          </section>
          <section className="min-h-0">
            {selected ? (
              <PullRequestDetailPanel
                environmentId={environmentId!}
                key={`${selected.projectId}:${selected.repository}#${selected.number}`}
                reference={selected}
                onClose={() => updateSearch({}, true)}
              />
            ) : (
              <EmptyState
                title="Select a pull request"
                description="Choose a pull request to review its details, conversation, and diff."
              />
            )}
          </section>
        </div>
      </div>
    </SidebarInset>
  );
}

function Surface({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 bg-background text-foreground">{children}</SidebarInset>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 p-6 text-center">
      <GitPullRequestIcon className="size-7 text-muted-foreground" />
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}
