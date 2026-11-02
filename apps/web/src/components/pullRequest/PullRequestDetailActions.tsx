import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestUpdateMethod,
} from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, FolderGit2Icon, GitBranchIcon, PlayIcon } from "lucide-react";
import type { ReactNode } from "react";

import { AnimatedWidth } from "~/components/AnimatedWidth";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { resolvePullRequestPrimaryControl } from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import type { resolvePullRequestState } from "./pullRequestPresentation";
import type { PickableEnvironment } from "./pullRequestProjectAssignment.logic";
import { useInlineActionConfirm } from "./useInlineActionConfirm";

import { useT } from "~/hooks/useI18n";
export type PerformPullRequestAction = (
  action: PullRequestAction,
  method?: PullRequestMergeMethod,
  updateMethod?: PullRequestUpdateMethod,
) => Promise<boolean>;

export function ActOnEnvironmentPicker({
  environments,
  value,
  onChange,
  disabled,
}: {
  environments: ReadonlyArray<PickableEnvironment>;
  value: EnvironmentId;
  onChange: (environmentId: EnvironmentId) => void;
  disabled: boolean;
}) {
  return (
    <>
      <MenuSeparator />
      <MenuRadioGroup
        value={value}
        onValueChange={(environmentId) => onChange(environmentId as EnvironmentId)}
      >
        {environments.map((environment) => (
          <MenuRadioItem
            key={environment.environmentId}
            value={environment.environmentId}
            disabled={disabled}
          >
            <span className="flex min-w-0 items-center gap-2">
              <EnvironmentMachineIcon
                kind={environment.machine ?? "server"}
                className="size-3.5 shrink-0"
              />
              <span className="truncate">{environment.label}</span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}

export function PullRequestCheckoutMenu({
  handoff,
  checkoutRoot,
  canPrepareWorktree,
  canCheckoutHere,
  onCheckout,
  pickableEnvironments,
  actingEnvironmentId,
  onActingEnvironmentChange,
  term,
}: {
  handoff: string | null;
  checkoutRoot: string | null;
  canPrepareWorktree: boolean;
  canCheckoutHere: boolean;
  onCheckout: (mode: "worktree" | "local") => void;
  pickableEnvironments: ReadonlyArray<PickableEnvironment>;
  actingEnvironmentId: EnvironmentId;
  onActingEnvironmentChange: (environmentId: EnvironmentId) => void;
  /** The host's word for a change request, as in "pull request". */
  term: string;
}) {
  const t = useT();
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              disabled={handoff !== null || checkoutRoot === null}
              render={
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={
                    handoff?.startsWith("checkout")
                      ? t("review.extra.checking.out")
                      : t("review.extra.check.out")
                  }
                >
                  <GitBranchIcon aria-hidden className="size-3.5" />
                  <span className="@max-[35rem]/pr-header:hidden">
                    {handoff?.startsWith("checkout")
                      ? t("review.extra.checking.out")
                      : t("review.extra.check.out")}
                  </span>
                  <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
                </Button>
              }
            />
          }
        />
        <TooltipPopup>{t("review.extra.checkoutThis", { term })}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuItem disabled={!canPrepareWorktree} onClick={() => onCheckout("worktree")}>
          <GitBranchIcon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>{t("review.extra.in.a.separate.worktree")}</span>
            <span className="text-xs text-muted-foreground">
              {t("review.extra.its.own.folder.and.thread.nothing.you.have")}
            </span>
          </span>
        </MenuItem>
        <MenuItem disabled={!canCheckoutHere} onClick={() => onCheckout("local")}>
          <FolderGit2Icon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>{t("review.extra.in.this.repository")}</span>
            <span className="text-xs text-muted-foreground">
              {t("review.extra.switches.the.branch.you.are.working.in")}
            </span>
          </span>
        </MenuItem>
        {pickableEnvironments.length > 0 ? (
          <ActOnEnvironmentPicker
            environments={pickableEnvironments}
            value={actingEnvironmentId}
            onChange={onActingEnvironmentChange}
            disabled={handoff !== null}
          />
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function PullRequestResolveConflictsButton({
  handoff,
  unavailable,
  onResolve,
}: {
  handoff: string | null;
  unavailable: boolean;
  onResolve: () => void;
}) {
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={handoff !== null || unavailable}
              onClick={onResolve}
              aria-label={
                handoff === "conflicts"
                  ? t("review.extra.preparing")
                  : t("review.extra.resolve.conflicts")
              }
            >
              <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
              <span className="@max-[30rem]/pr-header:hidden">
                {handoff === "conflicts"
                  ? t("review.extra.preparing")
                  : t("review.extra.resolve.conflicts")}
              </span>
            </Button>
          </span>
        }
      />
      <TooltipPopup side="top">
        {handoff === "conflicts"
          ? t("review.extra.preparing")
          : t("review.extra.resolve.conflicts")}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The header's one prominent control, which depends on where the pull request stands. */
export function PullRequestPrimaryAction({
  pullRequestKey,
  primaryAction,
  mergeBlockedReason,
  autoMergeArmed,
  armedAutoMergeLabel,
  pendingAutoMergeLabel,
  selectedMergeMethod,
  selectedMergeMethodLabel,
  statePresentation,
  pendingAction,
  perform,
  resolveConflicts,
}: {
  pullRequestKey: string;
  primaryAction: ReturnType<typeof resolvePullRequestPrimaryControl> | null;
  mergeBlockedReason: string | null;
  autoMergeArmed: boolean;
  armedAutoMergeLabel: string;
  pendingAutoMergeLabel: string;
  selectedMergeMethod: PullRequestMergeMethod;
  selectedMergeMethodLabel: string;
  statePresentation: ReturnType<typeof resolvePullRequestState> | null;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  resolveConflicts: ReactNode;
}) {
  const t = useT();
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
  const actionPending = pendingAction !== null;
  return (
    <>
      {autoMergeArmed && primaryAction !== "auto-merge-armed" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge size="control" variant="info" role="img" aria-label={armedAutoMergeLabel}>
                <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                <span className="@max-[30rem]/pr-header:hidden">{armedAutoMergeLabel}</span>
              </Badge>
            }
          />
          <TooltipPopup side="top">
            {t("review.extra.autoMergeHost", { label: armedAutoMergeLabel })}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {primaryAction === "resolve" ? (
        resolveConflicts
      ) : primaryAction === "ready" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex shrink-0">
                <Button
                  size="xs"
                  variant="default"
                  disabled={actionPending}
                  onClick={() => void perform("ready")}
                  aria-label={t("review.extra.ready.for.review")}
                >
                  <PullRequestGlyph.pullRequest aria-hidden className="size-3.5" />
                  <span className="@max-[30rem]/pr-header:hidden">
                    {t("review.extra.ready.for.review")}
                  </span>
                </Button>
              </span>
            }
          />
          <TooltipPopup side="top">{t("review.extra.ready.for.review")}</TooltipPopup>
        </Tooltip>
      ) : primaryAction === "enable-auto-merge" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex shrink-0">
                <Button
                  size="xs"
                  variant="default"
                  disabled={actionPending}
                  aria-disabled={mergeBlockedReason !== null || undefined}
                  aria-description={mergeBlockedReason ?? undefined}
                  {...(mergeBlockedReason === null
                    ? inlineConfirm.props(
                        "enable-auto-merge",
                        () => void perform("enable-auto-merge", selectedMergeMethod),
                      )
                    : {})}
                  aria-label={
                    pendingAction === "enable-auto-merge"
                      ? t("review.extra.enabling")
                      : inlineConfirm.isArmed("enable-auto-merge")
                        ? t("review.extra.confirm.auto.merge")
                        : pendingAutoMergeLabel
                  }
                >
                  {inlineConfirm.isArmed("enable-auto-merge") ? (
                    <CheckIcon aria-hidden className="size-3.5" />
                  ) : (
                    <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                  )}
                  <AnimatedWidth className="@max-[30rem]/pr-header:hidden">
                    <span className="grid">
                      <span aria-hidden className="invisible col-start-1 row-start-1">
                        {pendingAutoMergeLabel}
                      </span>
                      <span className="col-start-1 row-start-1">
                        {pendingAction === "enable-auto-merge"
                          ? t("review.extra.enabling")
                          : inlineConfirm.isArmed("enable-auto-merge")
                            ? t("review.extra.confirm.auto.merge")
                            : pendingAutoMergeLabel}
                      </span>
                    </span>
                  </AnimatedWidth>
                </Button>
              </span>
            }
          />
          <TooltipPopup side="top">
            {mergeBlockedReason ??
              (pendingAction === "enable-auto-merge"
                ? t("review.extra.enabling")
                : inlineConfirm.isArmed("enable-auto-merge")
                  ? t("review.extra.confirm.auto.merge")
                  : pendingAutoMergeLabel)}
          </TooltipPopup>
        </Tooltip>
      ) : primaryAction === "auto-merge-armed" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge size="control" variant="info" role="img" aria-label={armedAutoMergeLabel}>
                <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                <span className="@max-[30rem]/pr-header:hidden">{armedAutoMergeLabel}</span>
              </Badge>
            }
          />
          <TooltipPopup side="top">
            {t("review.extra.autoMergeHost", { label: armedAutoMergeLabel })}
          </TooltipPopup>
        </Tooltip>
      ) : primaryAction === "merge" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex shrink-0">
                <Button
                  size="xs"
                  variant="default"
                  disabled={actionPending}
                  aria-disabled={mergeBlockedReason !== null || undefined}
                  aria-description={mergeBlockedReason ?? undefined}
                  {...(mergeBlockedReason === null
                    ? inlineConfirm.props("merge", () => void perform("merge", selectedMergeMethod))
                    : {})}
                  aria-label={
                    pendingAction === "merge"
                      ? t("review.extra.merging")
                      : inlineConfirm.isArmed("merge")
                        ? t("review.extra.confirm.merge")
                        : selectedMergeMethodLabel
                  }
                >
                  {inlineConfirm.isArmed("merge") ? (
                    <CheckIcon aria-hidden className="size-3.5" />
                  ) : (
                    <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                  )}
                  <AnimatedWidth className="@max-[30rem]/pr-header:hidden">
                    <span className="grid">
                      <span aria-hidden className="invisible col-start-1 row-start-1">
                        {selectedMergeMethodLabel}
                      </span>
                      <span className="col-start-1 row-start-1">
                        {pendingAction === "merge"
                          ? t("review.extra.merging")
                          : inlineConfirm.isArmed("merge")
                            ? t("review.extra.confirm.merge")
                            : selectedMergeMethodLabel}
                      </span>
                    </span>
                  </AnimatedWidth>
                </Button>
              </span>
            }
          />
          <TooltipPopup side="top">
            {mergeBlockedReason ??
              (pendingAction === "merge"
                ? t("review.extra.merging")
                : inlineConfirm.isArmed("merge")
                  ? t("review.extra.confirm.merge")
                  : selectedMergeMethodLabel)}
          </TooltipPopup>
        </Tooltip>
      ) : (primaryAction === "merged" || primaryAction === "closed") &&
        statePresentation !== null ? (
        <Badge size="control" variant="outline">
          <span className={cn("flex items-center gap-1", statePresentation.toneClassName)}>
            <statePresentation.Icon className="size-3.5" />
            {statePresentation.label}
          </span>
        </Badge>
      ) : null}
    </>
  );
}

export function PullRequestApproveWorkflowsButton({
  pullRequestKey,
  pendingAction,
  perform,
}: {
  pullRequestKey: string;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
}) {
  const t = useT();
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
  const actionPending = pendingAction !== null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="ml-auto inline-flex shrink-0">
            <Button
              size="xs"
              variant="warning-outline"
              disabled={actionPending}
              {...inlineConfirm.props("approve-workflows", () => void perform("approve-workflows"))}
              aria-label={
                pendingAction === "approve-workflows"
                  ? t("review.extra.approving")
                  : inlineConfirm.isArmed("approve-workflows")
                    ? t("review.extra.confirm.approve")
                    : t("review.extra.approve.workflows.to.run")
              }
            >
              <PlayIcon aria-hidden className="size-3.5" />
              <span className="inline-grid">
                <span aria-hidden className="invisible col-start-1 row-start-1">
                  {t("review.extra.approve.workflows.to.run")}
                </span>
                <span aria-hidden className="invisible col-start-1 row-start-1">
                  {t("review.extra.confirm.approve")}
                </span>
                <span className="col-start-1 row-start-1">
                  {pendingAction === "approve-workflows"
                    ? t("review.extra.approving")
                    : inlineConfirm.isArmed("approve-workflows")
                      ? t("review.extra.confirm.approve")
                      : t("review.extra.approve.workflows.to.run")}
                </span>
              </span>
            </Button>
          </span>
        }
      />
      <TooltipPopup side="top">
        {pendingAction === "approve-workflows"
          ? t("review.extra.approving")
          : inlineConfirm.isArmed("approve-workflows")
            ? t("review.extra.confirm.approve")
            : t("review.extra.approve.workflows.to.run")}
      </TooltipPopup>
    </Tooltip>
  );
}
