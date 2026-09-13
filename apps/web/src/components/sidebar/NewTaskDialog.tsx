import { randomUUID } from "../../lib/utils";
import { scopeTaskRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import { CommandId, TaskId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useTaskActions } from "../../hooks/useTaskActions";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { readTask, waitForTask } from "../../state/tasks";
import { useTaskDialogStore } from "../../taskDialogStore";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/** Task dialogs share one layout-owned request so sidebar actions work on any route. */
export function NewTaskDialog() {
  const request = useTaskDialogStore((state) => state.request);
  const close = useTaskDialogStore((state) => state.close);
  return request ? (
    <TaskDialogForm
      key={request.kind + ("taskRef" in request ? request.taskRef.taskId : "")}
      request={request}
      close={close}
    />
  ) : null;
}

function TaskDialogForm({
  request,
  close,
}: {
  request: NonNullable<ReturnType<typeof useTaskDialogStore.getState>["request"]>;
  close: () => void;
}) {
  const projects = useProjects();
  const configs = useServerConfigs();
  const { environments } = useEnvironments();
  const actions = useTaskActions();
  const task = "taskRef" in request ? readTask(request.taskRef) : null;
  const [name, setName] = useState(task?.name ?? "");
  const [description, setDescription] = useState("");
  const [projectKey, setProjectKey] = useState(
    request.kind === "create" && request.projectRef ? scopedProjectKey(request.projectRef) : "",
  );
  const [busy, setBusy] = useState(false);
  const [inputLocked, setInputLocked] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // A retry after a lost receipt must address the same aggregate and command.
  const [submission] = useState(() => ({
    taskId: TaskId.make(randomUUID()),
    commandId: CommandId.make(randomUUID()),
    createdAt: new Date().toISOString(),
  }));
  const frozenInput = useRef<{
    name: string;
    description: string | null;
    primaryProjectId: (typeof projects)[number]["id"];
    environmentId: (typeof projects)[number]["environmentId"];
  } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const eligible = projects.filter(
    (project) => configs.get(project.environmentId)?.environment.capabilities.tasks === true,
  );
  const project = eligible.find(
    (entry) =>
      scopedProjectKey({ environmentId: entry.environmentId, projectId: entry.id }) === projectKey,
  );
  const submit = async (threads: "keep" | "delete" = "keep") => {
    if (
      busyRef.current ||
      (request.kind !== "delete" && !name.trim()) ||
      (request.kind === "create" && !project)
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (request.kind === "create" && project) {
        const input = frozenInput.current ?? {
          name: name.trim(),
          description: description.trim() || null,
          primaryProjectId: project.id,
          environmentId: project.environmentId,
        };
        frozenInput.current = input;
        setInputLocked(true);
        const { environmentId, ...metadata } = input;
        const result = await actions.createTask({
          environmentId,
          input: { ...submission, ...metadata },
        });
        if (result._tag === "Failure") return;
        const ref = scopeTaskRef(environmentId, submission.taskId);
        await waitForTask(ref, result.value.sequence);
        if (!mounted.current) return;
        close();
        await actions.openTask(ref);
      } else if (request.kind === "rename") {
        const result = await actions.updateTaskMetadata(request.taskRef, { name: name.trim() });
        if (result._tag === "Success") close();
      } else if (request.kind === "delete") {
        const result = await actions.deleteTask(request.taskRef, threads);
        if (result._tag === "Success") close();
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error ? failure.message : "Could not complete the task action.",
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {request.kind === "create"
              ? "New task"
              : request.kind === "rename"
                ? "Rename task"
                : `Delete ${task?.name ?? "task"}?`}
          </DialogTitle>
          <DialogDescription>
            {request.kind === "delete"
              ? "Keep the threads to remove only the task, or permanently delete the task and all its threads, including archived threads."
              : "Keep related threads together with shared files, terminals and browser tabs."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {request.kind !== "delete" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-name">Name</Label>
              <Input
                id="task-name"
                autoFocus
                value={name}
                disabled={busy || inputLocked}
                onValueChange={setName}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
            </div>
          )}
          {request.kind === "create" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="task-description">Description (optional)</Label>
                <Textarea
                  id="task-description"
                  size="sm"
                  value={description}
                  disabled={busy || inputLocked}
                  onChange={(event) => setDescription(event.currentTarget.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="task-project">Primary project</Label>
                <select
                  id="task-project"
                  className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                  value={projectKey}
                  disabled={busy || inputLocked}
                  onChange={(event) => setProjectKey(event.currentTarget.value)}
                >
                  <option value="" disabled>
                    Select project
                  </option>
                  {eligible.map((entry) => {
                    const key = scopedProjectKey({
                      environmentId: entry.environmentId,
                      projectId: entry.id,
                    });
                    return (
                      <option key={key} value={key}>
                        {entry.title} ·{" "}
                        {environments.find(
                          (environment) => environment.environmentId === entry.environmentId,
                        )?.label ?? entry.environmentId}{" "}
                        · {entry.workspaceRoot}
                      </option>
                    );
                  })}
                </select>
                <span className="text-xs text-muted-foreground">
                  New threads and shared tools start here. Threads from other projects on this
                  environment can join later.
                </span>
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          {request.kind === "delete" ? (
            <>
              <Button variant="destructive" disabled={busy} onClick={() => void submit("delete")}>
                Delete threads
              </Button>
              <Button autoFocus disabled={busy} onClick={() => void submit("keep")}>
                Keep threads
              </Button>
            </>
          ) : (
            <Button
              disabled={busy || !name.trim() || (request.kind === "create" && !project)}
              onClick={() => void submit()}
            >
              {busy ? "Saving…" : request.kind === "create" ? "Create task" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
