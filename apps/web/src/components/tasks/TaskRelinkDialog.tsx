import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  TaskDocumentError,
  type EnvironmentId,
  type OpenTaskDocument,
  type TaskDocumentSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

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
import { taskDocumentEnvironment } from "~/state/taskDocuments";
import { useAtomCommand } from "~/state/use-atom-command";

const isTaskDocumentError = Schema.is(TaskDocumentError);

function describeFailure(failure: unknown) {
  if (!isTaskDocumentError(failure))
    return failure instanceof Error ? failure.message : "Could not relink this task file.";
  switch (failure.reason) {
    case "identity-changed":
      return "This file has a different task ID. Confirm reconciliation to keep these threads attached.";
    case "duplicate-id":
      return "Another registered task already uses this task ID.";
    case "duplicate-path":
      return "This file is already linked to another task.";
    case "missing":
      return "The selected file could not be found on this environment.";
    default:
      return failure.message;
  }
}

export function TaskRelinkDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly task: TaskDocumentSummary;
  readonly onRelink: (document: OpenTaskDocument) => void;
  readonly onClose: () => void;
}) {
  const relink = useAtomCommand(taskDocumentEnvironment.relink, { reportFailure: false });
  const [path, setPath] = useState("");
  const [reconcileIdentity, setReconcileIdentity] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const result = await relink({
      environmentId: props.environmentId,
      input: {
        taskDocumentId: props.task.taskDocumentId,
        locatorVersion: props.task.locatorVersion,
        path: path.trim(),
        reconcileIdentity,
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      props.onRelink(result.value);
      props.onClose();
      return;
    }
    setError(describeFailure(squashAtomCommandFailure(result)));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Relink task file</DialogTitle>
            <DialogDescription>
              Choose the task file on this environment. Existing task threads stay attached.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                Task file path
                <Input
                  autoFocus
                  value={path}
                  placeholder="C:\Tasks\my-task.md"
                  onChange={(event) => {
                    setPath(event.target.value);
                    setError(null);
                  }}
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={reconcileIdentity}
                  onCheckedChange={(checked) => setReconcileIdentity(checked === true)}
                />
                <span>
                  Reconcile a different task ID
                  <span className="mt-1 block text-muted-foreground text-xs">
                    If the selected file has another ID, adopt it while keeping this task's threads.
                  </span>
                </span>
              </label>
              {error ? (
                <p role="alert" className="text-destructive-foreground text-sm">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || path.trim() === ""}>
              {busy ? "Relinking…" : "Relink"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
