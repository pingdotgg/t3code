import { msg, useMessages } from "gt-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useRef, type ComponentProps } from "react";

import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";
import { reportGroupCommandFailure } from "./groupAvailability";
import { ModelPickerContent } from "./ModelPickerContent";

/** The existing model picker in a dialog: the model chosen takes a seat in the thread. */
export function GroupInviteDialog(
  props: Pick<
    ComponentProps<typeof ModelPickerContent>,
    "activeInstanceId" | "model" | "instanceEntries" | "modelOptionsByInstance" | "terminalOpen"
  > & {
    readonly threadRef: ScopedThreadRef | null;
    readonly onClose: () => void;
  },
) {
  const m = useMessages();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inviteToGroup = useAtomCommand(orchestrationEnvironment.inviteToGroup);
  const { threadRef, onClose, ...picker } = props;
  return (
    <Dialog open={threadRef !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup showCloseButton={false} initialFocus={searchInputRef} className="max-w-sm">
        <DialogTitle className="sr-only">{m(msg("Invite a model"))}</DialogTitle>
        <DialogDescription className="sr-only">
          {m(
            msg("The model you pick joins this thread. You can talk to everyone or to one with @."),
          )}
        </DialogDescription>
        <ModelPickerContent
          {...picker}
          environmentId={threadRef?.environmentId ?? null}
          lockedProvider={null}
          searchInputRef={searchInputRef}
          onRequestClose={onClose}
          onInstanceModelChange={(instanceId, model) => {
            if (threadRef === null) return;
            onClose();
            void inviteToGroup({
              environmentId: threadRef.environmentId,
              input: {
                threadId: threadRef.threadId,
                modelSelection: createModelSelection(instanceId, model),
              },
            }).then((result) =>
              reportGroupCommandFailure(m(msg("Could not invite that model")), result),
            );
          }}
        />
      </DialogPopup>
    </Dialog>
  );
}
