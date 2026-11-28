import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueCommentAudience, IssueRef } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";
import { ChevronDownIcon } from "lucide-react";
import { useRef, useState } from "react";

import { m } from "~/i18n/messages";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { readableFailure } from "../pullRequest/pullRequestDetail.logic";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { PopoverTitle } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { useWorkItemCommentForm, WorkItemCommentForm } from "../workItem/WorkItemCommentForm";
import {
  WorkItemComposerClose,
  WorkItemComposerPopover,
} from "../workItem/WorkItemComposerPopover";

/** The pull request composer's floating button and popover, with a comment on the issue in it. */
export function IssueCommentComposer({
  environmentId,
  reference,
  blocked,
  audiences,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** Why the viewer cannot comment here; null when they can. */
  blocked: string | null;
  /** Each comment is an internal note unless the viewer picks a reply to the customer. */
  audiences: boolean;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  // Internal by default: a customer reply is always an explicit choice.
  const [audience, setAudience] = useState<IssueCommentAudience>("internal");
  // Read at send: a send queued behind dictation goes out with the audience shown then.
  const latestAudience = useRef(audience);
  const changeAudience = (value: IssueCommentAudience) => {
    latestAudience.current = value;
    setAudience(value);
  };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: false });
  const title = gt("Add a comment");

  const submit = async (_action: "comment", text: string) => {
    const result = await comment({
      environmentId,
      input: {
        ...reference,
        body: text,
        ...(audiences ? { audience: latestAudience.current } : {}),
      },
    });
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

  const form = useWorkItemCommentForm({
    environmentId,
    projectId: reference.projectId,
    ownerKey: JSON.stringify(["issue-comment", environmentId, reference]),
    active: open,
    textareaRef,
    locked: blocked !== null,
    onSubmit: submit,
  });

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
        form={form}
        textareaRef={textareaRef}
        completionScope={null}
        label={gt("Add a comment")}
        placeholder={blocked ?? gt("Leave a comment")}
      >
        {audiences ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="mr-auto"
                  disabled={form.locked}
                />
              }
            >
              {audience === "internal" ? gt("Internal note") : gt("Reply to customer")}
              <ChevronDownIcon aria-hidden className="size-3" />
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuRadioGroup
                value={audience}
                onValueChange={(value: IssueCommentAudience) => changeAudience(value)}
              >
                <MenuRadioItem value="internal" closeOnClick>
                  {gt("Internal note")}
                </MenuRadioItem>
                <MenuRadioItem value="public" closeOnClick>
                  {gt("Reply to customer")}
                </MenuRadioItem>
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        ) : null}
      </WorkItemCommentForm>
    </WorkItemComposerPopover>
  );
}
