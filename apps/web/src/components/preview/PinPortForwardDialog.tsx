import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useGT, useMessages } from "gt-react";
import { useId, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { pinPortForward } from "~/state/pinnedPortForwards";
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
import { toastManager } from "../ui/toast";
import { pinnedPortMapping } from "./pinnedPortForwardCopy";

export interface PinPortForwardTarget {
  readonly environmentId: EnvironmentId;
  readonly remotePort: number;
  readonly environmentLabel: string;
}

const pinDialogTargetAtom = Atom.make<PinPortForwardTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop:pin-forward-dialog"),
);

export function openPinPortForwardDialog(target: PinPortForwardTarget): void {
  appAtomRegistry.set(pinDialogTargetAtom, target);
}

export function PinPortForwardDialogHost() {
  const target = useAtomValue(pinDialogTargetAtom);
  if (!target) return null;
  return (
    <PinPortForwardDialog
      target={target}
      onClose={() => appAtomRegistry.set(pinDialogTargetAtom, null)}
    />
  );
}

function PinPortForwardDialog(props: {
  readonly target: PinPortForwardTarget;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const formId = useId();
  const { environmentId, environmentLabel, remotePort } = props.target;
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const mapping = pinnedPortMapping(environmentLabel, remotePort, messages);

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    const name = label.trim();
    const result = await settlePromise(() =>
      pinPortForward({ environmentId, remotePort, ...(name ? { label: name } : {}) }),
    );
    setSaving(false);
    if (result._tag === "Failure") {
      setFailed(true);
      return;
    }
    toastManager.add({
      type: "success",
      title: gt("Auto-forward saved"),
      description: gt("Check Forwarded ports for its status."),
    });
    props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && props.onClose()}>
      <DialogPopup showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{gt("Always forward on this computer")}</DialogTitle>
          <DialogDescription>
            {gt("Apps on this computer can reach this port while {environment} is connected.", {
              environment: environmentLabel,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p className="text-sm font-medium text-foreground">{mapping}</p>
            <label className="grid gap-2">
              <span className="text-sm font-medium">{gt("Name (optional)")}</span>
              <Input
                value={label}
                placeholder={gt("e.g. {example}", { example: "Portless" })}
                disabled={saving}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            {failed ? (
              <p role="alert" className="text-sm text-destructive">
                {gt("Could not save the auto-forward. Try again.")}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose disabled={saving} render={<Button variant="outline" />}>
            {gt("Cancel")}
          </DialogClose>
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? gt("Saving…") : gt("Save auto-forward")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
