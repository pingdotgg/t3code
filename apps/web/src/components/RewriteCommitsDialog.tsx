import { useState, type ComponentProps } from "react";
import { CommitWorkflowForm } from "./CommitWorkflowForm";
import { RewriteCommitMessagesForm } from "./RewriteCommitMessagesForm";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { Radio, RadioGroup } from "./ui/radio-group";
import type { EnvironmentId } from "@t3tools/contracts";

export function RewriteCommitsDialog(props: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string;
  readonly workflow: Omit<
    ComponentProps<typeof CommitWorkflowForm>,
    "scope" | "fileSelection" | "controls"
  > | null;
  readonly onClose: () => void;
}) {
  const [mode, setMode] = useState("messages");
  const controls = (
    <RadioGroup
      aria-label="Rewrite mode"
      value={mode}
      onValueChange={(value) => setMode(String(value))}
    >
      <label className="flex items-center gap-2 text-sm">
        <Radio value="messages" />
        Regenerate messages only
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Radio value="history" disabled={props.workflow === null} />
        Split and regroup existing commits
      </label>
    </RadioGroup>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Rewrite commits</DialogTitle>
          <DialogDescription>
            Refresh commit messages or rebuild the branch’s commit sequence. Nothing is pushed.
          </DialogDescription>
        </DialogHeader>
        {mode === "messages" ? (
          <RewriteCommitMessagesForm
            environmentId={props.environmentId}
            cwd={props.cwd}
            onOpenChange={(open) => {
              if (!open) props.onClose();
            }}
            controls={controls}
          />
        ) : props.workflow ? (
          <CommitWorkflowForm {...props.workflow} scope="branch" controls={controls} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
