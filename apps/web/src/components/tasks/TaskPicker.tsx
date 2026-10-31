import { TaskDocumentId, type EnvironmentId } from "@t3tools/contracts";
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
import { randomUUID } from "~/lib/utils";
import { useNewTaskStore } from "~/newTaskStore";

import { TaskCreateDialog } from "./TaskCreateDialog";
import { TaskImportDialog } from "./TaskImportDialog";
import { useTaskCatalogue } from "./useTaskDocuments";

const NO_TASK = "none";

/** The new-thread strip's task choice, independent of the project and workspace beside it. */
export function TaskPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly draftId: DraftId;
  readonly taskDocumentId: TaskDocumentId | null;
}) {
  const { available, canCreate, canRegister, tasks } = useTaskCatalogue(props.environmentId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const planned = useNewTaskStore((store) =>
    props.taskDocumentId === null ? undefined : store.byId[props.taskDocumentId],
  );
  const forgetPlan = useNewTaskStore((store) => store.forget);
  const [dialog, setDialog] = useState<"import" | "instructions" | "create" | null>(null);
  // Every dialog gets a fresh id: a send may already have made the file for the old one, and create is idempotent per id.
  const [mintedId, setMintedId] = useState(() => TaskDocumentId.make(randomUUID()));
  if (!available) return null;
  const select = (taskDocumentId: TaskDocumentId | null) => {
    if (props.taskDocumentId !== null && props.taskDocumentId !== taskDocumentId)
      forgetPlan(props.taskDocumentId);
    setDraftThreadContext(props.draftId, { taskDocumentId });
  };
  const selected = tasks.find((task) => task.taskDocumentId === props.taskDocumentId);
  const label =
    props.taskDocumentId === null
      ? "None"
      : planned
        ? `New: ${planned.title}`
        : (selected?.title ?? "Selected");
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
            {planned && props.taskDocumentId !== null ? (
              <MenuRadioItem value={props.taskDocumentId} closeOnClick>
                <span className="truncate">New: {planned.title}</span>
              </MenuRadioItem>
            ) : null}
            {tasks
              .filter((task) => !planned || task.taskDocumentId !== props.taskDocumentId)
              .map((task) => (
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
          {canCreate ? (
            <MenuItem
              onClick={() => {
                setMintedId(TaskDocumentId.make(randomUUID()));
                setDialog("create");
              }}
            >
              Create new task…
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => setDialog("instructions")}>Update instructions file…</MenuItem>
        </MenuPopup>
      </Menu>
      {dialog === "create" ? (
        <TaskCreateDialog
          environmentId={props.environmentId}
          taskDocumentId={mintedId}
          initial={planned}
          onClose={() => setDialog(null)}
          onPlanned={select}
        />
      ) : null}
      {dialog === "import" || dialog === "instructions" ? (
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
