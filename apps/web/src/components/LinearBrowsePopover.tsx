import type { EnvironmentId, LinearIssueSummary, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useLinearImport } from "../hooks/useLinearImport";
import { cn } from "../lib/utils";
import { linearEnvironment } from "../state/linear";
import { useEnvironmentQuery } from "../state/query";
import { LinearIcon } from "./Icons";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Empty } from "./ui/empty";
import { Input } from "./ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Spinner } from "./ui/spinner";
import { Switch } from "./ui/switch";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const SEARCH_LIMIT = 25;
const SEARCH_DEBOUNCE_MS = 200;

const TRIGGER_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] text-muted-foreground/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring";

function IssueRow({
  issue,
  checked,
  onToggle,
}: {
  issue: LinearIssueSummary;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/50">
      <Checkbox checked={checked} onCheckedChange={onToggle} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {issue.identifier}
          </span>
          <span className="truncate text-[13px] text-foreground">{issue.title}</span>
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/70">
          {issue.stateName ? <span>{issue.stateName}</span> : null}
          {issue.assigneeName ? <span>· {issue.assigneeName}</span> : null}
          {issue.priorityLabel ? <span>· {issue.priorityLabel}</span> : null}
        </span>
      </span>
    </label>
  );
}

export function LinearBrowsePopover({
  environmentId,
  projectId,
  projectName,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [combine, setCombine] = useState(true);
  const [importing, setImporting] = useState(false);

  const runImport = useLinearImport();
  const navigate = useNavigate();

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const authQuery = useEnvironmentQuery(
    open ? linearEnvironment.authStatus({ environmentId, input: {} }) : null,
  );
  const connected = authQuery.data?.status === "authenticated";

  const searchQuery = useEnvironmentQuery(
    open && connected
      ? linearEnvironment.searchIssues({
          environmentId,
          input: { query: debounced, limit: SEARCH_LIMIT },
        })
      : null,
  );

  const issues = searchQuery.data?.issues ?? [];
  const selectedCount = selected.size;

  // When a new result set arrives, drop selections that are no longer visible
  // so Import can't act on issues that scrolled out of the current search.
  useEffect(() => {
    const data = searchQuery.data;
    if (!data) return;
    setSelected((current) => {
      if (current.size === 0) return current;
      const visible = new Set(data.issues.map((issue) => issue.id));
      const filtered = [...current].filter((id) => visible.has(id));
      return filtered.length === current.size ? current : new Set(filtered);
    });
  }, [searchQuery.data]);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setQuery("");
    setDebounced("");
    setSelected(new Set());
    setCombine(true);
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) reset();
    },
    [reset],
  );

  const handleImport = useCallback(async () => {
    if (selectedCount === 0 || importing) return;
    setImporting(true);
    try {
      const result = await runImport({
        target: { environmentId, projectId },
        ids: [...selected],
        mode: combine ? "combine" : "perIssue",
      });
      // Only keep failed issues that are still visible in the current results,
      // so we never leave an un-clearable selection of off-screen rows.
      const visibleIds = new Set(issues.map((issue) => issue.id));
      const retryable = (result.failedIds ?? []).filter((id) => visibleIds.has(id));
      if (result.ok) {
        if (result.warning) {
          toastManager.add({
            type: "warning",
            title: "Imported with issues",
            description: result.warning,
          });
        }
        if (retryable.length > 0) {
          setSelected(new Set(retryable));
        } else {
          handleOpenChange(false);
        }
      } else {
        toastManager.add({
          type: "error",
          title: "Linear import failed",
          description: result.error ?? "The issues could not be imported.",
        });
        // Only narrow the selection when the hook reported specific failures;
        // a blanket failure (nothing imported) keeps the current selection so
        // the user can retry it as-is.
        if (result.failedIds !== undefined) setSelected(new Set(retryable));
      }
    } finally {
      setImporting(false);
    }
  }, [
    combine,
    environmentId,
    handleOpenChange,
    importing,
    issues,
    projectId,
    runImport,
    selected,
    selectedCount,
  ]);

  const body = useMemo(() => {
    if (authQuery.isPending && authQuery.data === null) {
      return (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Spinner className="size-4" /> Checking Linear connection…
        </div>
      );
    }
    if (authQuery.error !== null) {
      return (
        <Empty className="py-8">
          <p className="text-[13px] font-medium text-foreground">Couldn’t reach Linear</p>
          <p className="mt-1 max-w-56 text-xs text-muted-foreground">{authQuery.error}</p>
        </Empty>
      );
    }
    if (!connected) {
      return (
        <Empty className="py-8">
          <p className="text-[13px] font-medium text-foreground">Linear isn’t connected</p>
          <p className="mt-1 max-w-56 text-xs text-muted-foreground">
            Add a personal API key in Settings → Linear to import issues.
          </p>
        </Empty>
      );
    }
    if (searchQuery.error !== null) {
      return (
        <Empty className="py-8">
          <p className="text-[13px] font-medium text-foreground">Couldn’t load issues</p>
          <p className="mt-1 max-w-56 text-xs text-muted-foreground">{searchQuery.error}</p>
        </Empty>
      );
    }
    if (searchQuery.isPending && issues.length === 0) {
      return (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Spinner className="size-4" /> Searching…
        </div>
      );
    }
    if (issues.length === 0) {
      return (
        <Empty className="py-8">
          <p className="text-[13px] font-medium text-foreground">No issues found</p>
          <p className="mt-1 max-w-56 text-xs text-muted-foreground">
            {debounced.trim().length > 0
              ? "Try a different search term."
              : "No recent issues were returned."}
          </p>
        </Empty>
      );
    }
    return (
      <ScrollArea className="max-h-64">
        <div className="flex flex-col gap-0.5 pr-2">
          {issues.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              checked={selected.has(issue.id)}
              onToggle={() => toggle(issue.id)}
            />
          ))}
        </div>
      </ScrollArea>
    );
  }, [
    authQuery.data,
    authQuery.error,
    authQuery.isPending,
    connected,
    debounced,
    issues,
    searchQuery.error,
    searchQuery.isPending,
    selected,
    toggle,
  ]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <div className="pointer-events-none absolute top-[calc(50%+1px)] right-7 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100 data-[popover-open]:pointer-events-auto data-[popover-open]:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Import Linear issue into ${projectName}`}
                    className={TRIGGER_CLASS}
                  >
                    <LinearIcon className="size-3.5" />
                  </button>
                }
              />
            }
          />
          <TooltipPopup side="top">Import from Linear</TooltipPopup>
        </Tooltip>
      </div>
      <PopoverPopup side="right" align="start" className="w-80">
        <div className="flex flex-col gap-3 p-3">
          <div className="flex items-center gap-2">
            <LinearIcon className="size-3.5 text-muted-foreground" />
            <span className="text-[13px] font-semibold text-foreground">Import from Linear</span>
            {selectedCount > 0 ? (
              <Badge variant="secondary" size="sm" className="ml-auto">
                {selectedCount} selected
              </Badge>
            ) : (
              <button
                type="button"
                className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => {
                  handleOpenChange(false);
                  void navigate({ to: "/linear" });
                }}
              >
                Browse all →
              </button>
            )}
          </div>

          {connected ? (
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search issues…"
                className="h-8 pl-8 text-[13px]"
                aria-label="Search Linear issues"
              />
            </div>
          ) : null}

          {body}

          {connected ? (
            <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  checked={combine}
                  onCheckedChange={setCombine}
                  aria-label="Combine issues into one thread"
                />
                {combine ? "Combine into one thread" : "One thread per issue"}
              </label>
              <Button
                size="sm"
                disabled={selectedCount === 0 || importing}
                onClick={() => void handleImport()}
              >
                {importing ? "Importing…" : "Import"}
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
