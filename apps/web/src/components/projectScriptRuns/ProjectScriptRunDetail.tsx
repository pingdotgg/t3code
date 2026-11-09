import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { terminalOutputText } from "@t3tools/client-runtime/state/terminal";
import { AuthTerminalReadScope } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import {
  isProjectScriptRunActive,
  projectScriptOutputTail,
  projectScriptRunStatusLabel,
  projectScriptVisibleOutput,
  type ProjectScriptRun,
  type ProjectScriptRunStatus,
} from "../../projectScriptRuns";
import { useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { cn } from "../../lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ProjectScriptRunStatusIcon } from "./ProjectScriptRunStatusIcon";

function statusVariant(status: ProjectScriptRunStatus): "error" | "success" | "info" | "outline" {
  if (status === "failed") return "error";
  if (status === "succeeded") return "success";
  if (status === "running" || status === "starting") return "info";
  return "outline";
}

export function ProjectScriptRunDetail({
  run,
  project,
  recentRuns,
  canOperate,
  onClose,
  onSelectRun,
  onStop,
  onDismiss,
  onOpenInTerminal,
}: {
  readonly run: ProjectScriptRun;
  readonly project: EnvironmentProject | null;
  readonly recentRuns: ReadonlyArray<ProjectScriptRun>;
  readonly canOperate: boolean;
  readonly onClose: () => void;
  readonly onSelectRun: (runId: string) => void;
  readonly onStop: (run: ProjectScriptRun) => void;
  readonly onDismiss: (run: ProjectScriptRun) => void;
  readonly onOpenInTerminal: (run: ProjectScriptRun) => void;
}) {
  const observe = useAtomValue(
    terminalEnvironment.observe({
      environmentId: run.environmentId,
      input: { threadId: run.threadId, terminalId: run.terminalId },
    }),
  );
  const buffer = AsyncResult.getOrElse(observe, () => null);
  const liveText =
    buffer === null
      ? ""
      : projectScriptVisibleOutput(terminalOutputText(buffer.output), run.sentinel);
  const output = liveText.length > 0 ? projectScriptOutputTail(liveText) : run.outputTail;
  const canRead = useEnvironmentScope(run.environmentId, AuthTerminalReadScope);
  const active = isProjectScriptRunActive(run);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <ProjectScriptRunStatusIcon status={run.status} className="size-4" />
              {run.scriptName}
            </span>
          </DialogTitle>
          <DialogDescription>
            <span className="flex items-center gap-1.5">
              {project !== null ? (
                <ProjectFavicon project={project} className="size-3.5 shrink-0" />
              ) : null}
              <span>
                {run.threadScoped ? `${run.projectTitle} · ${run.threadTitle}` : run.projectTitle}
              </span>
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant(run.status)}>
                {projectScriptRunStatusLabel(run.status)}
              </Badge>
              {run.exitCode !== null ? <Badge variant="outline">Exit {run.exitCode}</Badge> : null}
              <span className="text-xs text-muted-foreground">
                {new Date(run.startedAt).toLocaleString()}
              </span>
            </div>
            {run.errorMessage !== null ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {run.errorMessage}
              </div>
            ) : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Command</dt>
              <dd className="font-mono break-all">{run.command}</dd>
              <dt className="text-muted-foreground">Directory</dt>
              <dd className="font-mono break-all">{run.cwd}</dd>
              <dt className="text-muted-foreground">Terminal</dt>
              <dd className="font-mono break-all">{run.terminalId}</dd>
              <dt className="text-muted-foreground">Scope</dt>
              <dd>{run.threadScoped ? "Thread worktree" : "Project checkout"}</dd>
            </dl>
            <pre className="max-h-80 overflow-auto rounded-md border border-border/70 bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
              {output.length > 0 ? output : "No output yet."}
            </pre>
            {recentRuns.length > 1 ? (
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">Recent runs</h3>
                <div className="flex flex-col gap-1">
                  {recentRuns.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-2 py-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        entry.id === run.id
                          ? "border-border bg-accent/50"
                          : "border-border/60 hover:bg-accent/40",
                      )}
                      onClick={() => onSelectRun(entry.id)}
                    >
                      <ProjectScriptRunStatusIcon
                        status={entry.status}
                        className="size-3.5 shrink-0"
                      />
                      <span className="w-16 shrink-0 text-muted-foreground">
                        {projectScriptRunStatusLabel(entry.status)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {new Date(entry.startedAt).toLocaleTimeString()}
                      </span>
                      {entry.exitCode !== null ? (
                        <span className="shrink-0 font-mono text-muted-foreground">
                          exit {entry.exitCode}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          {active ? (
            <Button
              variant="destructive-outline"
              disabled={!canOperate}
              onClick={() => onStop(run)}
            >
              Stop
            </Button>
          ) : null}
          {run.threadScoped ? (
            <Button variant="outline" disabled={!canRead} onClick={() => onOpenInTerminal(run)}>
              Open in terminal
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              onDismiss(run);
              onClose();
            }}
          >
            Dismiss
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
