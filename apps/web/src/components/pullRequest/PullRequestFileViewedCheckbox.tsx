import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Checkbox } from "../ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

/** Shows the pending toggle while GitHub saves the file’s viewed state. */
export function PullRequestFileViewedCheckbox({
  environmentId,
  reference,
  path,
  viewed,
  onOptimisticChange,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  path: string;
  viewed: boolean | undefined;
  onOptimisticChange: (path: string, viewed: boolean | null) => void;
  onRefresh: () => void;
}) {
  const setFileViewed = useAtomCommand(pullRequestEnvironment.setFileViewed, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);

  const toggle = async (next: boolean) => {
    if (pending || viewed === undefined) return;
    setPending(true);
    onOptimisticChange(path, next);
    const result = await setFileViewed({
      environmentId,
      input: { ...reference, path, viewed: next },
    });
    setPending(false);
    if (result._tag === "Failure") {
      onOptimisticChange(path, null);
      toastManager.add({ type: "error", title: "Viewed status could not be saved to GitHub" });
      return;
    }
    onRefresh();
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label
            data-file-viewed-control
            className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <Checkbox
          checked={viewed === true}
          disabled={pending || viewed === undefined}
          aria-label={`Mark ${path} as viewed on GitHub`}
          onCheckedChange={(next) => void toggle(next)}
        />
        Viewed
      </TooltipTrigger>
      <TooltipPopup>Viewed on GitHub</TooltipPopup>
    </Tooltip>
  );
}
