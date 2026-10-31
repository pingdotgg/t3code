import {
  type EnvironmentId,
  type PullRequestAction,
  type PullRequestMergeMethod,
  type PullRequestUpdateMethod,
} from "@t3tools/contracts";
import { CheckIcon, FolderGit2Icon, GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  resolvePullRequestPrimaryControl,
} from "./pullRequestDetail.logic";
import { useInlineActionConfirm } from "./useInlineActionConfirm";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../ui/menu";
import { PullRequestGlyph } from "./pullRequestIcons";
import { type PickableEnvironment } from "./pullRequestProjectAssignment.logic";

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

export function PullRequestResolveConflictsButton({
  handoff,
  unavailable,
  onResolve,
}: {
  handoff: string | null;
  unavailable: boolean;
  onResolve: () => void;
}) {
  return (
    <Button
      size="xs"
      variant="destructive-outline"
      disabled={handoff !== null || unavailable}
      onClick={onResolve}
    >
      <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
      {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts"}
    </Button>
  );
}

export function PullRequestCheckoutMenuItems({
  handoff,
  checkoutRoot,
  canPrepareWorktree,
  canCheckoutHere,
  onCheckout,
}: {
  handoff: string | null;
  checkoutRoot: string | null;
  canPrepareWorktree: boolean;
  canCheckoutHere: boolean;
  onCheckout: (mode: "worktree" | "local") => void;
}) {
  return (
    <>
      <MenuItem
        disabled={handoff !== null || checkoutRoot === null || !canPrepareWorktree}
        onClick={() => onCheckout("worktree")}
      >
        <GitBranchIcon className="mt-1 size-3.5 shrink-0 self-start sm:mt-0.5" />
        <span className="flex min-w-0 flex-col">
          <span>
            {handoff === "checkout:worktree" ? "Checking out..." : "Check out in a worktree"}
          </span>
          <span className="text-meta text-muted-foreground">
            Its own folder and thread. Nothing you have open moves.
          </span>
        </span>
      </MenuItem>
      <MenuItem
        disabled={handoff !== null || checkoutRoot === null || !canCheckoutHere}
        onClick={() => onCheckout("local")}
      >
        <FolderGit2Icon className="mt-1 size-3.5 shrink-0 self-start sm:mt-0.5" />
        <span className="flex min-w-0 flex-col">
          <span>
            {handoff === "checkout:local" ? "Checking out..." : "Check out in this repository"}
          </span>
          <span className="text-meta text-muted-foreground">
            Switches the branch you are working in.
          </span>
        </span>
      </MenuItem>
    </>
  );
}

/** The readiness card's primary control and armed auto-merge status. */
export function PullRequestPrimaryAction({
  primaryAction,
  mergeBlockedReason,
  handoff,
  unavailable,
  onResolve,
  pendingAction,
  perform,
  inlineConfirm,
  selectedMergeMethod,
  selectedMergeMethodLabel,
  pendingAutoMergeLabel,
  armedAutoMergeLabel,
}: {
  primaryAction: ReturnType<typeof resolvePullRequestPrimaryControl> | null;
  mergeBlockedReason: string | null;
  handoff: string | null;
  unavailable: boolean;
  onResolve: () => void;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  inlineConfirm: ReturnType<typeof useInlineActionConfirm>;
  selectedMergeMethod: PullRequestMergeMethod;
  selectedMergeMethodLabel: string;
  pendingAutoMergeLabel: string;
  armedAutoMergeLabel: string;
}) {
  const actionPending = pendingAction !== null;
  // The merge, full width at the foot of the readiness card. One stable slot from waiting through
  // completion: conflicts take it while they need a person, and a finished pull request shows its
  // state there instead of a button.
  const primaryButton =
    primaryAction === "resolve" ? (
      <Button
        size="sm"
        variant="destructive-outline"
        className="flex-1"
        disabled={handoff !== null || unavailable}
        onClick={onResolve}
      >
        <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
        {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts"}
      </Button>
    ) : primaryAction === "ready" ? (
      <Button
        size="sm"
        className="flex-1"
        disabled={actionPending}
        onClick={() => void perform("ready")}
      >
        <PullRequestGlyph.pullRequest aria-hidden className="size-3.5" />
        Ready for review
      </Button>
    ) : primaryAction === "enable-auto-merge" ? (
      <Button
        size="sm"
        className="flex-1"
        disabled={actionPending}
        aria-disabled={mergeBlockedReason !== null || undefined}
        aria-description={mergeBlockedReason ?? undefined}
        {...(mergeBlockedReason === null
          ? inlineConfirm.props(
              "enable-auto-merge",
              () => void perform("enable-auto-merge", selectedMergeMethod),
            )
          : {})}
      >
        {inlineConfirm.isArmed("enable-auto-merge") ? (
          <CheckIcon aria-hidden className="size-3.5" />
        ) : (
          <PullRequestGlyph.merged aria-hidden className="size-3.5" />
        )}
        {pendingAction === "enable-auto-merge"
          ? "Enabling..."
          : inlineConfirm.isArmed("enable-auto-merge")
            ? "Confirm auto-merge?"
            : pendingAutoMergeLabel}
      </Button>
    ) : primaryAction === "merge" ? (
      <Button
        size="sm"
        className="flex-1"
        disabled={actionPending}
        aria-disabled={mergeBlockedReason !== null || undefined}
        aria-description={mergeBlockedReason ?? undefined}
        {...(mergeBlockedReason === null
          ? inlineConfirm.props("merge", () => void perform("merge", selectedMergeMethod))
          : {})}
      >
        {inlineConfirm.isArmed("merge") ? (
          <CheckIcon aria-hidden className="size-3.5" />
        ) : (
          <PullRequestGlyph.merged aria-hidden className="size-3.5" />
        )}
        {pendingAction === "merge"
          ? "Merging..."
          : inlineConfirm.isArmed("merge")
            ? "Confirm merge?"
            : selectedMergeMethodLabel}
      </Button>
    ) : null;
  const primaryStatus =
    primaryButton !== null ? null : primaryAction === "auto-merge-armed" ? (
      <p className="flex h-8 flex-1 items-center justify-center gap-1.5 text-meta text-info-foreground sm:h-7">
        <PullRequestGlyph.merged aria-hidden className="size-3.5" />
        {armedAutoMergeLabel}: the host merges this once its requirements are met
      </p>
    ) : null; // Merged and closed lead the readiness card instead.
  return primaryButton ?? primaryStatus;
}

/** Merge methods, host updates and page checkout behind the readiness action. */
export function PullRequestPrimaryActionMenu({
  showsMergeMethods,
  showsMergeNow,
  showsAutoMerge,
  autoMergeArmed,
  allowedMergeMethods,
  selectedMergeMethod,
  onSelectMergeMethod,
  pendingAction,
  perform,
  inlineConfirm,
  can,
  updateMethods,
  showCheckout,
  checkoutMenuItems,
}: {
  showsMergeMethods: boolean;
  showsMergeNow: boolean;
  showsAutoMerge: boolean;
  autoMergeArmed: boolean;
  allowedMergeMethods: ReadonlyArray<PullRequestMergeMethod>;
  selectedMergeMethod: PullRequestMergeMethod;
  onSelectMergeMethod: (method: PullRequestMergeMethod) => void;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  inlineConfirm: ReturnType<typeof useInlineActionConfirm>;
  can: (action: PullRequestAction) => boolean;
  updateMethods: ReadonlyArray<PullRequestUpdateMethod>;
  showCheckout: boolean;
  checkoutMenuItems: ReactNode;
}) {
  const actionPending = pendingAction !== null;
  return (
    <>
      {showsMergeMethods ? (
        <MenuGroup>
          <MenuGroupLabel>Merge method</MenuGroupLabel>
          <MenuRadioGroup
            value={selectedMergeMethod}
            onValueChange={(method) => {
              const selectedMethod = method as PullRequestMergeMethod;
              onSelectMergeMethod(selectedMethod);
            }}
          >
            {allowedMergeMethods.map((method) => (
              <MenuRadioItem key={method} value={method} disabled={actionPending} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <PullRequestGlyph.merged className="size-3.5" />
                  <span>{PULL_REQUEST_MERGE_METHOD_LABELS[method]}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {showsMergeNow || showsAutoMerge ? (
        <>
          {showsMergeMethods ? <MenuSeparator /> : null}
          {showsMergeNow ? (
            <MenuItem
              closeOnClick={inlineConfirm.isArmed("merge")}
              aria-label={inlineConfirm.isArmed("merge") ? "Confirm merge?" : "Merge now"}
              disabled={actionPending}
              {...inlineConfirm.props("merge", () => void perform("merge", selectedMergeMethod))}
            >
              <PullRequestGlyph.merged className="size-3.5" />
              {inlineConfirm.isArmed("merge") ? "Confirm merge?" : "Merge now"}
            </MenuItem>
          ) : null}
          {autoMergeArmed && can("disable-auto-merge") ? (
            <MenuItem disabled={actionPending} onClick={() => void perform("disable-auto-merge")}>
              <PullRequestGlyph.merged className="size-3.5" />
              Disable auto-merge
            </MenuItem>
          ) : showsAutoMerge ? (
            <MenuItem
              closeOnClick={inlineConfirm.isArmed("enable-auto-merge")}
              aria-label={
                inlineConfirm.isArmed("enable-auto-merge")
                  ? "Confirm auto-merge?"
                  : "Enable auto-merge"
              }
              disabled={actionPending}
              {...inlineConfirm.props(
                "enable-auto-merge",
                () => void perform("enable-auto-merge", selectedMergeMethod),
              )}
            >
              <PullRequestGlyph.merged className="size-3.5" />
              {inlineConfirm.isArmed("enable-auto-merge")
                ? "Confirm auto-merge?"
                : "Enable auto-merge"}
            </MenuItem>
          ) : null}
        </>
      ) : null}
      {updateMethods.length > 0 ? (
        <>
          {showsMergeMethods || showsMergeNow || showsAutoMerge ? <MenuSeparator /> : null}
          {updateMethods.map((method) => (
            <MenuItem
              key={method}
              disabled={actionPending}
              onClick={() => void perform("update-branch", undefined, method)}
            >
              <RefreshIcon size="sm" />
              {method === "rebase" ? "Update with rebase" : "Update branch"}
            </MenuItem>
          ))}
        </>
      ) : null}
      {showCheckout ? (
        <>
          {showsMergeMethods || showsMergeNow || showsAutoMerge || updateMethods.length > 0 ? (
            <MenuSeparator />
          ) : null}
          {checkoutMenuItems}
        </>
      ) : null}
    </>
  );
}
