import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { stackedThreadToast, toastManager } from "../ui/toast";

// The popup unmounts when closed, so each open starts from the current label.
function RenameEnvironmentForm({
  environmentId,
  label: currentLabel,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onDone: () => void;
}) {
  const [label, setLabel] = useState(currentLabel);
  const [saving, setSaving] = useState(false);
  const setEnvironmentLabel = useAtomCommand(environmentCatalog.setLabel, "Rename environment");
  const canSave = !saving && label.trim() !== "";

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const result = await setEnvironmentLabel({ environmentId, label });
    setSaving(false);
    if (result._tag === "Success") {
      onDone();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not rename environment",
        description: error instanceof Error ? error.message : "The label was not saved.",
      }),
    );
  };

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename environment</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-1.5">
          <Label htmlFor="environment-label">Label</Label>
          <Input
            id="environment-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            disabled={saving}
            autoFocus
          />
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RenameEnvironmentDialog({
  open,
  onOpenChange,
  environmentId,
  label,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <RenameEnvironmentForm
          environmentId={environmentId}
          label={label}
          onDone={() => onOpenChange(false)}
        />
      </DialogPopup>
    </Dialog>
  );
}
