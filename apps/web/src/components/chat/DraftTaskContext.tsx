import { TaskId } from "@t3tools/contracts";
import { ListTodoIcon } from "lucide-react";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useServerConfigs } from "../../state/entities";
import { useTasks } from "../../state/tasks";
import { composerFloatingLayerProps } from "./composerEventScope";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const NO_TASK = "";

/** Draft membership is an explicit choice; selecting a task fixes its owning environment. */
export function DraftTaskContext({
  draftId,
  disabled = false,
}: {
  draftId: DraftId;
  disabled?: boolean;
}) {
  const draft = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const setContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const tasks = useTasks();
  const configs = useServerConfigs();
  const supported =
    draft && configs.get(draft.environmentId)?.environment.capabilities.tasks === true;
  if (!draft || (!supported && draft.taskId == null)) return null;
  const destinations = supported
    ? tasks.filter((task) => task.environmentId === draft.environmentId && task.archivedAt === null)
    : [];
  const unavailable =
    draft.taskId != null && !destinations.some((task) => task.id === draft.taskId);
  const items = [
    { value: NO_TASK, label: "No task" },
    ...(unavailable ? [{ value: draft.taskId!, label: "Unavailable task" }] : []),
    ...destinations.map((task) => ({ value: task.id, label: task.name })),
  ];
  return (
    <Select
      modal={false}
      disabled={disabled}
      value={draft.taskId ?? NO_TASK}
      items={items}
      onValueChange={(value) => {
        if (value === null || value === draft.taskId) return;
        if (value !== NO_TASK && !destinations.some((task) => task.id === value)) return;
        setContext(draftId, {
          taskId: value === NO_TASK ? null : TaskId.make(value),
          ...(value === NO_TASK
            ? {}
            : { environmentSelection: "manual", loadBalancedEnvironmentId: null }),
        });
      }}
    >
      <SelectTrigger
        aria-label="Task"
        title={unavailable ? "Choose another task or No task before sending." : undefined}
        variant="ghost"
        size="xs"
        className="min-w-0 shrink font-normal text-xs!"
        data-composer-context-control
      >
        <ListTodoIcon className="size-3 shrink-0" />
        <span
          data-composer-label
          className="min-w-0 max-w-40 group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block truncate group-data-[compact]/composer-context:opacity-0"
          >
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
      <SelectPopup {...composerFloatingLayerProps} align="start">
        {items.map((item) => (
          <SelectItem
            key={item.value}
            value={item.value}
            disabled={unavailable && item.value === draft.taskId}
          >
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
