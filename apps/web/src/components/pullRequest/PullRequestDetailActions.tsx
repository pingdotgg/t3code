import {
  type EnvironmentId,
  type PullRequestAction,
  type PullRequestMergeMethod,
  type PullRequestUpdateMethod,
} from "@t3tools/contracts";
import { CheckIcon, FolderGit2Icon, GitBranchIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
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
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { PullRequestGlyph } from "./pullRequestIcons";
import { changeRequestTermKind } from "./changeRequestTerm";
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
  const gt = useGT();
  return (
    <Button
      size="xs"
      variant="destructive-outline"
      disabled={handoff !== null || unavailable}
      onClick={onResolve}
    >
      <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
      {handoff === "conflicts" ? gt("Preparing...") : gt("Resolve conflicts")}
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
  const gt = useGT();
  return (
    <>
      <MenuItem
        disabled={handoff !== null || checkoutRoot === null || !canPrepareWorktree}
        onClick={() => onCheckout("worktree")}
      >
        <GitBranchIcon className="mt-1 size-3.5 shrink-0 self-start sm:mt-0.5" />
        <span className="flex min-w-0 flex-col">
          <span>
            {handoff === "checkout:worktree"
              ? gt("Checking out...")
              : gt("Check out in a worktree")}
          </span>
          <span className="text-meta text-muted-foreground">
            <T>Its own folder and thread. Nothing you have open moves.</T>
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
            {handoff === "checkout:local"
              ? gt("Checking out...")
              : gt("Check out in this repository")}
          </span>
          <span className="text-meta text-muted-foreground">
            <T>Switches the branch you are working in.</T>
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
  const gt = useGT();
  const actionPending = pendingAction !== null;
  // The merge, full width at the foot of the readiness card. One stable slot from waiting through
  // completion: conflicts take it while they need a person, and a finished pull request shows its
  // state there instead of a button.
  const primaryButton =
    primaryAction === "resolve" ? (
      <Button
        size="sm"
        variant="destructive-tint"
        className="flex-1"
        disabled={handoff !== null || unavailable}
        onClick={onResolve}
      >
        <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
        {handoff === "conflicts" ? gt("Preparing...") : gt("Resolve conflicts")}
      </Button>
    ) : primaryAction === "ready" ? (
      <Button
        size="sm"
        className="flex-1"
        disabled={actionPending}
        onClick={() => void perform("ready")}
      >
        <PullRequestGlyph.pullRequest aria-hidden className="size-3.5" />
        <T>Ready for review</T>
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
          ? gt("Enabling...")
          : inlineConfirm.isArmed("enable-auto-merge")
            ? gt("Confirm auto-merge?")
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
          ? gt("Merging...")
          : inlineConfirm.isArmed("merge")
            ? gt("Confirm merge?")
            : selectedMergeMethodLabel}
      </Button>
    ) : null;
  const primaryStatus =
    primaryButton !== null ? null : primaryAction === "auto-merge-armed" ? (
      <PullRequestStateBadge
        tone="info"
        icon={<PullRequestGlyph.merged aria-hidden className="size-3.5" />}
        label={armedAutoMergeLabel}
      />
    ) : null; // Merged and closed show their own badge in the same slot.
  return primaryButton ?? primaryStatus;
}

const STATE_BADGE_TONES = {
  info: "[--surface-tint:var(--info-foreground)] text-info-foreground",
  merged: "[--surface-tint:var(--merged-foreground)] text-merged-foreground",
  destructive: "[--surface-tint:var(--destructive-foreground)] text-destructive-foreground",
} as const;

/** What happened to the pull request, in the readiness card's action slot and its tint. */
export function PullRequestStateBadge({
  tone,
  icon,
  label,
}: {
  tone: keyof typeof STATE_BADGE_TONES;
  icon: ReactNode;
  label: string;
}) {
  return (
    <SharedTooltipTrigger
      render={
        <div
          data-slot="state-badge"
          className={cn(
            "surface-tint flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control px-3 text-label sm:h-7 [&>svg]:shrink-0",
            STATE_BADGE_TONES[tone],
          )}
        />
      }
      label={label}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </SharedTooltipTrigger>
  );
}

/** The chevron's options once a pull request is merged or closed. */
export function PullRequestFinishedMenuItems({
  state,
  singular,
  headBranch,
  canReopen,
  canRevert,
  showsDeleteBranch,
  environmentConnected,
  pendingAction,
  perform,
  inlineConfirm,
  confirmDeleteBranch,
}: {
  state: "merged" | "closed";
  singular: string;
  headBranch: string;
  canReopen: boolean;
  canRevert: boolean;
  showsDeleteBranch: boolean;
  environmentConnected: boolean;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  inlineConfirm: ReturnType<typeof useInlineActionConfirm>;
  confirmDeleteBranch: () => Promise<void>;
}) {
  const gt = useGT();
  const actionPending = pendingAction !== null;
  return (
    <>
      {state === "closed" && canReopen ? (
        <MenuItem disabled={actionPending} onClick={() => void perform("reopen")}>
          <PullRequestGlyph.reopen className="size-3.5" />
          {gt(
            "Reopen {term, select, mr {merge request} cr {change request} other {pull request}}",
            { term: changeRequestTermKind({ singular }) },
          )}
        </MenuItem>
      ) : null}
      {state === "merged" && canRevert ? (
        <MenuItem
          closeOnClick={inlineConfirm.isArmed("revert")}
          aria-label={
            inlineConfirm.isArmed("revert") ? gt("Confirm revert?") : gt("Revert changes")
          }
          variant={inlineConfirm.isArmed("revert") ? "destructive" : "default"}
          disabled={actionPending}
          {...inlineConfirm.props("revert", () => void perform("revert"))}
        >
          <RotateCcwIcon className="size-3.5" />
          {inlineConfirm.isArmed("revert") ? gt("Confirm revert?") : gt("Revert changes")}
        </MenuItem>
      ) : null}
      {showsDeleteBranch ? (
        <MenuItem
          variant="destructive"
          disabled={actionPending || !environmentConnected}
          onClick={() => void confirmDeleteBranch()}
        >
          <Trash2Icon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>
              {pendingAction === "delete-branch" ? gt("Deleting branch...") : gt("Delete branch")}
            </span>
            <span className="truncate text-caption text-muted-foreground">
              {environmentConnected ? headBranch : gt("Reconnect to delete this branch")}
            </span>
          </span>
        </MenuItem>
      ) : null}
    </>
  );
}

/** Closes an open pull request on a second press; the overflow menu and the merge menu share it. */
export function PullRequestCloseMenuItem({
  singular,
  actionPending,
  perform,
  inlineConfirm,
}: {
  singular: string;
  actionPending: boolean;
  perform: PerformPullRequestAction;
  inlineConfirm: ReturnType<typeof useInlineActionConfirm>;
}) {
  const gt = useGT();
  const armed = inlineConfirm.isArmed("close");
  const label = armed
    ? gt("Confirm close?")
    : gt("Close {term, select, mr {merge request} cr {change request} other {pull request}}", {
        term: changeRequestTermKind({ singular }),
      });
  return (
    <MenuItem
      closeOnClick={armed}
      aria-label={label}
      variant="destructive"
      disabled={actionPending}
      {...inlineConfirm.props("close", () => void perform("close"))}
    >
      <PullRequestGlyph.closed className="size-3.5" />
      {label}
    </MenuItem>
  );
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
  showsClose,
  singular,
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
  showsClose: boolean;
  singular: string;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const actionPending = pendingAction !== null;
  return (
    <>
      {showsMergeMethods ? (
        <MenuGroup>
          <MenuGroupLabel>
            <T>Merge method</T>
          </MenuGroupLabel>
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
                  <span>{resolve(PULL_REQUEST_MERGE_METHOD_LABELS[method])}</span>
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
              aria-label={inlineConfirm.isArmed("merge") ? gt("Confirm merge?") : gt("Merge now")}
              disabled={actionPending}
              {...inlineConfirm.props("merge", () => void perform("merge", selectedMergeMethod))}
            >
              <PullRequestGlyph.merged className="size-3.5" />
              {inlineConfirm.isArmed("merge") ? gt("Confirm merge?") : gt("Merge now")}
            </MenuItem>
          ) : null}
          {autoMergeArmed && can("disable-auto-merge") ? (
            <MenuItem disabled={actionPending} onClick={() => void perform("disable-auto-merge")}>
              <PullRequestGlyph.merged className="size-3.5" />
              <T>Disable auto-merge</T>
            </MenuItem>
          ) : showsAutoMerge ? (
            <MenuItem
              closeOnClick={inlineConfirm.isArmed("enable-auto-merge")}
              aria-label={
                inlineConfirm.isArmed("enable-auto-merge")
                  ? gt("Confirm auto-merge?")
                  : gt("Enable auto-merge")
              }
              disabled={actionPending}
              {...inlineConfirm.props(
                "enable-auto-merge",
                () => void perform("enable-auto-merge", selectedMergeMethod),
              )}
            >
              <PullRequestGlyph.merged className="size-3.5" />
              {inlineConfirm.isArmed("enable-auto-merge")
                ? gt("Confirm auto-merge?")
                : gt("Enable auto-merge")}
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
              {method === "rebase" ? gt("Update with rebase") : gt("Update branch")}
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
      {showsClose ? (
        <>
          {showsMergeMethods ||
          showsMergeNow ||
          showsAutoMerge ||
          updateMethods.length > 0 ||
          showCheckout ? (
            <MenuSeparator />
          ) : null}
          <PullRequestCloseMenuItem
            singular={singular}
            actionPending={actionPending}
            perform={perform}
            inlineConfirm={inlineConfirm}
          />
        </>
      ) : null}
    </>
  );
}
