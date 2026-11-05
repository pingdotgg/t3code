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
  const setEnvironmentLabel = useAtomCommand(environmentCatalog.setLabel, "Rename environment");
  const canSave = label.trim() !== "";

  const save = async () => {
    if (!canSave) return;
    const result = await setEnvironmentLabel({ environmentId, label });
    if (result._tag === "Success") onDone();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename environment</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <form
          id="rename-environment-form"
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Label htmlFor="environment-label">Label</Label>
          <Input
            id="environment-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            autoFocus
          />
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" form="rename-environment-form" disabled={!canSave}>
          Save
        </Button>
      </DialogFooter>
    </>
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
