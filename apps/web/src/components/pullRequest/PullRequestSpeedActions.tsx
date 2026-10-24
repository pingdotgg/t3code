import { useAtomValue } from "@effect/atom-react";
import type { PullRequestAction } from "@t3tools/contracts";
import { createContext, use, type ReactNode } from "react";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

import { useShortcutModifierState } from "~/shortcutModifierState";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useUiStateStore } from "~/uiStateStore";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolvePullRequestMergeMethod } from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import { pullRequestQuickActions, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";
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

export function PullRequestSpeedActions<Entry extends PullRequestSpeedActionEntry>({
  entry,
  hostActions,
  terminology,
  onActed,
  closing = false,
  sweeping = false,
  onCloseSweepStart,
}: {
  entry: Entry;
  hostActions: ReadonlySet<PullRequestAction>;
  terminology: ChangeRequestTerminology;
  onActed?: (result: PullRequestSpeedActionResult<Entry>) => void;
  closing?: boolean;
  sweeping?: boolean;
  onCloseSweepStart?: (entry: Entry, event: PointerEvent) => void;
}) {
  const canWrite = useAtomValue(
    pullRequestEnvironment.runAction.permissionAtom(entry.environmentId),
  );
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
    terminology,
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
  const actions = pullRequestQuickActions(entry, hostActions);
  const busy = actionPending || closing || sweeping;
  if (actions.length === 0) return null;
  return (
    <SpeedModeGroup
      busy={busy}
      pending={actionPending || closing}
      label={`Quick actions for ${terminology.singular} #${entry.number}`}
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
                  disabled={!canWrite || busy || (action === "merge" && entry.stack !== undefined)}
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
                ? `Open this ${terminology.singular} to merge its stack`
                : action === "close" && onCloseSweepStart
                  ? "Close immediately, or drag across rows to close several"
                  : `${label} immediately`}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </SpeedModeGroup>
  );
}

/**
 * Whether Shift is held, as context rather than a row prop: a Shift press then re-renders each
 * row's action group, not the rows or their buttons, in one commit.
 */
export const PullRequestSpeedModeContext = createContext(false);

/** Tracks Shift for the quick actions below it. */
export function PullRequestSpeedModeProvider({ children }: { children: ReactNode }) {
  const modifiers = useShortcutModifierState(true);
  const speedMode =
    modifiers.shiftKey && !modifiers.metaKey && !modifiers.ctrlKey && !modifiers.altKey;
  return <PullRequestSpeedModeContext value={speedMode}>{children}</PullRequestSpeedModeContext>;
}

function SpeedModeGroup({
  busy,
  pending,
  label,
  children,
}: {
  busy: boolean;
  pending: boolean;
  label: string;
  children: ReactNode;
}) {
  const speedMode = use(PullRequestSpeedModeContext);
  return (
    <div
      className="shrink-0 items-center gap-1 pr-3"
      style={{ display: speedMode || busy ? "flex" : "none" }}
      role="group"
      aria-label={label}
      data-pull-request-action-pending={pending}
    >
      {children}
    </div>
  );
}

const ACTIONS = {
  close: { label: "Close", Icon: PullRequestGlyph.closed },
  merge: { label: "Merge", Icon: PullRequestGlyph.merged },
  ready: { label: "Ready for review", Icon: PullRequestGlyph.pullRequest },
  reopen: { label: "Reopen", Icon: PullRequestGlyph.reopen },
} as const;
