import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/** Asks for a vault name; Electron has no window.prompt. */
export function NameVaultDialog({
  title,
  description,
  initialName = "",
  onDone,
}: {
  readonly title: string;
  readonly description: string;
  readonly initialName?: string;
  readonly onDone: (name: string | null) => void;
}) {
  const [name, setName] = useState(initialName);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onDone(null))}>
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() !== "") onDone(name.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Vault name"
              autoFocus
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="My Web Application"
              value={name}
            />
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => onDone(null)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={name.trim() === ""} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
