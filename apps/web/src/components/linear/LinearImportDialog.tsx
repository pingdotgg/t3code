import { useNavigate } from "@tanstack/react-router";
import type { LinearImportMode } from "@t3tools/client-runtime/linear-format";
import { LINEAR_FETCH_MAX_IDS, type LinearIssueSummary } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const SEARCH_LIMIT = 25;
const SEARCH_DEBOUNCE_MS = 250;

export function LinearImportDialog() {
  const navigate = useNavigate();
  const projects = useProjects();
  const environmentId = usePrimaryEnvironmentId();
  const importIssues = useLinearImport();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedIdSet, setSelectedIdSet] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<LinearImportMode>("combine");
  const [targetProjectId, setTargetProjectId] = useState<string>("");
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);

  const destinationProjects = useMemo(
    () =>
      environmentId === null
        ? []
        : projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );

  useEffect(() => onOpenLinearImport(() => setOpen(true)), []);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDebouncedQuery("");
    setSelectedIdSet(new Set());
    setMode("combine");
  }, [open]);

  useEffect(() => {
    setTargetProjectId((current) =>
      destinationProjects.some((project) => project.id === current)
        ? current
        : (destinationProjects[0]?.id ?? ""),
    );
  }, [destinationProjects]);

  const authQuery = useEnvironmentQuery(
    !open || environmentId === null
      ? null
      : linearEnvironment.authStatus({ environmentId, input: {} }),
  );
  const authStatus = authQuery.data?.status;
  const connected = authStatus === "authenticated";
  const searchQuery = useEnvironmentQuery(
    !open || environmentId === null || !connected
      ? null
      : linearEnvironment.searchIssues({
          environmentId,
          input: { query: debouncedQuery, limit: SEARCH_LIMIT },
        }),
  );

  const issues = searchQuery.data?.issues ?? [];

  const toggleIssue = useCallback((issueId: string) => {
    setSelectedIdSet((current) => {
      const next = new Set(current);
      if (next.has(issueId)) {
        next.delete(issueId);
        return next;
      }
      if (next.size >= LINEAR_FETCH_MAX_IDS) return current;
      next.add(issueId);
      return next;
    });
  }, []);

  const handleImport = useCallback(async () => {
    if (environmentId === null || importingRef.current) return;
    const target = destinationProjects.find((project) => project.id === targetProjectId);
    if (target === undefined) {
      toastManager.add({ type: "error", title: "Pick a folder for the new thread." });
      return;
    }
    const ids = [...selectedIdSet];
    if (ids.length === 0) {
      toastManager.add({ type: "error", title: "Select at least one issue to import." });
      return;
    }
    importingRef.current = true;
    setImporting(true);
    try {
      const result = await importIssues({
        sourceEnvironmentId: environmentId,
        target: { environmentId, projectId: target.id },
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
      importingRef.current = false;
      setImporting(false);
    }
  }, [destinationProjects, environmentId, importIssues, mode, selectedIdSet, targetProjectId]);

  const selectedFolderTitle =
    destinationProjects.find((project) => project.id === targetProjectId)?.title ?? "Folder";

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
          {authQuery.error || authStatus === "unverified" ? (
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
              {destinationProjects.length > 1 ? (
                <div className="flex flex-col gap-1.5 text-sm">
                  <span className="text-muted-foreground">Folder</span>
                  <Select
                    value={targetProjectId}
                    onValueChange={(value) => setTargetProjectId(String(value))}
                  >
                    <SelectTrigger aria-label="Destination folder">
                      <SelectValue>{selectedFolderTitle}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {destinationProjects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              <ToggleGroup
                size="sm"
                value={[mode]}
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === "combine" || next === "subtasks") {
                    setMode(next);
                  }
                }}
              >
                <Toggle aria-label="Combine issues into one task" value="combine">
                  Combine
                </Toggle>
                <Toggle aria-label="Import issues as subtasks" value="subtasks">
                  Subtasks
                </Toggle>
              </ToggleGroup>
              <ScrollArea scrollFade className="max-h-72">
                <div className="space-y-1" aria-label="Linear issues">
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
              </ScrollArea>
            </>
          )}
        </DialogPanel>
        {connected ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={importing || selectedIdSet.size === 0 || destinationProjects.length === 0}
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
    <label className="flex w-full cursor-pointer items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-accent/60">
      <Checkbox
        checked={selected}
        className="mt-0.5"
        onCheckedChange={(checked) => {
          if (Boolean(checked) !== selected) onToggle();
        }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {issue.identifier}: {issue.title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {[issue.teamKey, issue.stateName, issue.assigneeName].filter(Boolean).join(" · ")}
        </span>
      </span>
    </label>
  );
}
