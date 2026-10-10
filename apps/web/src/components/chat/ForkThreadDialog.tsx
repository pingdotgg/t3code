import { GitForkIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { threadForkWorkspaceChoices } from "@t3tools/client-runtime/state/thread-workflows";
import type { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "@t3tools/contracts";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function ForkThreadDialog(props: {
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly isGitRepo: boolean;
  readonly onClose: () => void;
  readonly onSelect: (workspace: OrchestrationV2ThreadLaunchWorkspaceStrategy) => Promise<void>;
}) {
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const busy = selectedChoice !== null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Fork thread from here</DialogTitle>
          <DialogDescription>Choose where to continue from this response.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-1">
            {threadForkWorkspaceChoices(props).map((choice) => (
              <Button
                key={choice.id}
                variant="ghost"
                size="choice"
                disabled={busy}
                onClick={() => {
                  setSelectedChoice(choice.id);
                  void props
                    .onSelect(choice.workspaceStrategy)
                    .finally(() => setSelectedChoice(null));
                }}
              >
                {selectedChoice === choice.id ? <LoaderCircleIcon /> : <GitForkIcon />}
                <span className="flex flex-col gap-1 text-left">
                  <span>
                    {selectedChoice === choice.id
                      ? choice.id === "worktree"
                        ? "Preparing worktree…"
                        : "Creating fork…"
                      : choice.label}
                  </span>
                  <span className="text-sm font-normal text-muted-foreground">
                    {choice.description}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
