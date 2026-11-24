import { useAtomValue } from "@effect/atom-react";
import type { PullRequestAction, PullRequestSummary } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { createContext, use, useState, type ReactNode } from "react";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

import { m } from "~/i18n/messages";
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

import { changeRequestTermKind } from "./changeRequestTerm";

type PullRequestSpeedActionEntry = Pick<
  EnvironmentPullRequestEntry,
  "environmentId" | "projectId" | "host" | "repository" | "number" | "state" | "isDraft"
> & { readonly stack?: object | undefined };

export interface PullRequestSpeedActionResult<Entry = EnvironmentPullRequestEntry> {
  readonly entry: Entry;
  readonly action: PullRequestAction;
  readonly reply?: PullRequestSummary | undefined;
}

interface PullRequestSpeedActionsProps<Entry> {
  entry: Entry;
  hostActions: ReadonlySet<PullRequestAction>;
  terminology: ChangeRequestTerminology;
  onActed?: (result: PullRequestSpeedActionResult<Entry>) => void;
  closing?: boolean;
  sweeping?: boolean;
  onCloseSweepStart?: (entry: Entry, event: PointerEvent) => void;
}

/**
 * Hidden until Shift is held or a close runs, so a row mounts without them. Once shown they stay
 * mounted: an action started in speed mode keeps its pending state after Shift is let go.
 */
export function PullRequestSpeedActions<Entry extends PullRequestSpeedActionEntry>(
  props: PullRequestSpeedActionsProps<Entry>,
) {
  const speedMode = use(PullRequestSpeedModeContext);
  const wanted = speedMode || props.closing === true || props.sweeping === true;
  const [shown, setShown] = useState(wanted);
  if (wanted && !shown) setShown(true);
  return shown || wanted ? <PullRequestSpeedActionButtons {...props} /> : null;
}

function PullRequestSpeedActionButtons<Entry extends PullRequestSpeedActionEntry>({
  entry,
  hostActions,
  terminology,
  onActed,
  closing = false,
  sweeping = false,
  onCloseSweepStart,
}: PullRequestSpeedActionsProps<Entry>) {
  const gt = useGT();
  const resolve = useMessages();
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
    onSuccess: (action, reply) => onActed?.({ entry, action, reply }),
    resolveMergeMethod: (detail) => {
      const allowed = detail.capabilities.mergeMethods.filter(
        (method) => detail.mergeCapabilities[method],
      );
      if (allowed.length === 0)
        throw new Error(m(msg("No merge method is available for this repository.")));
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
      label={gt(
        "Quick actions for {term, select, mr {merge request} cr {change request} other {pull request}} #{number}",
        {
          term: changeRequestTermKind(terminology),
          number: entry.number,
        },
      )}
    >
      {actions.map((action) => {
        const label = resolve(ACTIONS[action].label);
        const Icon = ACTIONS[action].Icon;
        return (
          <Tooltip key={action}>
            <TooltipTrigger
              render={
                <Button
                  variant={action === "close" ? "destructive-outline" : "secondary"}
                  size="xs"
                  disabled={!canWrite || busy || (action === "merge" && entry.stack !== undefined)}
                  aria-label={resolve(ACTIONS[action].numbered, { number: entry.number })}
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
                ? gt(
                    "Open this {term, select, mr {merge request} cr {change request} other {pull request}} to merge its stack",
                    { term: changeRequestTermKind(terminology) },
                  )
                : action === "close" && onCloseSweepStart
                  ? gt("Close immediately, or drag across rows to close several")
                  : resolve(ACTIONS[action].immediate)}
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
  close: {
    label: msg("Close", { $context: "verb, close a pull request" }),
    numbered: msg("Close #{number}"),
    immediate: msg("Close immediately"),
    Icon: PullRequestGlyph.closed,
  },
  merge: {
    label: msg("Merge", { $context: "verb, merge a pull request" }),
    numbered: msg("Merge #{number}"),
    immediate: msg("Merge immediately"),
    Icon: PullRequestGlyph.merged,
  },
  ready: {
    label: msg("Ready for review"),
    numbered: msg("Ready for review #{number}"),
    immediate: msg("Ready for review immediately"),
    Icon: PullRequestGlyph.pullRequest,
  },
  reopen: {
    label: msg("Reopen"),
    numbered: msg("Reopen #{number}"),
    immediate: msg("Reopen immediately"),
    Icon: PullRequestGlyph.reopen,
  },
} as const;
