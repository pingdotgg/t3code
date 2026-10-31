import type { EnvironmentId, TaskDocumentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useNewTaskStore, type NewTaskPlan } from "~/newTaskStore";
import { readTaskFolder, taskDocumentEnvironment, writeTaskFolder } from "~/state/taskDocuments";
import { useAtomCommand } from "~/state/use-atom-command";

/** Only plans the task; the file is made when the thread is sent, so cancelling a draft leaves nothing behind. */
export function TaskCreateDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly taskDocumentId: TaskDocumentId;
  readonly initial?: NewTaskPlan | undefined;
  readonly onClose: () => void;
  readonly onPlanned: (taskDocumentId: TaskDocumentId) => void;
}) {
  const plan = useNewTaskStore((store) => store.plan);
  const existing = props.initial;
  const defaultFolder = useAtomCommand(taskDocumentEnvironment.defaultFolder, {
    reportFailure: false,
  });
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [folder, setFolder] = useState(() =>
    existing ? (existing.directory ?? "") : (readTaskFolder(props.environmentId) ?? ""),
  );
  const [enrich, setEnrich] = useState(existing?.enrich ?? true);
  const [managedFolder, setManagedFolder] = useState<string | null>(null);

  const fetchManagedFolder = useEffectEvent((environmentId: EnvironmentId) =>
    defaultFolder({ environmentId, input: {} }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- only the environment's server knows where its managed task folder is
  useEffect(() => {
    let current = true;
    void fetchManagedFolder(props.environmentId).then((result) => {
      if (current && result._tag === "Success") setManagedFolder(result.value.directory);
    });
    return () => {
      current = false;
    };
  }, [props.environmentId]);

  const destination = folder.trim() || managedFolder;
  const submit = () => {
    const next: NewTaskPlan = {
      title: title.trim(),
      description: description.trim(),
      directory: folder.trim() || null,
      enrich,
    };
    writeTaskFolder(props.environmentId, folder);
    plan(props.taskDocumentId, next);
    props.onPlanned(props.taskDocumentId);
    props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create new task</DialogTitle>
            <DialogDescription>
              The task file is created when you send this thread, and nothing is written before
              then.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                Title
                <Input
                  autoFocus
                  maxLength={200}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Description
                <Textarea
                  maxLength={20_000}
                  value={description}
                  placeholder="Kept word for word in the task file"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Folder
                <Input
                  value={folder}
                  placeholder={managedFolder ?? "Managed folder"}
                  onChange={(event) => setFolder(event.target.value)}
                />
                <span className="text-muted-foreground text-xs">
                  Creates the file in {destination ?? "the environment's managed folder"}
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={enrich} onCheckedChange={(checked) => setEnrich(checked)} />
                Let this first thread enrich the task
              </label>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={title.trim() === ""}>
              Use new task
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
