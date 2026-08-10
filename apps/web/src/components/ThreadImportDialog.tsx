import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ProjectId,
  type ThreadImportCandidate,
  type ThreadImportCommitResult,
} from "@t3tools/contracts";
import { DownloadIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { useProjects } from "../state/entities";
import { orchestrationEnvironment } from "../state/orchestration";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { onOpenThreadImportDialog, type ThreadImportDialogTarget } from "../threadImportDialog";

function projectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "Unknown time" : new Date(timestamp).toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The import could not be completed.";
}

function providerLabel(provider: ThreadImportCandidate["provider"]): string {
  return provider === "claudeAgent"
    ? "Claude Code"
    : provider === "codex"
      ? "Codex"
      : provider === "cursor"
        ? "Cursor"
        : "Grok";
}

function CandidateRow(props: {
  readonly candidate: ThreadImportCandidate;
  readonly selected: boolean;
  readonly onChange: (selected: boolean) => void;
}) {
  const { candidate } = props;
  return (
    <label className="flex cursor-pointer gap-3 rounded-lg border border-border/70 bg-background/45 p-3 hover:bg-accent/35">
      <Checkbox
        checked={props.selected}
        disabled={candidate.alreadyImported}
        onCheckedChange={(checked) => props.onChange(checked === true)}
        aria-label={`Import ${candidate.title}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{candidate.title}</span>
          {candidate.alreadyImported ? (
            <span className="shrink-0 text-xs text-muted-foreground">Already imported</span>
          ) : null}
        </span>
        <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{providerLabel(candidate.provider)}</span>
          <span>·</span>
          <span>{candidate.messageCount} messages</span>
          <span>·</span>
          <span>{formatUpdatedAt(candidate.updatedAt)}</span>
          <span>·</span>
          <span>{candidate.canResume ? "Resume available" : "Transcript only"}</span>
        </span>
        {candidate.warnings.length > 0 ? (
          <span className="mt-1 block text-xs text-warning">{candidate.warnings.join(" ")}</span>
        ) : null}
      </span>
    </label>
  );
}

export function ThreadImportDialog() {
  const navigate = useNavigate();
  const projects = useProjects();
  const commitImports = useAtomCommand(orchestrationEnvironment.threadImportCommit, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ThreadImportDialogTarget>({});
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [commitError, setCommitError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  useEffect(
    () =>
      onOpenThreadImportDialog((nextTarget) => {
        setTarget(nextTarget);
        setOpen(true);
        setCommitError(null);
      }),
    [],
  );

  const availableProjects = useMemo(
    () => projects.toSorted((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );

  useEffect(() => {
    if (!open) return;
    const requestedKey =
      target.environmentId !== undefined && target.projectId !== undefined
        ? projectKey(target.environmentId, target.projectId)
        : "";
    if (
      requestedKey &&
      availableProjects.some(
        (project) => projectKey(project.environmentId, project.id) === requestedKey,
      )
    ) {
      setSelectedProjectKey(requestedKey);
      return;
    }
    if (
      !availableProjects.some(
        (project) => projectKey(project.environmentId, project.id) === selectedProjectKey,
      )
    ) {
      const firstProject = availableProjects[0];
      setSelectedProjectKey(
        firstProject ? projectKey(firstProject.environmentId, firstProject.id) : "",
      );
    }
  }, [availableProjects, open, selectedProjectKey, target]);

  const selectedProject = availableProjects.find(
    (project) => projectKey(project.environmentId, project.id) === selectedProjectKey,
  );
  const scan = useEnvironmentQuery(
    open && selectedProject
      ? orchestrationEnvironment.threadImportScan({
          environmentId: selectedProject.environmentId,
          input: { projectId: selectedProject.id },
        })
      : null,
  );
  const candidates = scan.data?.candidates ?? [];
  const selectableCandidates = candidates.filter((candidate) => !candidate.alreadyImported);
  const selectedCount = selectedCandidateIds.size;

  useEffect(() => {
    setSelectedCandidateIds(new Set());
    setCommitError(null);
  }, [selectedProjectKey]);

  const setCandidateSelected = (candidateId: string, selected: boolean) => {
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      if (selected) next.add(candidateId);
      else next.delete(candidateId);
      return next;
    });
  };

  const selectAll = () =>
    setSelectedCandidateIds(new Set(selectableCandidates.map((item) => item.candidateId)));

  const importSelected = async () => {
    if (!selectedProject || selectedCandidateIds.size === 0) return;
    setCommitError(null);
    setIsImporting(true);
    try {
      const result = await commitImports({
        environmentId: selectedProject.environmentId,
        input: {
          projectId: selectedProject.id,
          candidateIds: [...selectedCandidateIds] as ThreadImportCandidate["candidateId"][],
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        },
      });
      if (result._tag === "Failure") {
        setCommitError(errorMessage(squashAtomCommandFailure(result)));
        return;
      }
      const firstThread = (result.value as ThreadImportCommitResult).results.find(
        (item) => item.threadId !== null,
      );
      setOpen(false);
      if (firstThread?.threadId) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(selectedProject.environmentId, firstThread.threadId),
          ),
        });
      }
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-2xl" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>Import conversations</DialogTitle>
          <DialogDescription>
            Discovering provider history on the T3 server host. Only conversations whose native
            workspace exactly matches the selected project are shown.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5 text-sm font-medium">
            Primary project
            <select
              value={selectedProjectKey}
              onChange={(event) => setSelectedProjectKey(event.target.value)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm font-normal outline-none focus:ring-2 focus:ring-ring"
              disabled={availableProjects.length === 0}
            >
              {availableProjects.length === 0 ? (
                <option value="">No projects available</option>
              ) : null}
              {availableProjects.map((project) => (
                <option
                  key={projectKey(project.environmentId, project.id)}
                  value={projectKey(project.environmentId, project.id)}
                >
                  {project.title}
                </option>
              ))}
            </select>
          </label>

          {scan.error ? <p className="text-sm text-destructive">{scan.error}</p> : null}
          {commitError ? <p className="text-sm text-destructive">{commitError}</p> : null}
          {scan.isPending ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" /> Scanning provider histories…
            </div>
          ) : candidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No eligible conversations were found for this project.
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {candidates.length} conversation{candidates.length === 1 ? "" : "s"} found
                </span>
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={selectAll}
                >
                  Select all new
                </button>
              </div>
              {candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.candidateId}
                  candidate={candidate}
                  selected={selectedCandidateIds.has(candidate.candidateId)}
                  onChange={(selected) => setCandidateSelected(candidate.candidateId, selected)}
                />
              ))}
            </div>
          )}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ExternalLinkIcon className="size-3.5" /> Imports are snapshots. Native resume is kept
            when available; otherwise the imported thread remains transcript-only.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void importSelected()}
            disabled={selectedCount === 0 || scan.isPending || isImporting}
          >
            {isImporting ? <LoaderCircleIcon className="animate-spin" /> : <DownloadIcon />}
            {isImporting ? "Importing…" : `Import ${selectedCount > 0 ? `(${selectedCount})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
