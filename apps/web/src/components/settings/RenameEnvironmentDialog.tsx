import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { T, useGT } from "gt-react";

import { environmentCatalog } from "~/connection/catalog";
import { m } from "~/i18n/messages";
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
  onSaveStart,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onSaveStart: () => () => void;
}) {
  const gt = useGT();
  const [label, setLabel] = useState(currentLabel);
  const [saving, setSaving] = useState(false);
  const setEnvironmentLabel = useAtomCommand(environmentCatalog.setLabel);
  const canSave = !saving && label.trim() !== "";

  const save = async () => {
    if (!canSave) return;
    const onDone = onSaveStart();
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
        title: gt("Could not rename environment"),
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, m) ?? error.message)
            : gt("The label was not saved."),
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
        <DialogTitle>
          <T>Rename environment</T>
        </DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <div className="grid gap-1.5">
          <Label htmlFor="environment-label">
            <T>Label</T>
          </Label>
          <Input
            id="environment-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            disabled={saving}
            required
            autoFocus
          />
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="secondary" />}>
          <T>Cancel</T>
        </DialogClose>
        <Button type="submit" disabled={!canSave}>
          {saving ? gt("Saving…") : gt("Save")}
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
  const openingRef = useRef(0);
  const handleOpenChange = (nextOpen: boolean) => {
    openingRef.current += 1;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-md">
        <RenameEnvironmentForm
          environmentId={environmentId}
          label={label}
          onSaveStart={() => {
            const opening = openingRef.current;
            return () => {
              if (openingRef.current === opening) handleOpenChange(false);
            };
          }}
        />
      </DialogPopup>
    </Dialog>
  );
}
