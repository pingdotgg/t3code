import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { useEnvironments } from "~/state/environments";

import { TaskImportDialog } from "./TaskImportDialog";
import { useTaskCatalogue } from "./useTaskDocuments";

function EnvironmentTasks(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const { available, canRegister, tasks } = useTaskCatalogue(environmentId);
  const navigate = useNavigate();
  const [importing, setImporting] = useState(false);
  if (!available) return null;
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
      <ul className="flex flex-col gap-px">
        {tasks.map((task) => (
          <li key={task.taskDocumentId}>
            <Link
              to="/task/$environmentId/$taskDocumentId"
              params={{ environmentId, taskDocumentId: task.taskDocumentId }}
              title={task.canonicalPath}
              className="flex h-7 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent data-[status=active]:bg-accent"
            >
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              {task.availability !== "available" ? (
                <span className="shrink-0 text-muted-foreground text-xs">{task.availability}</span>
              ) : null}
            </Link>
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
