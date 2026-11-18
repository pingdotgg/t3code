import { useEnvironmentQuery } from "~/state/query";
import { PullRequestAdminMergeOption } from "./PullRequestAdminMergeOption";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { useAtomValue } from "@effect/atom-react";
import type { PullRequestAction, PullRequestSummary, PullRequestDetail } from "@t3tools/contracts";
import { createContext, use, useState, type ReactNode } from "react";
import { msg, T, useGT, useMessages } from "gt-react";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

import { m } from "~/i18n/messages";
import { useShortcutModifierState } from "~/shortcutModifierState";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useUiStateStore } from "~/uiStateStore";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  canPerformPullRequestAction,
  isPullRequestConflicting,
  resolvePullRequestMergeMethod,
} from "./pullRequestDetail.logic";
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
  function selectMergeMethod(detail: PullRequestDetail) {
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
  }
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const [adminChoice, setAdminChoice] = useState<{ key: string; checked: boolean } | null>(null);
  const mergeDetail = useEnvironmentQuery(
    confirmingMerge
      ? pullRequestEnvironment.detail({
          environmentId: entry.environmentId,
          input: { ...reference, allowStale: false },
        })
      : null,
  );
  const detail = mergeDetail.data;
  const canAdminOverride =
    canWrite && Boolean(detail?.headSha) && detail?.viewerPermissions.adminMerge === true;
  const confirmationKey = `${entry.environmentId}:${entry.projectId}:${entry.host ?? ""}:${entry.repository}:${entry.number}:${detail?.headSha ?? ""}:${canAdminOverride}`;
  if (adminChoice && adminChoice.key !== confirmationKey) setAdminChoice(null);
  const adminOverride = canAdminOverride && adminChoice?.checked === true;
  const setMergeOpen = (open: boolean) => {
    setConfirmingMerge(open);
    setAdminChoice(null);
  };
  const canMerge =
    canWrite &&
    mergeDetail.error === null &&
    detail !== null &&
    detail.state === "open" &&
    !detail.isDraft &&
    !isPullRequestConflicting(detail) &&
    canPerformPullRequestAction(detail, "merge") &&
    detail.capabilities.mergeMethods.some((method) => detail.mergeCapabilities[method]);
  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId: entry.environmentId,
    reference,
    terminology,
    onSuccess: (action, reply) => onActed?.({ entry, action, reply }),
    resolveMergeMethod: selectMergeMethod,
  });

  const actions = pullRequestQuickActions(entry, hostActions);
  const busy = actionPending || closing || sweeping;
  if (actions.length === 0) return null;
  return (
    <>
      <SpeedModeGroup
        busy={busy}
        pending={actionPending || closing}
        label={gt(
          "Quick actions for {term, select, mr {merge request} cr {change request} other {pull request}} #{number}",
          { term: changeRequestTermKind(terminology), number: entry.number },
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
                    variant={action === "close" ? "destructive-outline" : "outline"}
                    size="xs"
                    disabled={
                      !canWrite || busy || (action === "merge" && entry.stack !== undefined)
                    }
                    aria-label={resolve(ACTIONS[action].numbered, { number: entry.number })}
                    onClick={() => (action === "merge" ? setMergeOpen(true) : void perform(action))}
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
                    : action === "merge"
                      ? gt("Confirm merge")
                      : resolve(ACTIONS[action].immediate)}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </SpeedModeGroup>
      {confirmingMerge ? (
        <AlertDialog open onOpenChange={setMergeOpen}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {gt(
                  "Merge {term, select, mr {merge request} cr {change request} other {pull request}}?",
                  { term: changeRequestTermKind(terminology) },
                )}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {mergeDetail.error ??
                  (detail
                    ? gt("Merge #{number} into {branch}.", {
                        number: entry.number,
                        branch: detail.baseBranch,
                      })
                    : gt("Loading merge permissions…"))}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {canAdminOverride ? (
              <div className="px-6 pb-4">
                <PullRequestAdminMergeOption
                  checked={adminOverride}
                  disabled={busy || mergeDetail.isPending}
                  onCheckedChange={(checked) => setAdminChoice({ key: confirmationKey, checked })}
                />
              </div>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
                <T>Cancel</T>
              </AlertDialogClose>
              {mergeDetail.error ? (
                <Button size="sm" variant="outline" onClick={mergeDetail.refresh}>
                  <T>Retry</T>
                </Button>
              ) : null}
              <Button
                size="sm"
                variant={adminOverride ? "destructive" : "default"}
                disabled={busy || mergeDetail.isPending || !canMerge}
                onClick={async () => {
                  if (
                    await perform(
                      "merge",
                      undefined,
                      adminOverride,
                      adminOverride ? (detail?.headSha ?? undefined) : undefined,
                    )
                  )
                    setMergeOpen(false);
                }}
              >
                <T>Merge</T>
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
    </>
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
