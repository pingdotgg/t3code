import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedTaskRef, ThreadId } from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon, SearchIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTaskActions } from "../../hooks/useTaskActions";
import { readThreadShell, useProjects, useThreadShells } from "../../state/entities";
import { environmentShell } from "../../state/shell";
import { readTask, useTask, useTasks } from "../../state/tasks";
import { Button } from "../ui/button";
import { CommandDialog, CommandDialogPopup, CommandFooter } from "../ui/command";
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "../ui/combobox";
import {
  addSelectedThreadsToTask,
  filterTaskThreadCandidates,
  taskThreadCandidates,
} from "./AddThreadsToTask.logic";

const RESULT_LIMIT = 100;

export function AddThreadsToTaskDialog({
  taskRef,
  close,
}: {
  taskRef: ScopedTaskRef;
  close: () => void;
}) {
  const task = useTask(taskRef);
  const threads = useThreadShells();
  const projects = useProjects();
  const tasks = useTasks();
  const shell = useAtomValue(environmentShell.stateValueAtom(taskRef.environmentId));
  const { moveThreadToTask } = useTaskActions();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ThreadId[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useMemo(
    () => taskThreadCandidates(taskRef, threads, projects, tasks),
    [taskRef, threads, projects, tasks],
  );
  const byId = useMemo(() => new Map(candidates.map((item) => [item.id, item])), [candidates]);
  const candidateIds = useMemo(() => candidates.map((item) => item.id), [candidates]);
  const matches = useMemo(() => filterTaskThreadCandidates(candidates, query), [candidates, query]);
  const visibleIds = useMemo(
    () => matches.slice(0, RESULT_LIMIT).map((item) => item.id),
    [matches],
  );
  const selectedIds = selected.filter((id) => byId.has(id));
  const selectedSet = new Set(selectedIds);
  const unavailable = !task || task.archivedAt !== null || shell.status !== "live";

  const submit = async () => {
    if (busyRef.current || unavailable || selectedIds.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const remaining = await addSelectedThreadsToTask(selectedIds, async (id) => {
        const currentTask = readTask(taskRef);
        const ref = scopeThreadRef(taskRef.environmentId, id);
        const thread = readThreadShell(ref);
        if (
          !currentTask ||
          currentTask.archivedAt !== null ||
          !thread ||
          thread.archivedAt !== null
        )
          return false;
        if (thread.taskId === taskRef.taskId) return true;
        return (await moveThreadToTask(ref, taskRef.taskId))._tag === "Success";
      });
      setSelected(remaining);
      if (remaining.length === 0) close();
      else
        setError(
          "Could not add all selected threads. Completed moves are saved; retry the remaining selections.",
        );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open && !busyRef.current) close();
      }}
    >
      <CommandDialogPopup
        aria-label={`Add threads to ${task?.name ?? "task"}`}
        className="max-h-[min(36rem,80dvh)] overflow-hidden p-0"
      >
        <div className="shrink-0 px-4 pt-4 pb-2">
          <h2 className="truncate text-sm font-medium">Add threads to {task?.name ?? "task"}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose threads from this environment. Threads in another task will be moved here.
          </p>
        </div>
        <Combobox<ThreadId, true>
          multiple
          inline
          open
          onOpenChange={(open, details) => {
            if (!open) details.cancel();
          }}
          autoHighlight
          disabled={busy || unavailable}
          items={candidateIds}
          filteredItems={visibleIds}
          value={selectedIds}
          onValueChange={setSelected}
          inputValue={query}
          onInputValueChange={(value, details) => {
            // Keep the search in place when checking a result, including via Enter.
            if (details.reason === "input-clear") details.cancel();
            else setQuery(value);
          }}
          itemToStringLabel={(id) => byId.get(id)?.title ?? id}
        >
          <div className="shrink-0 px-3 pb-2">
            <ComboboxInput
              autoFocus
              aria-label="Search threads"
              placeholder="Search threads, projects, tasks, or branches…"
              showTrigger={false}
              startAddon={<SearchIcon />}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ComboboxEmpty>
              {candidates.length === 0 ? "No threads available to add." : "No matching threads."}
            </ComboboxEmpty>
            <ComboboxList className="px-2! py-1!" aria-label="Threads">
              {(id: ThreadId) => {
                const item = byId.get(id);
                if (!item) return null;
                const checked = selectedSet.has(id);
                return (
                  <ComboboxItem
                    key={id}
                    value={id}
                    className="py-2"
                    contentClassName="flex items-center gap-3"
                  >
                    <MessageSquareIcon className="size-4 text-muted-foreground" aria-hidden />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm">{item.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {[
                          item.projectName,
                          item.branch,
                          item.taskName ? `In ${item.taskName}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span
                      aria-hidden
                      className={`flex size-4 shrink-0 items-center justify-center rounded border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}
                    >
                      {checked ? <CheckIcon className="size-3! text-current!" /> : null}
                    </span>
                  </ComboboxItem>
                );
              }}
            </ComboboxList>
          </div>
        </Combobox>
        {matches.length > RESULT_LIMIT ? (
          <p className="shrink-0 px-4 py-2 text-xs text-muted-foreground">
            Showing the {RESULT_LIMIT} most recent matches. Search to narrow the list.
          </p>
        ) : null}
        {unavailable || error ? (
          <p role="alert" className="shrink-0 px-4 py-2 text-sm text-destructive">
            {unavailable
              ? "This task is unavailable. Reconnect or restore it to add threads."
              : error}
          </p>
        ) : null}
        <CommandFooter className="shrink-0">
          <span role="status">{selectedIds.length} selected</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || unavailable || selectedIds.length === 0}
              onClick={() => void submit()}
            >
              {busy ? "Adding…" : "Add to task"}
            </Button>
          </div>
        </CommandFooter>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
