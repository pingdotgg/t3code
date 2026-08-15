import { useNavigate } from "@tanstack/react-router";
import type { LinearImportMode } from "@t3tools/client-runtime/linear-format";
import type { EnvironmentId, LinearIssueSummary, ProjectId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useLinearImport } from "../../hooks/useLinearImport";
import { onOpenLinearImport } from "../../linearImportBus";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { linearEnvironment } from "../../state/linear";
import { useEnvironmentQuery } from "../../state/query";
import { LinearIcon } from "../Icons";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

const SEARCH_LIMIT = 25;
const SEARCH_DEBOUNCE_MS = 250;

function projectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

export function LinearImportDialog() {
  const navigate = useNavigate();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const importIssues = useLinearImport();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedIdSet, setSelectedIdSet] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<LinearImportMode>("combine");
  const [targetKey, setTargetKey] = useState<string>("");
  const [importing, setImporting] = useState(false);

  useEffect(() => onOpenLinearImport(() => setOpen(true)), []);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  const defaultTargetKey = useMemo(() => {
    const preferred =
      projects.find((project) => project.environmentId === primaryEnvironmentId) ?? projects[0];
    return preferred ? projectKey(preferred.environmentId, preferred.id) : "";
  }, [primaryEnvironmentId, projects]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDebouncedQuery("");
    setSelectedIdSet(new Set());
    setMode("combine");
    setTargetKey((current) => current || defaultTargetKey);
  }, [defaultTargetKey, open]);

  const environmentId = primaryEnvironmentId;
  const authQuery = useEnvironmentQuery(
    !open || environmentId === null
      ? null
      : linearEnvironment.authStatus({ environmentId, input: {} }),
  );
  const connected = authQuery.data?.status === "authenticated";
  const searchQuery = useEnvironmentQuery(
    !open || environmentId === null || !connected
      ? null
      : linearEnvironment.searchIssues({
          environmentId,
          input: { query: debouncedQuery, limit: SEARCH_LIMIT },
        }),
  );

  const issues = searchQuery.data?.issues ?? [];
  const visibleIds = useMemo(() => new Set(issues.map((issue) => issue.id)), [issues]);

  const toggleIssue = useCallback((issueId: string) => {
    setSelectedIdSet((current) => {
      const next = new Set(current);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
  }, []);

  const handleImport = useCallback(async () => {
    if (environmentId === null || importing) return;
    const target = projects.find(
      (project) => projectKey(project.environmentId, project.id) === targetKey,
    );
    if (target === undefined) {
      toastManager.add({ type: "error", title: "Pick a folder for the new thread." });
      return;
    }
    const ids = [...selectedIdSet].filter((id) => visibleIds.has(id));
    if (ids.length === 0) {
      toastManager.add({ type: "error", title: "Select at least one issue to import." });
      return;
    }
    setImporting(true);
    try {
      const result = await importIssues({
        target: { environmentId: target.environmentId, projectId: target.id },
        ids,
        mode,
      });
      if (!result.ok) {
        toastManager.add({
          type: "error",
          title: "Could not import Linear issues",
          description: result.error,
        });
        return;
      }
      if (result.warning) {
        toastManager.add({ type: "warning", title: result.warning });
      } else {
        toastManager.add({
          type: "success",
          title:
            ids.length === 1 ? "Imported Linear issue" : `Imported ${ids.length} Linear issues`,
        });
      }
      setOpen(false);
    } finally {
      setImporting(false);
    }
  }, [
    environmentId,
    importIssues,
    importing,
    mode,
    projects,
    selectedIdSet,
    targetKey,
    visibleIds,
  ]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinearIcon className="size-4" />
            Import from Linear
          </DialogTitle>
          <DialogDescription>
            Search issues and drop their context into a new thread composer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {authQuery.error ? (
            <p className="text-sm text-destructive">
              Couldn&apos;t reach Linear. Try again in a moment.
            </p>
          ) : authQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Checking Linear connection…</p>
          ) : !connected ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Connect a Linear personal API key in Settings before importing issues.
              </p>
              <Button
                size="sm"
                onClick={() => {
                  setOpen(false);
                  void navigate({ to: "/settings/linear" });
                }}
              >
                Open Linear settings
              </Button>
            </div>
          ) : (
            <>
              <Input
                autoFocus
                placeholder="Search issues, or leave empty for recent"
                aria-label="Search Linear issues"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {projects.length > 1 ? (
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="text-muted-foreground">Folder</span>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                    value={targetKey}
                    onChange={(event) => setTargetKey(event.target.value)}
                    aria-label="Destination folder"
                  >
                    {projects.map((project) => (
                      <option
                        key={projectKey(project.environmentId, project.id)}
                        value={projectKey(project.environmentId, project.id)}
                      >
                        {project.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <div className="flex gap-2 text-sm">
                <Button
                  size="sm"
                  variant={mode === "combine" ? "default" : "outline"}
                  onClick={() => setMode("combine")}
                >
                  Combine
                </Button>
                <Button
                  size="sm"
                  variant={mode === "subtasks" ? "default" : "outline"}
                  onClick={() => setMode("subtasks")}
                >
                  Subtasks
                </Button>
              </div>
              <div
                className="max-h-72 space-y-1 overflow-y-auto"
                role="listbox"
                aria-label="Linear issues"
              >
                {searchQuery.error ? (
                  <p className="text-sm text-destructive">Couldn&apos;t load Linear issues.</p>
                ) : searchQuery.isPending ? (
                  <p className="text-sm text-muted-foreground">Loading issues…</p>
                ) : issues.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No issues match that search.</p>
                ) : (
                  issues.map((issue) => (
                    <IssueRow
                      key={issue.id}
                      issue={issue}
                      selected={selectedIdSet.has(issue.id)}
                      onToggle={() => toggleIssue(issue.id)}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </DialogPanel>
        {connected ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={importing || selectedIdSet.size === 0 || projects.length === 0}
              onClick={() => void handleImport()}
            >
              {importing
                ? "Importing…"
                : `Import${selectedIdSet.size > 0 ? ` ${selectedIdSet.size}` : ""}`}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function IssueRow({
  issue,
  selected,
  onToggle,
}: {
  readonly issue: LinearIssueSummary;
  readonly selected: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
      className="flex w-full cursor-pointer items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-accent/60"
    >
      <Checkbox checked={selected} tabIndex={-1} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {issue.identifier}: {issue.title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {[issue.teamKey, issue.stateName, issue.assigneeName].filter(Boolean).join(" · ")}
        </span>
      </span>
    </div>
  );
}
