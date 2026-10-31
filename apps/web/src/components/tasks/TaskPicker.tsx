import type { EnvironmentId, TaskDocumentId } from "@t3tools/contracts";
import { ListChecksIcon } from "lucide-react";
import { useState } from "react";

import { ComposerControl } from "~/components/chat/ComposerControl";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";

import { TaskImportDialog } from "./TaskImportDialog";
import { useTaskCatalogue } from "./useTaskDocuments";

const NO_TASK = "none";

/** The new-thread strip's task choice, independent of the project and workspace beside it. */
export function TaskPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly draftId: DraftId;
  readonly taskDocumentId: TaskDocumentId | null;
}) {
  const { available, canRegister, tasks } = useTaskCatalogue(props.environmentId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const [dialog, setDialog] = useState<"import" | "instructions" | null>(null);
  if (!available) return null;
  const select = (taskDocumentId: TaskDocumentId | null) =>
    setDraftThreadContext(props.draftId, { taskDocumentId });
  const selected = tasks.find((task) => task.taskDocumentId === props.taskDocumentId);
  const label = props.taskDocumentId === null ? "None" : (selected?.title ?? "Selected");
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <ComposerControl
              size="xs"
              className="min-w-0 max-w-48 shrink"
              aria-label={`Task: ${label}`}
              data-composer-context-control
            />
          }
        >
          <ListChecksIcon />
          <span className="truncate" data-composer-control-label>
            Task: {label}
          </span>
        </MenuTrigger>
        <MenuPopup align="start" className="max-w-80">
          <MenuRadioGroup
            value={props.taskDocumentId ?? NO_TASK}
            onValueChange={(value) => select(value === NO_TASK ? null : (value as TaskDocumentId))}
          >
            <MenuRadioItem value={NO_TASK} closeOnClick>
              None
            </MenuRadioItem>
            {tasks.map((task) => (
              <MenuRadioItem
                key={task.taskDocumentId}
                value={task.taskDocumentId}
                closeOnClick
                disabled={task.availability !== "available"}
              >
                <span className="truncate">{task.title}</span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          {canRegister ? (
            <MenuItem onClick={() => setDialog("import")}>Import task file…</MenuItem>
          ) : null}
          <MenuItem disabled>Create new task (not available yet)</MenuItem>
          <MenuItem onClick={() => setDialog("instructions")}>Update instructions file…</MenuItem>
        </MenuPopup>
      </Menu>
      {dialog ? (
        <TaskImportDialog
          environmentId={props.environmentId}
          mode={dialog}
          onClose={() => setDialog(null)}
          onImported={select}
        />
      ) : null}
    </>
  );
}
