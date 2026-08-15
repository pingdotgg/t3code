import type { RuntimeOperatorTask } from "@t3tools/client-runtime/state/operatorRuntime";
import { CircleAlert, CircleCheck, CircleDashed, CircleStop, Workflow } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

function elapsedBetween(startedAt: string, completedAt: string | null): string {
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function OperatorElapsed({ task }: { task: RuntimeOperatorTask }) {
  const live = task.status === "queued" || task.status === "running" || task.status === "waiting";
  const [elapsed, setElapsed] = useState(() => elapsedBetween(task.startedAt, task.completedAt));

  useEffect(() => {
    const update = () => setElapsed(elapsedBetween(task.startedAt, task.completedAt));
    update();
    if (!live) return;
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [live, task.completedAt, task.startedAt]);

  return (
    <span
      className="font-mono tabular-nums text-muted-foreground"
      aria-label={`Elapsed time for ${task.title}: ${elapsed}`}
    >
      {elapsed}
    </span>
  );
}

function statusIcon(task: RuntimeOperatorTask) {
  switch (task.status) {
    case "completed":
      return <CircleCheck className="size-3.5 text-success-foreground" />;
    case "failed":
      return <CircleAlert className="size-3.5 text-destructive" />;
    case "stopped":
      return <CircleStop className="size-3.5 text-muted-foreground" />;
    case "waiting":
      return <CircleAlert className="size-3.5 text-warning-foreground" />;
    case "queued":
    case "running":
      return <CircleDashed className="size-3.5 text-info-foreground" />;
  }
}

function OperatorTaskRow({ task }: { task: RuntimeOperatorTask }) {
  const option = task.effort ? ` · ${task.effort}` : "";
  return (
    <div className="rounded-lg px-2.5 py-2 hover:bg-accent/50">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0" aria-hidden>
          {statusIcon(task)}
        </span>
        <span className="sr-only">Status: {task.status}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</span>
        <OperatorElapsed task={task} />
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-5.5 text-xs text-muted-foreground">
        <span className="truncate">{task.providerInstanceId}</span>
        <span aria-hidden>·</span>
        <span className="truncate font-mono">{task.model + option}</span>
      </div>
      {task.error || task.progress ? (
        <p
          className={cn(
            "mt-1 truncate pl-5.5 text-xs",
            task.error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {task.error ?? task.progress}
        </p>
      ) : null}
    </div>
  );
}

export function OperatorPanel({
  tasks,
  enabled,
  available,
  onOpenSettings,
}: {
  tasks: ReadonlyArray<RuntimeOperatorTask>;
  enabled: boolean;
  available: boolean;
  onOpenSettings: () => void;
}) {
  const working = tasks.filter(
    (task) => task.status === "queued" || task.status === "running" || task.status === "waiting",
  ).length;
  const settled = tasks.length - working;

  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Workflow aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No Operator tasks yet</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          {!available
            ? "Operator is not available on this environment."
            : enabled
              ? "Ask this task to use Operator."
              : "Enable Operator in Settings."}
        </p>
        {available && !enabled ? (
          <Button size="sm" variant="outline" className="mt-2" onClick={onOpenSettings}>
            Open Settings
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 p-2">
          {tasks.map((task) => (
            <OperatorTaskRow key={task.id} task={task} />
          ))}
        </div>
      </ScrollArea>
      <footer className="flex items-center gap-2 border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
        {working > 0 ? <span className="text-info-foreground">● {working} working</span> : null}
        {settled > 0 ? <span>{settled} settled</span> : null}
      </footer>
    </div>
  );
}
