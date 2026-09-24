import type { PullRequestAction, PullRequestMergeMethod } from "@t3tools/contracts";
import type { MouseEvent } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";

export type PullRequestSpeedAction = Extract<
  PullRequestAction,
  "close" | "reopen" | "merge" | "ready"
>;

/**
 * The actions a row offers while Shift is held: the ones a reader clears a list with, right on
 * the row, without opening it. Close, reopen, and ready go at once; merge asks, always, because
 * it is the one that cannot be taken back. They sit over the right end of the second line, where
 * the linked panel keeps its row menu, so the row keeps its width and nothing else moves.
 */
export function PullRequestSpeedActions({
  entry,
  shown,
  pending,
  onAct,
}: {
  entry: EnvironmentPullRequestEntry;
  /** Shift is held. */
  shown: boolean;
  /** An action of this row's is still with the host: no second one until it answers. */
  pending: boolean;
  onAct: (entry: EnvironmentPullRequestEntry, action: PullRequestSpeedAction) => void;
}) {
  if (!shown) return null;
  // Only for GitHub rows: the row does not carry what a host allows, and GitHub is the one
  // whose close, reopen and merge the page knows. The host still has the last word, and a
  // refusal takes the row's note back.
  if (entry.state === "merged" || entry.provider !== "github") return null;
  const act = (action: PullRequestSpeedAction) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onAct(entry, action);
  };
  return (
    <span className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1 rounded-md bg-background py-1 pl-6 [mask-image:linear-gradient(to_right,transparent,black_1.25rem)]">
      <span aria-hidden className="absolute inset-0 -z-10 bg-accent/60" />
      {entry.state === "open" ? (
        <>
          {/* A stacked pull request merges through its stack, where the detail decides
              whether one layer may go alone; the row offers no lone merge for it. */}
          {entry.isDraft ? (
            <Button size="xs" variant="outline" disabled={pending} onClick={act("ready")}>
              <PullRequestGlyph.draft className="size-3.5" />
              Ready for review
            </Button>
          ) : entry.stack ? null : (
            <Button size="xs" variant="outline" disabled={pending} onClick={act("merge")}>
              <PullRequestGlyph.merged className="size-3.5" />
              Merge
            </Button>
          )}
          <Button size="xs" variant="destructive-outline" disabled={pending} onClick={act("close")}>
            <PullRequestGlyph.closed className="size-3.5" />
            Close
          </Button>
        </>
      ) : (
        <Button size="xs" variant="outline" disabled={pending} onClick={act("reopen")}>
          <PullRequestGlyph.reopen className="size-3.5" />
          Reopen
        </Button>
      )}
    </span>
  );
}

/**
 * The one confirmation speed mode keeps. The strategies come from the detail read, since the
 * row does not carry what the repository allows; until it answers the buttons wait.
 */
export function PullRequestSpeedMergeDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: EnvironmentPullRequestEntry | null;
  onClose: () => void;
  onConfirm: (entry: EnvironmentPullRequestEntry, method: PullRequestMergeMethod) => void;
}) {
  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogPopup>
        {target ? <SpeedMergeBody target={target} onConfirm={onConfirm} /> : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function SpeedMergeBody({
  target,
  onConfirm,
}: {
  target: EnvironmentPullRequestEntry;
  onConfirm: (entry: EnvironmentPullRequestEntry, method: PullRequestMergeMethod) => void;
}) {
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({
      environmentId: target.environmentId,
      input: {
        projectId: target.projectId,
        repository: target.repository,
        number: target.number,
        host: target.host,
      },
    }),
  );
  const detail = detailQuery.data;
  const methods = detail
    ? detail.capabilities.mergeMethods.filter((method) => detail.mergeCapabilities[method])
    : [];
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Merge #{target.number}?</AlertDialogTitle>
        <AlertDialogDescription>
          {target.title}
          {detail && methods.length === 0 ? " This repository allows no merge strategy here." : ""}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" size="sm" />}>Cancel</AlertDialogClose>
        {detail ? (
          methods.map((method) => (
            <Button key={method} size="sm" onClick={() => onConfirm(target, method)}>
              {PULL_REQUEST_MERGE_METHOD_LABELS[method]}
            </Button>
          ))
        ) : (
          <Button size="sm" disabled>
            {detailQuery.error ? "Could not read the pull request" : "Reading…"}
          </Button>
        )}
      </AlertDialogFooter>
    </>
  );
}
