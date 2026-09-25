import type { EnvironmentId } from "@t3tools/contracts";
import { PencilIcon } from "lucide-react";
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

interface RenamableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function RenameEnvironmentDialog({
  environment,
  isSaving,
  onClose,
  onRename,
}: {
  readonly environment: RenamableEnvironment;
  readonly isSaving: boolean;
  readonly onClose: () => void;
  readonly onRename: (environmentId: EnvironmentId, label: string | null) => Promise<boolean>;
}) {
  const [label, setLabel] = useState(environment.label);
  const submit = async () => {
    if (await onRename(environment.environmentId, label)) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>This environment's name</DialogTitle>
          <DialogDescription>
            This name will appear on devices signed into your T3 Connect account.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter" && label.trim() !== "") {
                  event.preventDefault();
                  void submit();
                }
              }}
              disabled={isSaving}
              autoFocus
              maxLength={80}
            />
          </label>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="ghost"
            disabled={isSaving}
            onClick={() =>
              void onRename(environment.environmentId, null).then((ok) => ok && onClose())
            }
          >
            Restore default name
          </Button>
          <Button variant="outline" disabled={isSaving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={isSaving || label.trim() === ""} onClick={() => void submit()}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function PrimaryEnvironmentRenameControl({
  environment,
  isSaving,
  onRename,
}: {
  readonly environment: RenamableEnvironment | null;
  readonly isSaving: boolean;
  readonly onRename: (environmentId: EnvironmentId, label: string | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost-muted"
        size="xs"
        disabled={environment === null || isSaving}
        title={
          environment === null
            ? "Link this environment to T3 Connect to rename it for all devices."
            : undefined
        }
        onClick={() => setOpen(true)}
      >
        <PencilIcon className="size-3" />
        Edit name
      </Button>
      {open && environment !== null ? (
        <RenameEnvironmentDialog
          environment={environment}
          isSaving={isSaving}
          onClose={() => setOpen(false)}
          onRename={onRename}
        />
      ) : null}
    </>
  );
}
