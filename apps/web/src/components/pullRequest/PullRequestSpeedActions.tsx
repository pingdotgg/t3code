import type { PullRequestAction } from "@t3tools/contracts";
import { Effect } from "effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { pullRequestEnvironment, pullRequestStackAtom } from "~/state/pullRequests";
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

export interface PullRequestSpeedActionResult {
  readonly entry: EnvironmentPullRequestEntry;
  readonly action: PullRequestAction;
}

/** No detail or stack reads until a merge is clicked, even on a long list. */
export function PullRequestSpeedActions({
  entry,
  visible,
  onActed,
}: {
  entry: EnvironmentPullRequestEntry;
  visible: boolean;
  onActed: (result: PullRequestSpeedActionResult) => void;
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
    onSuccess: (action) => onActed({ entry, action }),
    resolveMergeMethod: async () => {
      const target = { environmentId: entry.environmentId, input: reference };
      const detailAtom = pullRequestEnvironment.detail({
        ...target,
        input: { ...reference, allowStale: false },
      });
      appAtomRegistry.refresh(detailAtom);
      const detail = await Effect.runPromise(
        AtomRegistry.getResult(appAtomRegistry, detailAtom, { suspendOnWaiting: true }),
      );
      if (
        detail.state !== "open" ||
        detail.isDraft ||
        !detail.capabilities.actions.includes("merge") ||
        !detail.viewerPermissions.actions.includes("merge")
      ) {
        throw new Error("This pull request cannot be merged.");
      }
      if (detail.capabilities.stackActions) {
        const stackAtom = pullRequestStackAtom(target);
        appAtomRegistry.refresh(stackAtom);
        const stack = await Effect.runPromise(
          AtomRegistry.getResult(appAtomRegistry, stackAtom, { suspendOnWaiting: true }),
        );
        if (stack !== null) throw new Error("Open this pull request to merge its stack.");
      }
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
  return (
    <div
      className="shrink-0 items-center gap-1 pr-3"
      style={{ display: visible || actionPending ? "flex" : "none" }}
      role="group"
      aria-label={`Quick actions for pull request #${entry.number}`}
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
                  disabled={actionPending || (action === "merge" && entry.stack !== undefined)}
                  aria-label={`${label} #${entry.number}`}
                  onClick={() => void perform(action)}
                />
              }
            >
              {actionPending ? <Spinner size="xs" /> : <Icon aria-hidden className="size-3" />}
              {label}
            </TooltipTrigger>
            <TooltipPopup>
              {action === "merge" && entry.stack
                ? "Open this pull request to merge its stack"
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
