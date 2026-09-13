import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  partitionTaskMembers,
  rollupTaskStatus,
  taskMemberStatus,
  taskShelf,
} from "@t3tools/client-runtime/state/task-grouping";
import { sortActiveThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { ProjectId, type ScopedTaskRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { GitBranchIcon, LayersIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useTaskActionMenu } from "../../hooks/useTaskActionMenu";
import { Button } from "../ui/button";
import { useTaskActions } from "../../hooks/useTaskActions";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { environmentShell } from "../../state/shell";
import { useTask } from "../../state/tasks";
import { buildThreadRouteParams } from "../../threadRoutes";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { TaskStatus } from "../sidebar/TaskCard";

function EditableMetadata({
  value,
  label,
  multiline = false,
  disabled,
  save,
}: {
  value: string;
  label: string;
  multiline?: boolean;
  disabled: boolean;
  save: (value: string) => Promise<boolean>;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const cancelled = useRef(false);
  const text = edit ?? value;
  const commit = async () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (saving.current || disabled || text === value || (!multiline && !text.trim())) return;
    saving.current = true;
    setBusy(true);
    try {
      if (await save(text)) setEdit(null);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const props = {
    "aria-label": label,
    value: text,
    disabled: disabled || busy,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setEdit(event.currentTarget.value),
    onBlur: () => {
      void commit();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        cancelled.current = true;
        setEdit(null);
        event.currentTarget.blur();
      }
      if (event.key === "Enter" && (!multiline || !event.shiftKey)) {
        event.preventDefault();
        void commit();
      }
    },
  };
  return multiline ? (
    <textarea
      {...props}
      rows={2}
      placeholder="Describe the outcome this task is about. Optional."
      className="field-sizing-content w-full resize-none rounded-md bg-transparent py-0.5 text-sm leading-relaxed text-muted-foreground outline-none focus:text-foreground"
    />
  ) : (
    <input
      {...props}
      className="w-full rounded-md bg-transparent text-2xl font-semibold tracking-tight outline-none"
    />
  );
}

/** The task page reads shells only; opening a member is the detail subscription boundary. */
export function TaskPageBody({
  taskRef,
  bottomInset = 0,
}: {
  taskRef: ScopedTaskRef;
  bottomInset?: number;
}) {
  const task = useTask(taskRef);
  const projects = useProjects();
  const threads = useThreadShells();
  const config = useServerConfigs().get(taskRef.environmentId);
  const providers = useMemo(
    () =>
      new Map(
        deriveProviderInstanceEntries(config?.providers ?? []).map((entry) => [
          entry.instanceId,
          entry,
        ]),
      ),
    [config],
  );
  const actions = useTaskActions();
  const { openMenu } = useTaskActionMenu(taskRef);
  const now = `${useNowMinute()}:00.000Z`;
  const shell = useAtomValue(environmentShell.stateValueAtom(taskRef.environmentId));
  const disabled = shell.status !== "live";
  const groups = useMemo(() => {
    const members = threads.filter(
      (thread) =>
        thread.environmentId === taskRef.environmentId && thread.taskId === taskRef.taskId,
    );
    const partition = partitionTaskMembers(members, { now });
    return {
      live: sortActiveThreadsByOrderKey(partition.live),
      snoozed: partition.snoozed.toSorted((a, b) =>
        (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? ""),
      ),
      settled: partition.settled.toSorted((a, b) =>
        (b.settledAt ?? b.updatedAt).localeCompare(a.settledAt ?? a.updatedAt),
      ),
    };
  }, [now, taskRef.environmentId, taskRef.taskId, threads]);
  if (!task) return null;
  const shelf = taskShelf(task, now);
  const primaryProject = projects.find(
    (project) =>
      project.environmentId === taskRef.environmentId && project.id === task.primaryProjectId,
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-6"
        style={{ paddingBottom: bottomInset + 24 }}
      >
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-end gap-2">
            {shelf === "snoozed" ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={disabled}
                onClick={() => {
                  void actions.unsnoozeTask(taskRef);
                }}
              >
                Wake
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              onClick={() => {
                void (shelf === "settled"
                  ? actions.unsettleTask(taskRef)
                  : actions.settleTask(taskRef));
              }}
            >
              {shelf === "settled" ? "Un-settle" : "Settle"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu({ x: rect.left, y: rect.bottom + 4 });
              }}
            >
              Task actions
            </Button>
          </div>
          {shelf === "settled" || shelf === "snoozed" ? (
            <p className="rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {shelf === "settled"
                ? "This task is settled. Starting a new thread or un-settling a member brings it back."
                : `Snoozed until ${new Date(task.snoozedUntil!).toLocaleString()}. New work or a thread that needs you wakes it early.`}
            </p>
          ) : null}
          <EditableMetadata
            key={`${task.id}:name`}
            label="Task name"
            value={task.name}
            disabled={disabled}
            save={async (name) =>
              (await actions.updateTaskMetadata(taskRef, { name: name.trim() }))._tag === "Success"
            }
          />
          <EditableMetadata
            key={`${task.id}:description`}
            label="Task description"
            value={task.description ?? ""}
            multiline
            disabled={disabled}
            save={async (description) =>
              (
                await actions.updateTaskMetadata(taskRef, {
                  description: description.trim() || null,
                })
              )._tag === "Success"
            }
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <label className="inline-flex items-center gap-1">
              {primaryProject ? (
                <ProjectFavicon project={primaryProject} className="size-3.5" />
              ) : (
                <LayersIcon className="size-3.5" />
              )}
              <select
                aria-label="Primary project"
                value={task.primaryProjectId}
                disabled={disabled}
                className="max-w-48 cursor-pointer bg-transparent outline-none"
                onChange={(event) => {
                  void actions.updateTaskMetadata(taskRef, {
                    primaryProjectId: ProjectId.make(event.currentTarget.value),
                  });
                }}
              >
                {primaryProject ? null : (
                  <option value={task.primaryProjectId} disabled>
                    Choose a primary project
                  </option>
                )}
                {projects
                  .filter((project) => project.environmentId === taskRef.environmentId)
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
              </select>
            </label>
            <span>
              {groups.live.length} live · {groups.snoozed.length} snoozed · {groups.settled.length}{" "}
              settled
            </span>
            <TaskStatus status={rollupTaskStatus(groups.live)} />
          </div>
        </header>
        <section className="flex flex-col gap-2" aria-label="Task threads">
          {Object.values(groups).every((members) => members.length === 0) ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              No threads yet. Start one below, or move existing threads here from their menu.
            </p>
          ) : null}
          {(["live", "snoozed", "settled"] as const).map((kind) =>
            groups[kind].length > 0 ? (
              <div key={kind} className="flex flex-col gap-2">
                <h3 className="pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {kind === "live" ? "Threads" : kind}
                </h3>
                {groups[kind].map((thread) => {
                  const provider = providers.get(thread.modelSelection.instanceId);
                  const project = projects.find(
                    (entry) =>
                      entry.environmentId === thread.environmentId && entry.id === thread.projectId,
                  );
                  return (
                    <Link
                      key={thread.id}
                      to="/$environmentId/$threadId"
                      params={buildThreadRouteParams(
                        scopeThreadRef(thread.environmentId, thread.id),
                      )}
                      className="flex min-w-0 items-center gap-3 rounded-lg border border-border/70 px-3 py-2 hover:bg-accent/50"
                    >
                      {project && thread.projectId !== task.primaryProjectId ? (
                        <ProjectFavicon project={project} className="size-4 shrink-0" />
                      ) : null}
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-sm font-medium">{thread.title}</span>
                        <span className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          {kind === "live" ? (
                            <TaskStatus status={taskMemberStatus(thread)} />
                          ) : (
                            <span>
                              {kind === "settled"
                                ? "Settled"
                                : `Snoozed until ${new Date(thread.snoozedUntil!).toLocaleString()}`}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            {provider ? (
                              <ProviderInstanceIcon
                                driverKind={provider.driverKind}
                                displayName={provider.displayName}
                                iconClassName="size-3"
                              />
                            ) : null}
                            {provider?.displayName ??
                              thread.session?.providerName ??
                              "Provider unavailable"}
                          </span>
                          {thread.branch ? (
                            <span className="inline-flex min-w-0 items-center gap-1">
                              <GitBranchIcon className="size-3 shrink-0" />
                              <span className="truncate">{thread.branch}</span>
                            </span>
                          ) : null}
                          {thread.pullRequests.map((pr) => (
                            <span key={pr.url}>PR #{pr.number}</span>
                          ))}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            ) : null,
          )}
        </section>
      </div>
    </div>
  );
}
