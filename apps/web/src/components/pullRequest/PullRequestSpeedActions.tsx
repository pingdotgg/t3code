import type { PullRequestAction } from "@t3tools/contracts";
import { useUiStateStore } from "~/uiStateStore";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolvePullRequestMergeMethod } from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import {
  usePullRequestActionRunner,
  usePullRequestDefaultMergeMethodResolver,
} from "./usePullRequestActions";

type PullRequestSpeedActionEntry = Pick<
  EnvironmentPullRequestEntry,
  "environmentId" | "projectId" | "host" | "repository" | "number" | "state" | "isDraft"
> & { readonly stack?: object | undefined };

export interface PullRequestSpeedActionResult<Entry = EnvironmentPullRequestEntry> {
  readonly entry: Entry;
  readonly action: PullRequestAction;
}

/** No detail or stack reads until a merge is clicked, even on a long list. */
export function PullRequestSpeedActions<Entry extends PullRequestSpeedActionEntry>({
  entry,
  visible,
  onActed,
  closing = false,
  sweeping = false,
  onCloseSweepStart,
}: {
  entry: Entry;
  visible: boolean;
  onActed?: (result: PullRequestSpeedActionResult<Entry>) => void;
  closing?: boolean;
  sweeping?: boolean;
  onCloseSweepStart?: (entry: Entry, event: PointerEvent) => void;
}) {
  const resolveProjectDefault = usePullRequestDefaultMergeMethodResolver(
    entry.environmentId,
    entry.projectId,
  );
  const reference = {
    projectId: entry.projectId,
    host: entry.host,
    repository: entry.repository,
    number: entry.number,
  };
  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId: entry.environmentId,
    reference,
    onSuccess: (action) => onActed?.({ entry, action }),
    resolveMergeMethod: (detail) => {
      const allowed = detail.capabilities.mergeMethods.filter(
        (method) => detail.mergeCapabilities[method],
      );
      if (allowed.length === 0)
        throw new Error("No merge method is available for this repository.");
      return resolvePullRequestMergeMethod(
        allowed,
        null,
        resolveProjectDefault(),
        useUiStateStore.getState().pullRequestMergeMethod,
      );
    },
  });
  const actions =
    entry.state === "closed"
      ? (["reopen"] as const)
      : entry.isDraft
        ? (["close", "ready"] as const)
        : (["close", "merge"] as const);
  const busy = actionPending || closing || sweeping;
  return (
    <div
      className="shrink-0 items-center gap-1 pr-3"
      style={{ display: visible || busy ? "flex" : "none" }}
      role="group"
      aria-label={`Quick actions for pull request #${entry.number}`}
      data-pull-request-action-pending={actionPending || closing}
    >
      {actions.map((action) => {
        const label = ACTIONS[action].label;
        const Icon = ACTIONS[action].Icon;
        return (
          <Tooltip key={action}>
            <TooltipTrigger
              render={
                <Button
                  variant={action === "close" ? "destructive-outline" : "outline"}
                  size="xs"
                  disabled={busy || (action === "merge" && entry.stack !== undefined)}
                  aria-label={`${label} #${entry.number}`}
                  onClick={() => void perform(action)}
                  onPointerDown={(event) => {
                    if (action !== "close" || !event.isPrimary || event.button !== 0) return;
                    event.stopPropagation();
                    onCloseSweepStart?.(entry, event.nativeEvent);
                  }}
                />
              }
            >
              {busy ? <Spinner size="xs" /> : <Icon aria-hidden className="size-3" />}
              {label}
            </TooltipTrigger>
            <TooltipPopup>
              {action === "merge" && entry.stack
                ? "Open this pull request to merge its stack"
                : action === "close" && onCloseSweepStart
                  ? "Close immediately, or drag across rows to close several"
                  : `${label} immediately`}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

const ACTIONS = {
  close: { label: "Close", Icon: PullRequestGlyph.closed },
  merge: { label: "Merge", Icon: PullRequestGlyph.merged },
  ready: { label: "Ready for review", Icon: PullRequestGlyph.pullRequest },
  reopen: { label: "Reopen", Icon: PullRequestGlyph.reopen },
} as const;
