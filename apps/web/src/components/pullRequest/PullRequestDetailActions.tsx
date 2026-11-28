import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestUpdateMethod,
} from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, FolderGit2Icon, GitBranchIcon, PlayIcon } from "lucide-react";
import { Branch, T, useGT } from "gt-react";
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
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import type { resolvePullRequestPrimaryControl } from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import type { resolvePullRequestState } from "./pullRequestPresentation";
import type { PickableEnvironment } from "./pullRequestProjectAssignment.logic";
import { useInlineActionConfirm } from "./useInlineActionConfirm";

import type { ChangeRequestTermKind } from "./changeRequestTerm";

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
  term: ChangeRequestTermKind;
}) {
  const gt = useGT();
  return (
    <Menu>
      <SharedTooltipTrigger
        render={
          <MenuTrigger
            disabled={handoff !== null || checkoutRoot === null}
            render={
              <Button
                size="xs"
                variant="outline"
                aria-label={
                  handoff?.startsWith("checkout") ? gt("Checking out...") : gt("Check out")
                }
              >
                <GitBranchIcon aria-hidden className="size-3.5" />
                <span className="@max-[35rem]/pr-header:hidden">
                  {handoff?.startsWith("checkout") ? gt("Checking out...") : gt("Check out")}
                </span>
                <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
              </Button>
            }
          />
        }
        label={
          <>
            <T>
              Check out this{" "}
              <Branch branch={term} mr="merge request" cr="change request">
                pull request
              </Branch>
            </T>
          </>
        }
      />
      <MenuPopup align="end" side="bottom">
        <MenuItem disabled={!canPrepareWorktree} onClick={() => onCheckout("worktree")}>
          <GitBranchIcon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>
              <T>In a separate worktree</T>
            </span>
            <span className="text-xs text-muted-foreground">
              <T>Its own folder and thread. Nothing you have open moves.</T>
            </span>
          </span>
        </MenuItem>
        <MenuItem disabled={!canCheckoutHere} onClick={() => onCheckout("local")}>
          <FolderGit2Icon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>
              <T>In this repository</T>
            </span>
            <span className="text-xs text-muted-foreground">
              <T>Switches the branch you are working in.</T>
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
  const gt = useGT();
  return (
    <SharedTooltipTrigger
      render={
        <span className="inline-flex shrink-0">
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={handoff !== null || unavailable}
            onClick={onResolve}
            aria-label={handoff === "conflicts" ? gt("Preparing...") : gt("Resolve conflicts")}
          >
            <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
            <span className="@max-[30rem]/pr-header:hidden">
              {handoff === "conflicts" ? gt("Preparing...") : gt("Resolve conflicts")}
            </span>
          </Button>
        </span>
      }
      label={handoff === "conflicts" ? gt("Preparing...") : gt("Resolve conflicts")}
    />
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
  const gt = useGT();
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
  const actionPending = pendingAction !== null;
  return (
    <>
      {autoMergeArmed && primaryAction !== "auto-merge-armed" ? (
        <SharedTooltipTrigger
          render={
            <Badge size="control" variant="info" role="img" aria-label={armedAutoMergeLabel}>
              <PullRequestGlyph.merged aria-hidden className="size-3.5" />
              <span className="@max-[30rem]/pr-header:hidden">{armedAutoMergeLabel}</span>
            </Badge>
          }
          label={gt("{label}: the host will merge this on its own once its requirements are met", {
            label: armedAutoMergeLabel,
          })}
        />
      ) : null}
      {primaryAction === "resolve" ? (
        resolveConflicts
      ) : primaryAction === "ready" ? (
        <SharedTooltipTrigger
          render={
            <span className="inline-flex shrink-0">
              <Button
                size="xs"
                variant="default"
                disabled={actionPending}
                onClick={() => void perform("ready")}
                aria-label={gt("Ready for review")}
              >
                <PullRequestGlyph.pullRequest aria-hidden className="size-3.5" />
                <span className="@max-[30rem]/pr-header:hidden">
                  <T>Ready for review</T>
                </span>
              </Button>
            </span>
          }
          label={
            <>
              <T>Ready for review</T>
            </>
          }
        />
      ) : primaryAction === "enable-auto-merge" ? (
        <SharedTooltipTrigger
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
                    ? gt("Enabling...")
                    : inlineConfirm.isArmed("enable-auto-merge")
                      ? gt("Confirm auto-merge?")
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
                        ? gt("Enabling...")
                        : inlineConfirm.isArmed("enable-auto-merge")
                          ? gt("Confirm auto-merge?")
                          : pendingAutoMergeLabel}
                    </span>
                  </span>
                </AnimatedWidth>
              </Button>
            </span>
          }
          label={
            mergeBlockedReason ??
            (pendingAction === "enable-auto-merge"
              ? gt("Enabling...")
              : inlineConfirm.isArmed("enable-auto-merge")
                ? gt("Confirm auto-merge?")
                : pendingAutoMergeLabel)
          }
        />
      ) : primaryAction === "auto-merge-armed" ? (
        <SharedTooltipTrigger
          render={
            <Badge size="control" variant="info" role="img" aria-label={armedAutoMergeLabel}>
              <PullRequestGlyph.merged aria-hidden className="size-3.5" />
              <span className="@max-[30rem]/pr-header:hidden">{armedAutoMergeLabel}</span>
            </Badge>
          }
          label={gt("{label}: the host will merge this on its own once its requirements are met", {
            label: armedAutoMergeLabel,
          })}
        />
      ) : primaryAction === "merge" ? (
        <SharedTooltipTrigger
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
                    ? gt("Merging...")
                    : inlineConfirm.isArmed("merge")
                      ? gt("Confirm merge?")
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
                        ? gt("Merging...")
                        : inlineConfirm.isArmed("merge")
                          ? gt("Confirm merge?")
                          : selectedMergeMethodLabel}
                    </span>
                  </span>
                </AnimatedWidth>
              </Button>
            </span>
          }
          label={
            mergeBlockedReason ??
            (pendingAction === "merge"
              ? gt("Merging...")
              : inlineConfirm.isArmed("merge")
                ? gt("Confirm merge?")
                : selectedMergeMethodLabel)
          }
        />
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
  const gt = useGT();
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
  const actionPending = pendingAction !== null;
  return (
    <SharedTooltipTrigger
      render={
        <span className="ml-auto inline-flex shrink-0">
          <Button
            size="xs"
            variant="warning-outline"
            disabled={actionPending}
            {...inlineConfirm.props("approve-workflows", () => void perform("approve-workflows"))}
            aria-label={
              pendingAction === "approve-workflows"
                ? gt("Approving...")
                : inlineConfirm.isArmed("approve-workflows")
                  ? gt("Confirm approve?")
                  : gt("Approve workflows to run")
            }
          >
            <PlayIcon aria-hidden className="size-3.5" />
            <span className="inline-grid">
              <span aria-hidden className="invisible col-start-1 row-start-1">
                <T>Approve workflows to run</T>
              </span>
              <span aria-hidden className="invisible col-start-1 row-start-1">
                <T>Confirm approve?</T>
              </span>
              <span className="col-start-1 row-start-1">
                {pendingAction === "approve-workflows"
                  ? gt("Approving...")
                  : inlineConfirm.isArmed("approve-workflows")
                    ? gt("Confirm approve?")
                    : gt("Approve workflows to run")}
              </span>
            </span>
          </Button>
        </span>
      }
      label={
        pendingAction === "approve-workflows"
          ? gt("Approving...")
          : inlineConfirm.isArmed("approve-workflows")
            ? gt("Confirm approve?")
            : gt("Approve workflows to run")
      }
    />
  );
}
