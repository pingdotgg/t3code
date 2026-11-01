import type { EnvironmentId, TaskDocumentSummary } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { PinIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { useEnvironments } from "~/state/environments";

import { TaskImportDialog } from "./TaskImportDialog";
import { useTaskCatalogue } from "./useTaskDocuments";

function compareTaskTitle(a: TaskDocumentSummary, b: TaskDocumentSummary) {
  return (
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
    a.title.localeCompare(b.title)
  );
}

function taskGroups(tasks: ReadonlyArray<TaskDocumentSummary>) {
  const pinned = tasks.filter((task) => task.pinned).toSorted(compareTaskTitle);
  const byState = new Map<string | null, TaskDocumentSummary[]>();
  for (const task of tasks) {
    if (task.pinned) continue;
    const state = task.state?.trim() ? task.state : null;
    const group = byState.get(state) ?? [];
    group.push(task);
    byState.set(state, group);
  }
  const states = [...byState.entries()].sort(([a], [b]) =>
    a === null
      ? b === null
        ? 0
        : 1
      : b === null
        ? -1
        : a.localeCompare(b, undefined, { sensitivity: "base" }) || a.localeCompare(b),
  );
  return [
    ...(pinned.length === 0
      ? []
      : [{ key: "pinned", label: "Pinned", pinned: true, tasks: pinned }]),
    ...states.map(([state, stateTasks]) => ({
      key: state === null ? "no-state" : `state:${state}`,
      label: state ?? "No state",
      pinned: false,
      tasks: stateTasks.toSorted(compareTaskTitle),
    })),
  ];
}

function availabilityLabel(task: TaskDocumentSummary) {
  switch (task.availability) {
    case "available":
      return null;
    case "identity-changed":
      return "Needs relink";
    case "missing":
      return "Missing";
    case "unavailable":
      return "Unavailable";
    case "unregistered":
      return "Not registered";
  }
}

function EnvironmentTasks(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const { available, canRegister, tasks } = useTaskCatalogue(environmentId);
  const navigate = useNavigate();
  const [importing, setImporting] = useState(false);
  if (!available) return null;
  const groups = taskGroups(tasks);
  return (
    <section aria-label={props.label ? `Tasks on ${props.label}` : "Tasks"} className="px-2 pb-1">
      <div className="flex h-7 items-center justify-between">
        <h3 className="truncate text-muted-foreground text-xs">
          {props.label ? `Tasks · ${props.label}` : "Tasks"}
        </h3>
        {canRegister ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Import task file"
            title="Import task file"
            onClick={() => setImporting(true)}
          >
            <PlusIcon />
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-1">
        {groups.map((group) => (
          <li key={group.key}>
            <h4 className="flex h-6 items-center gap-1.5 px-2 text-muted-foreground text-xs">
              {group.pinned ? <PinIcon className="size-3" /> : null}
              <span className="truncate">{group.label}</span>
            </h4>
            <ul className="flex flex-col gap-px">
              {group.tasks.map((task) => {
                const availability = availabilityLabel(task);
                const detail = [group.pinned ? task.state : null, availability]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li key={task.taskDocumentId}>
                    <Link
                      to="/task/$environmentId/$taskDocumentId"
                      params={{ environmentId, taskDocumentId: task.taskDocumentId }}
                      title={task.canonicalPath}
                      className="flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent data-[status=active]:bg-accent"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{task.title}</span>
                        {detail ? (
                          <span className="block truncate text-muted-foreground text-xs">
                            {detail}
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {importing ? (
        <TaskImportDialog
          environmentId={environmentId}
          mode="import"
          onClose={() => setImporting(false)}
          onImported={(taskDocumentId) =>
            void navigate({
              to: "/task/$environmentId/$taskDocumentId",
              params: { environmentId, taskDocumentId },
            })
          }
        />
      ) : null}
    </section>
  );
}

export function TasksSidebarSection() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map((environment) => (
        <EnvironmentTasks
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environments.length > 1 ? environment.entry.target.label : null}
        />
      ))}
    </>
  );
}
