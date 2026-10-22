import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestDetail, PullRequestRef } from "@t3tools/contracts";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestDetailTitleRow } from "./PullRequestDetailLayout";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { readableFailure } from "./pullRequestDetail.logic";
import { canEditPullRequestChangeRequest } from "./pullRequestEditing.logic";

/** The pull request title, which the reader can rename in place when the host allows it. */
export function PullRequestTitleEditor({
  environmentId,
  reference,
  pullRequestKey,
  detail,
  canWriteSourceControl,
  onSaved,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  pullRequestKey: string;
  detail: PullRequestDetail;
  canWriteSourceControl: boolean;
  onSaved: () => void;
}) {
  const update = useAtomCommand(pullRequestEnvironment.update, { reportFailure: false });
  const [titleScope, setTitleScope] = useState<{
    readonly pullRequestKey: string;
    readonly text: string;
  } | null>(null);
  const titleDraft = titleScope?.pullRequestKey === pullRequestKey ? titleScope.text : null;
  const [titleSaving, setTitleSaving] = useState(false);

  const saveTitle = async (next: string) => {
    const title = next.trim();
    if (!canWriteSourceControl || titleSaving) return;
    if (title.length === 0 || title === detail.title) {
      setTitleScope(null);
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
    setTitleScope(null);
    onSaved();
  };

  if (titleDraft === null) {
    return (
      <PullRequestDetailTitleRow className="group gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <h1 className="min-w-0 flex-1 truncate text-base font-semibold leading-snug">
                {detail.title}
              </h1>
            }
          />
          <TooltipPopup side="top">{detail.title}</TooltipPopup>
        </Tooltip>
        {canEditPullRequestChangeRequest(detail) ? (
          <PullRequestEditButton
            reason={detail.viewerPermissions.deniedActions?.edit}
            aria-label="Edit title"
            onClick={() => setTitleScope({ pullRequestKey, text: detail.title })}
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
        aria-label="Pull request title"
        onChange={(event) => setTitleScope({ pullRequestKey, text: event.target.value })}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void saveTitle(titleDraft);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setTitleScope(null);
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={titleSaving}
          onClick={() => setTitleScope(null)}
        >
          Cancel
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!canWriteSourceControl || titleSaving || titleDraft.trim().length === 0}
          onClick={() => void saveTitle(titleDraft)}
        >
          {titleSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
