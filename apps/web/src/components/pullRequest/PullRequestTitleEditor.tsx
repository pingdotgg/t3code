import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestDetail, PullRequestRef } from "@t3tools/contracts";
import { useState } from "react";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestDetailTitleRow } from "./PullRequestDetailLayout";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { readableFailure } from "./pullRequestDetail.logic";
import { canEditPullRequestChangeRequest } from "@t3tools/client-runtime/pull-request-editing";

/** The pull request title, which the reader can rename in place when the host allows it. */
export function PullRequestTitleEditor({
  environmentId,
  reference,
  detail,
  canWriteSourceControl,
  onSaved,
  value: titleDraft,
  onValueChange,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetail;
  canWriteSourceControl: boolean;
  onSaved: () => void;
  value: string | null;
  onValueChange: (value: string | null) => void;
}) {
  const update = useAtomCommand(pullRequestEnvironment.update, { reportFailure: false });
  const [titleSaving, setTitleSaving] = useState(false);

  const saveTitle = async (next: string) => {
    const title = next.trim();
    if (!canWriteSourceControl || titleSaving) return;
    if (title.length === 0 || title === detail.title) {
      onValueChange(null);
      return;
    }
    setTitleSaving(true);
    const result = await update({ environmentId, input: { ...reference, title } });
    setTitleSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "The title could not be saved",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused the new title.",
        ),
      });
      return;
    }
    onValueChange(null);
    onSaved();
  };

  if (titleDraft === null) {
    return (
      <PullRequestDetailTitleRow className="group gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <h1 className="min-w-0 flex-1 truncate text-title leading-snug text-foreground [--type-title:1rem]">
                {detail.title}
              </h1>
            }
          />
          <TooltipPopup side="top">{detail.title}</TooltipPopup>
        </Tooltip>
        {canEditPullRequestChangeRequest(detail) ? (
          <PullRequestEditButton
            aria-label="Edit title"
            onClick={() => onValueChange(detail.title)}
          />
        ) : null}
      </PullRequestDetailTitleRow>
    );
  }
  return (
    <div className="space-y-2">
      <Input
        autoFocus
        size="sm"
        disabled={titleSaving}
        value={titleDraft}
        aria-label={`${capitalizeTerm(sourceControlClients.get(detail.provider).changeRequest.singular)} title`}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void saveTitle(titleDraft);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onValueChange(null);
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={titleSaving}
          onClick={() => onValueChange(null)}
        >
          Cancel
        </Button>
        <Button
          size="xs"
          variant="secondary"
          disabled={!canWriteSourceControl || titleSaving || titleDraft.trim().length === 0}
          onClick={() => void saveTitle(titleDraft)}
        >
          {titleSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
