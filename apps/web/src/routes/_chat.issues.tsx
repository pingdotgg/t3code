import type { GitHubIssueListEntry, GitHubIssueListState, ProjectId } from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CircleDotIcon, CircleSlash2Icon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import {
  GitHubIssueDetailContent,
  GitHubIssueEmptyState,
} from "../components/githubIssue/GitHubIssueDetailPanel";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { githubIssueEnvironment } from "../state/githubIssues";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../state/entities";
import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { formatRelativeTimeLabel } from "../timestampFormat";

/** "Every project" wears the one value no project id can be. */
const ALL_PROJECTS_VALUE = "";

const STATE_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const satisfies ReadonlyArray<{ value: GitHubIssueListState; label: string }>;

export interface IssuesSearch {
  readonly state: GitHubIssueListState;
  readonly projectId?: ProjectId;
  readonly selectedProjectId?: ProjectId;
  readonly repository?: string;
  readonly number?: number;
  readonly q?: string;
}

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: (raw: Record<string, unknown>): IssuesSearch => ({
    state: raw.state === "all" || raw.state === "closed" ? raw.state : "open",
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...(typeof raw.selectedProjectId === "string" && raw.selectedProjectId
      ? { selectedProjectId: raw.selectedProjectId as ProjectId }
      : {}),
    ...(typeof raw.repository === "string" && raw.repository
      ? { repository: raw.repository.slice(0, 200) }
      : {}),
    ...(typeof raw.number === "number" && Number.isSafeInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.q === "string" && raw.q ? { q: raw.q.slice(0, 200) } : {}),
  }),
  component: GitHubIssuesRoute,
});

function GitHubIssuesRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const capabilityKnown = primaryEnvironment !== null && primaryEnvironment.serverConfig !== null;
  const supported =
    primaryEnvironment?.serverConfig?.environment.capabilities.githubIssues === true;
  const projects = useProjects();
  // An unread shell has no projects yet, which is not the same answer as having none.
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  const githubProjects = useMemo(
    () =>
      projects
        .filter(
          (project) =>
            project.environmentId === environmentId &&
            project.repositoryIdentity?.provider === "github",
        )
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [environmentId, projects],
  );
  // Kept until the projects are known: dropping it early would fetch the whole workspace once
  // and then narrow, which reads as the filter forgetting itself.
  const scopedProjectId =
    !projectsKnown || githubProjects.some((project) => project.id === search.projectId)
      ? search.projectId
      : undefined;
  const [sentQuery] = useDebouncedValue(search.q?.trim() ?? "", { wait: 250 });
  const listQuery = useEnvironmentQuery(
    supported && environmentId
      ? githubIssueEnvironment.list({
          environmentId,
          input: {
            state: search.state,
            limit: 50,
            ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
            ...(sentQuery ? { query: sentQuery } : {}),
          },
        })
      : null,
  );
  const selectedRef =
    search.selectedProjectId && search.repository && search.number
      ? {
          projectId: search.selectedProjectId,
          repository: search.repository,
          number: search.number,
        }
      : null;
  const detailQuery = useEnvironmentQuery(
    supported && environmentId && selectedRef
      ? githubIssueEnvironment.detail({ environmentId, input: selectedRef })
      : null,
  );
  const selectIssue = useCallback(
    (issue: GitHubIssueListEntry) => {
      void navigate({
        search: (current) => ({
          ...current,
          selectedProjectId: issue.projectId,
          repository: issue.repository,
          number: issue.number,
        }),
      });
    },
    [navigate],
  );

  const stateLabel = STATE_OPTIONS.find((option) => option.value === search.state)?.label ?? "Open";
  const projectLabel =
    githubProjects.find((project) => project.id === scopedProjectId)?.title ?? "All projects";

  const updateFilters = (patch: {
    state?: GitHubIssueListState;
    projectId?: ProjectId | undefined;
    q?: string | undefined;
  }) => {
    void navigate({
      search: (current) => {
        const {
          repository: _repository,
          number: _number,
          selectedProjectId: _selectedProjectId,
          projectId: currentProjectId,
          q: currentQuery,
          ...base
        } = current;
        const projectId = "projectId" in patch ? patch.projectId : currentProjectId;
        const q = "q" in patch ? patch.q : currentQuery;
        return {
          ...base,
          ...(patch.state ? { state: patch.state } : {}),
          ...(projectId ? { projectId } : {}),
          ...(q ? { q } : {}),
        };
      },
    });
  };

  const body = !capabilityKnown ? (
    <div className="flex flex-1 items-center justify-center gap-2 py-12 text-muted-foreground text-sm">
      <Spinner className="size-4" /> Connecting to the environment...
    </div>
  ) : !supported ? (
    <GitHubIssueEmptyState
      title="GitHub issues unavailable"
      description="Update this environment's T3 Code server to browse GitHub issues."
    />
  ) : projectsKnown && githubProjects.length === 0 ? (
    <GitHubIssueEmptyState
      title="No GitHub projects"
      description="Add a project backed by a GitHub repository and its issues will appear here."
    />
  ) : listQuery.isPending && listQuery.data === null ? (
    <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
      <Spinner className="size-4" /> Loading issues...
    </div>
  ) : listQuery.error && listQuery.data === null ? (
    <GitHubIssueEmptyState
      title="Could not load issues"
      description={listQuery.error}
      action={<Button onClick={listQuery.refresh}>Try again</Button>}
    />
  ) : listQuery.data?.entries.length === 0 && listQuery.data.errors.length > 0 ? (
    <GitHubIssueEmptyState
      title="Could not load issues"
      description={listQuery.data.errors[0]?.message ?? "GitHub did not answer."}
      action={<Button onClick={listQuery.refresh}>Try again</Button>}
    />
  ) : listQuery.data?.entries.length === 0 ? (
    <GitHubIssueEmptyState
      title="No issues"
      description={search.q ? "Nothing matched this search." : "No issues matched these filters."}
    />
  ) : (
    <div className="divide-y divide-border/60">
      {listQuery.data?.entries.map((issue) => (
        <IssueRow
          key={`${issue.projectId}:${issue.repository}:${issue.number}`}
          issue={issue}
          selected={
            selectedRef?.projectId === issue.projectId &&
            selectedRef.repository === issue.repository &&
            selectedRef.number === issue.number
          }
          showProject={scopedProjectId === undefined}
          onSelect={selectIssue}
        />
      ))}
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="GitHub issues breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">GitHub Issues</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh GitHub issues"
            onClick={() => {
              listQuery.refresh();
              detailQuery.refresh();
            }}
          >
            <RefreshCwIcon className={cn("size-4", listQuery.isPending && "animate-spin")} />
          </Button>
        </WorkspacePageHeader>

        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(20rem,0.9fr)_minmax(24rem,1.1fr)]">
          <section className="flex min-h-0 min-w-0 flex-col border-r border-border">
            <div className="grid gap-2 border-b border-border/70 p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <InputGroup className="min-w-0">
                <InputGroupAddon>
                  <SearchIcon aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  aria-label="Search GitHub issues"
                  placeholder="Search issues"
                  value={search.q ?? ""}
                  onChange={(event) => updateFilters({ q: event.currentTarget.value || undefined })}
                />
              </InputGroup>
              <Select
                value={search.state}
                onValueChange={(value: string | null) => {
                  const next = STATE_OPTIONS.find((option) => option.value === value);
                  if (next) updateFilters({ state: next.value });
                }}
              >
                <SelectTrigger
                  aria-label="Filter GitHub issues by state"
                  className="min-w-28 sm:w-auto"
                >
                  <SelectValue>{stateLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {STATE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Select
                value={scopedProjectId ?? ALL_PROJECTS_VALUE}
                onValueChange={(value: string | null) =>
                  updateFilters({ projectId: value ? (value as ProjectId) : undefined })
                }
              >
                <SelectTrigger
                  aria-label="Filter GitHub issues by project"
                  className="min-w-32 sm:w-auto"
                >
                  <SelectValue>{projectLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={ALL_PROJECTS_VALUE}>All projects</SelectItem>
                  {githubProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {listQuery.data &&
              listQuery.data.entries.length > 0 &&
              listQuery.data.errors.length > 0 ? (
                <div className="border-b border-warning/25 bg-warning/8 px-4 py-2 text-warning-foreground text-xs">
                  {listQuery.data.errors.length} GitHub-backed project
                  {listQuery.data.errors.length === 1 ? " was" : "s were"} unavailable.
                </div>
              ) : null}
              {listQuery.data?.truncated ? (
                <div className="border-b border-border/60 px-4 py-2 text-muted-foreground text-xs">
                  Showing the newest 50 issues. Narrow the list with search or filters.
                </div>
              ) : null}
              {body}
            </div>
          </section>

          <section className="hidden min-h-0 min-w-0 overflow-y-auto md:block">
            <GitHubIssueDetailContent
              environmentId={environmentId}
              detail={detailQuery.data}
              error={detailQuery.error}
              loading={detailQuery.isPending}
              onRetry={detailQuery.refresh}
            />
          </section>
        </div>
      </div>

      {selectedRef ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-background md:hidden">
          <div className="sticky top-0 z-10 flex h-12 items-center border-b border-border bg-background/95 px-3 backdrop-blur">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void navigate({
                  search: (current) => {
                    const {
                      repository: _repository,
                      number: _number,
                      selectedProjectId: _selectedProjectId,
                      ...rest
                    } = current;
                    return rest;
                  },
                })
              }
            >
              Back to issues
            </Button>
          </div>
          <GitHubIssueDetailContent
            environmentId={environmentId}
            detail={detailQuery.data}
            error={detailQuery.error}
            loading={detailQuery.isPending}
            onRetry={detailQuery.refresh}
          />
        </div>
      ) : null}
    </SidebarInset>
  );
}

function IssueRow({
  issue,
  selected,
  showProject,
  onSelect,
}: {
  issue: GitHubIssueListEntry;
  selected: boolean;
  showProject: boolean;
  onSelect: (issue: GitHubIssueListEntry) => void;
}) {
  const StateIcon = issue.state === "open" ? CircleDotIcon : CircleSlash2Icon;
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 px-4 py-3 text-left [contain-intrinsic-block-size:72px] [content-visibility:auto] hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected && "bg-accent",
      )}
      onClick={() => onSelect(issue)}
    >
      <StateIcon
        className={cn(
          "mt-0.5 size-4",
          issue.state === "open" ? "text-success-foreground" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{issue.title}</span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <span>#{issue.number}</span>
          {showProject ? <span className="truncate">{issue.repository}</span> : null}
          {issue.author ? <span className="truncate">by {issue.author.login}</span> : null}
        </span>
        {issue.labels.length > 0 ? (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {issue.labels.slice(0, 3).map((label) => (
              <span
                key={label.name}
                className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {label.name}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      <span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
        {formatRelativeTimeLabel(issue.updatedAt)}
      </span>
    </button>
  );
}
