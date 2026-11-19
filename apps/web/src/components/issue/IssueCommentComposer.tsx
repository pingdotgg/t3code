import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueRef } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { useRef, useState } from "react";

import { m } from "~/i18n/messages";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { PopoverTitle } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { WorkItemCommentForm } from "../workItem/WorkItemCommentForm";
import {
  WorkItemComposerClose,
  WorkItemComposerPopover,
} from "../workItem/WorkItemComposerPopover";

/** The pull request composer's floating button and popover, with a comment on the issue in it. */
export function IssueCommentComposer({
  environmentId,
  reference,
  blocked,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** Why the viewer cannot comment here; null when they can. */
  blocked: string | null;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });
  const title = gt("Add a comment");

  const submit = async (_action: "comment", text: string) => {
    const result = await comment({ environmentId, input: { ...reference, body: text } });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("The comment could not be posted")),
        description: readableFailure(
          squashAtomCommandFailure(result),
          m(msg("The tracker refused it.")),
        ),
      });
      return false;
    }
    setOpen(false);
    return true;
  };

  return (
    <WorkItemComposerPopover
      open={open}
      onOpenChange={setOpen}
      triggerLabel={title}
      popupLabel={title}
      initialFocus={textareaRef}
      header={
        <div className="mb-3 flex items-center justify-between gap-2">
          <PopoverTitle>{title}</PopoverTitle>
          <WorkItemComposerClose />
        </div>
      }
    >
      <WorkItemCommentForm
        environmentId={environmentId}
        projectId={reference.projectId}
        ownerKey={JSON.stringify(["issue-comment", environmentId, reference])}
        active={open}
        textareaRef={textareaRef}
        completionScope={null}
        label={gt("Add a comment")}
        placeholder={blocked ?? gt("Leave a comment")}
        locked={blocked !== null}
        onSubmit={submit}
      />
    </WorkItemComposerPopover>
  );
}
