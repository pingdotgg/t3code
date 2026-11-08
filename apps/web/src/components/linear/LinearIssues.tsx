import type {
  EnvironmentId,
  LinearIssuesInput,
  LinearPerson,
  LinearTeamContext,
  LinearIssueSummary,
} from "@t3tools/contracts";
import { useState } from "react";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { LinearSelect, LinearMessage, LinearPager } from "./LinearControls";
import type { LinearSearch } from "./linearSearch";
import type { LinearMutate } from "./linearTypes";

export function LinearIssues({
  environmentId,
  search,
  context,
  users,
  change,
  mutate,
  canWrite,
}: {
  environmentId: EnvironmentId;
  search: LinearSearch;
  context: typeof LinearTeamContext.Type | null;
  users: ReadonlyArray<typeof LinearPerson.Type>;
  change: (patch: Partial<LinearSearch>) => void;
  mutate: LinearMutate;
  canWrite: boolean;
}) {
  const [cursors, setCursors] = useState<Array<string>>([]);
  const [query, setQuery] = useState(search.q ?? "");
  const after = cursors.at(-1);
  const input: typeof LinearIssuesInput.Type = {
    view:
      search.view === "inbox" ||
      search.view === "projects" ||
      search.view === "cycles" ||
      search.view === "documents"
        ? "all"
        : search.view,
    ...(search.parent ? { parentId: search.parent } : {}),
    ...(search.team ? { teamId: search.team } : {}),
    ...(search.project ? { projectId: search.project } : {}),
    ...(search.cycle ? { cycleId: search.cycle } : {}),
    ...(search.statusId ? { stateId: search.statusId } : {}),
    ...(search.assignee ? { assigneeId: search.assignee } : {}),
    ...(search.label ? { labelId: search.label } : {}),
    ...(search.q ? { query: search.q } : {}),
    ...(after ? { after } : {}),
    includeArchived: search.archived ?? false,
  };
  const issues = useEnvironmentQuery(linearEnvironment.issues({ environmentId, input }));
  const [dragging, setDragging] = useState<string | null>(null);
  const states = context?.states ?? [
    ...new Map(issues.data?.nodes.map((issue) => [issue.state.id, issue.state])).values(),
  ];
  const move = (stateId: string) => {
    if (dragging && canWrite && search.team)
      void mutate({ kind: "issueUpdate", id: dragging, input: { stateId } });
    setDragging(null);
  };
  return (
    <>
      {search.parent && (
        <div className="flex items-center gap-2 border-b px-5 py-2 text-xs text-muted-foreground">
          Subissues of {search.parent}
          <Button variant="ghost" size="sm" onClick={() => change({ parent: undefined })}>
            Clear subissue filter
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3 border-b px-5 py-3">
        <form
          className="min-w-48 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            change({ q: query.trim() || undefined });
          }}
        >
          <Input
            aria-label="Search Linear issues"
            placeholder="Search titles, descriptions, or issue IDs…"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </form>
        <Button
          size="sm"
          variant={search.board ? "secondary" : "outline"}
          onClick={() => change({ board: !search.board })}
        >
          {search.board ? "List view" : "Board view"}
        </Button>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={search.archived ?? false}
            onChange={(event) => change({ archived: event.target.checked })}
          />
          Include archived
        </label>
        {context && (
          <>
            <LinearSelect
              label="Status"
              value={search.statusId ?? ""}
              options={context.states}
              onChange={(state) => change({ statusId: state || undefined })}
            />
            <LinearSelect
              label="Project"
              value={search.project ?? ""}
              options={context.projects}
              onChange={(project) => change({ project: project || undefined })}
            />
            <LinearSelect
              label="Cycle"
              value={search.cycle ?? ""}
              options={context.cycles.map((cycle) => ({
                id: cycle.id,
                name: cycle.name ?? `Cycle ${cycle.number}`,
              }))}
              onChange={(cycle) => change({ cycle: cycle || undefined })}
            />
            <LinearSelect
              label="Label"
              value={search.label ?? ""}
              options={context.labels}
              onChange={(label) => change({ label: label || undefined })}
            />
          </>
        )}
        <LinearSelect
          label="Assignee"
          value={search.assignee ?? ""}
          options={users}
          onChange={(assignee) => change({ assignee: assignee || undefined })}
        />
      </div>
      {issues.error ? (
        <LinearMessage retry={issues.refresh}>{issues.error}</LinearMessage>
      ) : issues.isPending && !issues.data ? (
        <LinearMessage>Loading issues…</LinearMessage>
      ) : issues.data?.nodes.length === 0 ? (
        <LinearMessage>No issues match these filters.</LinearMessage>
      ) : null}
      <ScrollArea scrollbarGutter>
        {search.board ? (
          <div className="flex min-h-full gap-4 p-4">
            {states.map((state) => (
              <section
                key={state.id}
                aria-label={state.name}
                onDragOver={(event) => {
                  if (canWrite && search.team) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  move(state.id);
                }}
                className="w-72 shrink-0 rounded-lg bg-muted/30 p-3"
              >
                <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <span className="size-2 rounded-full" style={{ backgroundColor: state.color }} />
                  {state.name}
                  <span className="ml-auto text-muted-foreground">
                    {issues.data?.nodes.filter((issue) => issue.state.id === state.id).length ?? 0}
                  </span>
                </h2>
                <div className="flex flex-col gap-2">
                  {issues.data?.nodes
                    .filter((issue) => issue.state.id === state.id)
                    .map((issue) => (
                      <div
                        key={issue.id}
                        draggable={canWrite && Boolean(search.team)}
                        onDragStart={() => setDragging(issue.id)}
                        onDragEnd={() => setDragging(null)}
                      >
                        <IssueRow
                          issue={issue}
                          compact
                          onOpen={() => change({ issue: issue.id })}
                        />
                      </div>
                    ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="divide-y">
            {issues.data?.nodes.map((issue) => (
              <IssueRow key={issue.id} issue={issue} onOpen={() => change({ issue: issue.id })} />
            ))}
          </div>
        )}
      </ScrollArea>
      <div className="px-5 pt-2 text-xs text-muted-foreground">
        {issues.data?.nodes.length ?? 0} issues on this page
        {search.board && !search.team ? " · Select a team to move cards between statuses." : ""}
      </div>
      <LinearPager
        after={after}
        hasNextPage={issues.data?.pageInfo.hasNextPage ?? false}
        pending={issues.isPending}
        onPrevious={() => setCursors((values) => values.slice(0, -1))}
        onNext={() => {
          const cursor = issues.data?.pageInfo.endCursor;
          if (cursor) setCursors((values) => [...values, cursor]);
        }}
      />
    </>
  );
}
function IssueRow({
  issue,
  onOpen,
  compact = false,
}: {
  issue: LinearIssueSummary;
  onOpen: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full gap-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring ${compact ? "flex-col rounded-md border bg-background p-3" : "items-center px-5 py-3"}`}
    >
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="size-2 rounded-full" style={{ backgroundColor: issue.state.color }} />
        <span>{issue.identifier}</span>
      </span>
      <span className="min-w-0 flex-1 text-sm">{issue.title}</span>
      <span className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {issue.priority > 0 && (
          <span className={issue.priority <= 2 ? "text-warning" : ""}>{issue.priorityLabel}</span>
        )}
        {issue.labels.nodes.slice(0, 2).map((label) => (
          <span key={label.id} className="rounded border px-1.5 py-0.5">
            {label.name}
          </span>
        ))}
        {issue.dueDate && <time dateTime={issue.dueDate}>{issue.dueDate}</time>}
        <span>{issue.assignee?.name ?? "Unassigned"}</span>
      </span>
    </button>
  );
}
