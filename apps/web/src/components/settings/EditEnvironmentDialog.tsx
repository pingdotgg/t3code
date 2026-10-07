import { useId, useRef, useState } from "react";
import { environmentCatalog } from "~/connection/catalog";
import type { EnvironmentPresentation } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function EditEnvironmentDialog({
  environment,
  onClose,
}: {
  readonly environment: EnvironmentPresentation;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [nickname, setNickname] = useState(environment.entry.nickname ?? "");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const saveNickname = useAtomCommand(environmentCatalog.setNickname, "Save environment nickname");

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await saveNickname({ environmentId: environment.environmentId, nickname });
      if (result._tag === "Success") onClose();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !savingRef.current && onClose()}>
      <DialogPopup
        showCloseButton={!saving}
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>Edit environment</DialogTitle>
          <DialogDescription>Choose how this environment appears on this device.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            <Label htmlFor={id}>Nickname</Label>
            <Input
              id={id}
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder={environment.entry.target.label}
              aria-describedby={`${id}-hint`}
              disabled={saving}
              autoComplete="off"
              autoFocus
            />
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
              Leave blank to use the inferred name, {environment.entry.target.label}.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
