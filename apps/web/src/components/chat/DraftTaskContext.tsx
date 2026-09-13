import { TaskId } from "@t3tools/contracts";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useTasks } from "../../state/tasks";

/** Keeps unavailable task drafts editable and makes changing membership explicit. */
export function DraftTaskContext({ draftId }: { draftId: DraftId }) {
  const draft = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const setContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const tasks = useTasks();
  if (draft?.taskId == null) return null;
  const destinations = tasks.filter(
    (task) => task.environmentId === draft.environmentId && task.archivedAt === null,
  );
  const parent = destinations.find((task) => task.id === draft.taskId);
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <span>
        {parent
          ? "Task threads stay on this environment."
          : "Task unavailable. Choose another task or remove it before sending."}
      </span>
      <select
        aria-label="Draft task"
        className="min-w-0 max-w-48 rounded border bg-background px-2 py-1 text-foreground"
        value={draft.taskId}
        onChange={(event) => setContext(draftId, { taskId: TaskId.make(event.target.value) })}
      >
        {!parent ? <option value={draft.taskId}>Unavailable task</option> : null}
        {destinations.map((task) => (
          <option key={task.id} value={task.id}>
            {task.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="underline underline-offset-2 hover:text-foreground"
        onClick={() => setContext(draftId, { taskId: null })}
      >
        Remove from task
      </button>
    </div>
  );
}
