import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TaskDocumentId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
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
import {
  readTaskUpdateInstructionsPath,
  taskDocumentEnvironment,
  writeTaskUpdateInstructionsPath,
} from "~/state/taskDocuments";
import { useAtomCommand } from "~/state/use-atom-command";

/** Paths are typed because they belong to the environment's machine, not this client's. */
export function TaskImportDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly mode: "import" | "instructions";
  readonly onClose: () => void;
  readonly onImported?: (taskDocumentId: TaskDocumentId) => void;
}) {
  const importing = props.mode === "import";
  const register = useAtomCommand(taskDocumentEnvironment.register, { reportFailure: false });
  const [path, setPath] = useState("");
  const [instructions, setInstructions] = useState(
    () => readTaskUpdateInstructionsPath(props.environmentId) ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    writeTaskUpdateInstructionsPath(props.environmentId, instructions);
    if (!importing) {
      props.onClose();
      return;
    }
    setBusy(true);
    const result = await register({
      environmentId: props.environmentId,
      input: { path: path.trim() },
    });
    setBusy(false);
    if (result._tag === "Success") {
      props.onImported?.(result.value.summary.taskDocumentId);
      props.onClose();
      return;
    }
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "Could not import this file.");
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
            <DialogTitle>{importing ? "Import task file" : "Update instructions file"}</DialogTitle>
            <DialogDescription>
              {importing
                ? "The Markdown file stays where it is and is not changed."
                : "New task threads read this file before they edit a task."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              {importing ? (
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
              ) : null}
              <label className="flex flex-col gap-1 text-sm">
                Update instructions file path
                <Input
                  autoFocus={!importing}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
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
            <Button type="submit" disabled={busy || (importing && path.trim() === "")}>
              {importing ? "Import" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
