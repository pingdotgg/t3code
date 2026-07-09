import type {
  EnvironmentId,
  LinearIssueFilter,
  LinearIssueSummary,
  ProjectId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLinearImport } from "../../hooks/useLinearImport";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { LinearIcon } from "../Icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty } from "../ui/empty";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { toastManager } from "../ui/toast";

const PAGE_SIZE = 50;
const ALL = "__all__";

function FilterSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Select value={value} onValueChange={(next) => onChange(next ?? ALL)} disabled={disabled}>
      <SelectTrigger className="h-8 w-40 text-[13px]" aria-label={label}>
        <SelectValue>{selected?.label ?? label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value={ALL}>
          {label}
        </SelectItem>
        {options.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function IssueTableRow({
  issue,
  checked,
  onToggle,
}: {
  issue: LinearIssueSummary;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <TableRow data-state={checked ? "selected" : undefined} className="cursor-pointer">
      <TableCell className="w-8" onClick={onToggle}>
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          aria-label={`Select ${issue.identifier}`}
        />
      </TableCell>
      <TableCell className="w-24 font-mono text-[11px] text-muted-foreground" onClick={onToggle}>
        {issue.identifier}
      </TableCell>
      <TableCell className="max-w-0 truncate text-[13px]" onClick={onToggle}>
        {issue.title}
      </TableCell>
      <TableCell className="w-32 text-xs text-muted-foreground" onClick={onToggle}>
        {issue.stateName ?? "—"}
      </TableCell>
      <TableCell className="w-32 text-xs text-muted-foreground" onClick={onToggle}>
        {issue.assigneeName ?? "—"}
      </TableCell>
      <TableCell className="w-24 text-xs text-muted-foreground" onClick={onToggle}>
        {issue.priorityLabel ?? "—"}
      </TableCell>
    </TableRow>
  );
}

export function LinearBrowser() {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const navigate = useNavigate();
  const runImport = useLinearImport();

  const [teamId, setTeamId] = useState(ALL);
  const [assigneeId, setAssigneeId] = useState(ALL);
  const [stateId, setStateId] = useState(ALL);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<ReadonlyArray<LinearIssueSummary>>([]);
  const [hasNext, setHasNext] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [perIssue, setPerIssue] = useState(true);
  const [targetProjectId, setTargetProjectId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(id);
  }, [query]);

  const filter = useMemo<LinearIssueFilter>(
    () => ({
      ...(teamId !== ALL ? { teamId } : {}),
      ...(assigneeId !== ALL ? { assigneeId } : {}),
      ...(stateId !== ALL ? { stateId } : {}),
      ...(debounced.trim().length > 0 ? { query: debounced.trim() } : {}),
    }),
    [assigneeId, debounced, stateId, teamId],
  );
  const filterKey = JSON.stringify(filter);

  const authQuery = useEnvironmentQuery(
    environmentId ? linearEnvironment.authStatus({ environmentId, input: {} }) : null,
  );
  const connected = authQuery.data?.status === "authenticated";

  const teamsQuery = useEnvironmentQuery(
    environmentId && connected ? linearEnvironment.teams({ environmentId, input: {} }) : null,
  );
  const usersQuery = useEnvironmentQuery(
    environmentId && connected ? linearEnvironment.users({ environmentId, input: {} }) : null,
  );
  const statesQuery = useEnvironmentQuery(
    environmentId && connected && teamId !== ALL
      ? linearEnvironment.workflowStates({ environmentId, input: { teamId } })
      : null,
  );
  const listQuery = useEnvironmentQuery(
    environmentId && connected
      ? linearEnvironment.listIssues({
          environmentId,
          input: { filter, first: PAGE_SIZE, ...(cursor ? { after: cursor } : {}) },
        })
      : null,
  );

  // Which filter the accumulated rows belong to, so a page fetched under a
  // previous filter can never merge into results for the current one.
  const accumFilterKey = useRef<string | null>(null);

  // Reset paging + selection whenever the filter changes.
  useEffect(() => {
    setCursor(undefined);
    setSelected(new Set());
  }, [filterKey]);

  // Accumulate pages (dedupe by id); replace instead of append when the filter
  // changed since the last accumulated page.
  useEffect(() => {
    const data = listQuery.data;
    if (!data) return;
    setRows((prev) => {
      const base = accumFilterKey.current === filterKey ? prev : [];
      const seen = new Set(base.map((issue) => issue.id));
      const merged = [...base];
      for (const issue of data.issues) if (!seen.has(issue.id)) merged.push(issue);
      return merged;
    });
    accumFilterKey.current = filterKey;
    // Only offer "load more" when the API actually returned a cursor to advance.
    setHasNext(data.pageInfo.hasNextPage && data.pageInfo.endCursor != null);
  }, [listQuery.data, filterKey]);

  useEffect(() => {
    if (targetProjectId === null && projects.length > 0) {
      setTargetProjectId(projects[0]!.id);
    }
  }, [projects, targetProjectId]);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = rows.length > 0 && rows.every((issue) => selected.has(issue.id));
  const toggleAll = useCallback(() => {
    setSelected((current) =>
      rows.every((issue) => current.has(issue.id))
        ? new Set()
        : new Set(rows.map((issue) => issue.id)),
    );
  }, [rows]);

  const teamOptions = (teamsQuery.data?.teams ?? []).map((team) => ({
    value: team.id,
    label: `${team.key} · ${team.name}`,
  }));
  const userOptions = (usersQuery.data?.users ?? []).map((user) => ({
    value: user.id,
    label: user.isMe ? `${user.name} (me)` : user.name,
  }));
  const stateOptions = (statesQuery.data?.states ?? []).map((state) => ({
    value: state.id,
    label: state.name,
  }));

  const targetProject = projects.find((project) => project.id === targetProjectId) ?? null;

  const handleImport = useCallback(async () => {
    if (selected.size === 0 || importing) return;
    if (!environmentId || !targetProject) {
      toastManager.add({
        type: "error",
        title: "Pick a destination folder",
        description: "Choose which project to import into.",
      });
      return;
    }
    setImporting(true);
    try {
      const result = await runImport({
        target: {
          environmentId: targetProject.environmentId,
          projectId: targetProject.id as ProjectId,
        },
        ids: [...selected],
        mode: perIssue ? "perIssue" : "combine",
      });
      // Keep only failed issues still visible in the loaded rows selected, so a
      // retry re-imports just those without stranding off-screen selections.
      const visibleIds = new Set(rows.map((issue) => issue.id));
      const retryable = (result.failedIds ?? []).filter((id) => visibleIds.has(id));
      if (result.ok) {
        toastManager.add(
          result.warning
            ? { type: "warning", title: "Imported with issues", description: result.warning }
            : {
                type: "success",
                title: perIssue ? "Threads created" : "Draft ready",
                description: perIssue
                  ? `Started ${selected.size} thread${selected.size === 1 ? "" : "s"} from Linear.`
                  : "Review the pre-filled composer and send.",
              },
        );
        if (retryable.length > 0) {
          // Stay on the browser with the failed rows selected for retry.
          setSelected(new Set(retryable));
        } else {
          setSelected(new Set());
          void navigate({ to: "/" });
        }
      } else {
        toastManager.add({
          type: "error",
          title: "Linear import failed",
          description: result.error ?? "The issues could not be imported.",
        });
        // Keep the current selection on a blanket failure (nothing imported);
        // only narrow it when specific issues were reported as failed.
        if (result.failedIds !== undefined) setSelected(new Set(retryable));
      }
    } finally {
      setImporting(false);
    }
  }, [environmentId, importing, navigate, perIssue, rows, runImport, selected, targetProject]);

  let body: ReactNode;
  if (!environmentId || (authQuery.isPending && authQuery.data === null)) {
    body = (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Spinner className="size-4" /> Loading…
      </div>
    );
  } else if (!connected) {
    body = (
      <Empty className="py-16">
        <p className="text-sm font-medium text-foreground">Linear isn’t connected</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          Add a personal API key in Settings → Linear to browse and import issues.
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          onClick={() => void navigate({ to: "/settings/linear" })}
        >
          Open Linear settings
        </Button>
      </Empty>
    );
  } else if (listQuery.error !== null && rows.length === 0) {
    body = (
      <Empty className="py-16">
        <p className="text-sm font-medium text-foreground">Couldn’t load issues</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">{listQuery.error}</p>
      </Empty>
    );
  } else if (rows.length === 0 && !listQuery.isPending) {
    body = (
      <Empty className="py-16">
        <p className="text-sm font-medium text-foreground">No issues match</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">Adjust the filters or search.</p>
      </Empty>
    );
  } else {
    body = (
      <ScrollArea className="flex-1">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all issues"
                />
              </TableHead>
              <TableHead className="w-24">ID</TableHead>
              <TableHead>Title</TableHead>
              <TableHead className="w-32">Status</TableHead>
              <TableHead className="w-32">Assignee</TableHead>
              <TableHead className="w-24">Priority</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((issue) => (
              <IssueTableRow
                key={issue.id}
                issue={issue}
                checked={selected.has(issue.id)}
                onToggle={() => toggle(issue.id)}
              />
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-center py-3">
          {hasNext ? (
            <Button
              size="sm"
              variant="outline"
              disabled={listQuery.isPending}
              onClick={() => {
                const next = listQuery.data?.pageInfo.endCursor;
                if (next != null) setCursor(next);
              }}
            >
              {listQuery.isPending ? "Loading…" : "Load more"}
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground/70">
              {rows.length} issue{rows.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </ScrollArea>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <LinearIcon className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-semibold text-foreground">Linear issues</h1>
      </header>

      {connected ? (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search…"
              aria-label="Search Linear issues"
              className="h-8 w-56 pl-8 text-[13px]"
            />
          </div>
          <FilterSelect
            label="All teams"
            value={teamId}
            onChange={(value) => {
              setTeamId(value);
              setStateId(ALL);
            }}
            options={teamOptions}
          />
          <FilterSelect
            label="Any status"
            value={stateId}
            onChange={setStateId}
            options={stateOptions}
            disabled={teamId === ALL}
          />
          <FilterSelect
            label="Anyone"
            value={assigneeId}
            onChange={setAssigneeId}
            options={userOptions}
          />
        </div>
      ) : null}

      {body}

      {connected && selected.size > 0 ? (
        <footer className="flex flex-wrap items-center gap-3 border-t px-4 py-3">
          <Badge variant="secondary">{selected.size} selected</Badge>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={perIssue}
              onCheckedChange={setPerIssue}
              aria-label="One thread per issue"
            />
            {perIssue ? "One thread per issue" : "Combine into one thread"}
          </label>
          <div className="ml-auto flex items-center gap-2">
            <Select
              value={targetProjectId ?? ""}
              onValueChange={setTargetProjectId}
              disabled={projects.length === 0}
            >
              <SelectTrigger className="h-8 w-48 text-[13px]" aria-label="Destination folder">
                <SelectValue>{targetProject?.title ?? "Select folder"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {projects.map((project) => (
                  <SelectItem hideIndicator key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="sm"
              disabled={importing || !targetProject}
              onClick={() => void handleImport()}
            >
              {importing ? "Importing…" : "Import"}
            </Button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}
