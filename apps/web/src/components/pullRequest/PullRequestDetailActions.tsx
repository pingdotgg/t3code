import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestDetail,
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
import { PullRequestPermissionButton } from "./PullRequestPermissionButton";
import { useInlineActionConfirm } from "./useInlineActionConfirm";

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
}: {
  handoff: string | null;
  checkoutRoot: string | null;
  canPrepareWorktree: boolean;
  canCheckoutHere: boolean;
  onCheckout: (mode: "worktree" | "local") => void;
  pickableEnvironments: ReadonlyArray<PickableEnvironment>;
  actingEnvironmentId: EnvironmentId;
  onActingEnvironmentChange: (environmentId: EnvironmentId) => void;
}) {
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
                  aria-label={handoff?.startsWith("checkout") ? "Checking out..." : "Check out"}
                >
                  <GitBranchIcon aria-hidden className="size-3.5" />
                  <span className="@max-[35rem]/pr-header:hidden">
                    {handoff?.startsWith("checkout") ? "Checking out..." : "Check out"}
                  </span>
                  <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
                </Button>
              }
            />
          }
        />
        <TooltipPopup>Check out this pull request</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuItem disabled={!canPrepareWorktree} onClick={() => onCheckout("worktree")}>
          <GitBranchIcon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>In a separate worktree</span>
            <span className="text-xs text-muted-foreground">
              Its own folder and thread. Nothing you have open moves.
            </span>
          </span>
        </MenuItem>
        <MenuItem disabled={!canCheckoutHere} onClick={() => onCheckout("local")}>
          <FolderGit2Icon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>In this repository</span>
            <span className="text-xs text-muted-foreground">
              Switches the branch you are working in, like `gh pr checkout`.
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
              aria-label={handoff === "conflicts" ? "Preparing..." : "Resolve conflicts"}
            >
              <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
              <span className="@max-[30rem]/pr-header:hidden">
                {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts"}
              </span>
            </Button>
          </span>
        }
      />
      <TooltipPopup side="top">
        {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts"}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The header's one prominent control, which depends on where the pull request stands. */
export function PullRequestPrimaryAction({
  pullRequestKey,
  primaryAction,
  autoMergeArmed,
  armedAutoMergeLabel,
  pendingAutoMergeLabel,
  selectedMergeMethod,
  selectedMergeMethodLabel,
  statePresentation,
  pendingAction,
  perform,
  resolveConflicts,
  readyLabel,
  readyReason,
  denied,
}: {
  pullRequestKey: string;
  primaryAction: ReturnType<typeof resolvePullRequestPrimaryControl> | null;
  autoMergeArmed: boolean;
  armedAutoMergeLabel: string;
  pendingAutoMergeLabel: string;
  selectedMergeMethod: PullRequestMergeMethod;
  selectedMergeMethodLabel: string;
  statePresentation: ReturnType<typeof resolvePullRequestState> | null;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  resolveConflicts: ReactNode;
  readyLabel: string;
  readyReason: string | undefined;
  denied: NonNullable<PullRequestDetail["viewerPermissions"]["deniedActions"]>;
}) {
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
            {armedAutoMergeLabel}: the host will merge this on its own once its requirements are met
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {primaryAction === "resolve" ? (
        resolveConflicts
      ) : primaryAction === "ready" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={readyReason ? 0 : undefined}
                className="inline-flex shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Button
                  size="xs"
                  variant="default"
                  disabled={actionPending || Boolean(readyReason)}
                  onClick={() => {
                    if (!readyReason) void perform("ready");
                  }}
                  aria-label={pendingAction === "ready" ? "Publishing…" : readyLabel}
                >
                  <PullRequestGlyph.pullRequest aria-hidden className="size-3.5" />
                  <span className="@max-[30rem]/pr-header:hidden">
                    {pendingAction === "ready" ? "Publishing…" : readyLabel}
                  </span>
                </Button>
              </span>
            }
          />
          <TooltipPopup side="top">{readyReason ?? readyLabel}</TooltipPopup>
        </Tooltip>
      ) : primaryAction === "enable-auto-merge" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={denied["enable-auto-merge"] ? 0 : undefined}
                className="inline-flex shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Button
                  size="xs"
                  variant="default"
                  disabled={actionPending || Boolean(denied["enable-auto-merge"])}
                  {...inlineConfirm.props(
                    "enable-auto-merge",
                    () => void perform("enable-auto-merge", selectedMergeMethod),
                  )}
                  aria-label={
                    pendingAction === "enable-auto-merge"
                      ? "Enabling..."
                      : inlineConfirm.isArmed("enable-auto-merge")
                        ? "Confirm auto-merge?"
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
                          ? "Enabling..."
                          : inlineConfirm.isArmed("enable-auto-merge")
                            ? "Confirm auto-merge?"
                            : pendingAutoMergeLabel}
                      </span>
                    </span>
                  </AnimatedWidth>
                </Button>
              </span>
            }
          />
          <TooltipPopup side="top">
            {denied["enable-auto-merge"] ??
              (pendingAction === "enable-auto-merge"
                ? "Enabling..."
                : inlineConfirm.isArmed("enable-auto-merge")
                  ? "Confirm auto-merge?"
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
            {armedAutoMergeLabel}: the host will merge this on its own once its requirements are met
          </TooltipPopup>
        </Tooltip>
      ) : primaryAction === "merge" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={denied["merge"] ? 0 : undefined}
                className="inline-flex shrink-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Button
                  size="xs"
                  variant="default"
                  disabled={actionPending || Boolean(denied["merge"])}
                  {...inlineConfirm.props(
                    "merge",
                    () => void perform("merge", selectedMergeMethod),
                  )}
                  aria-label={
                    pendingAction === "merge"
                      ? "Merging..."
                      : inlineConfirm.isArmed("merge")
                        ? "Confirm merge?"
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
                          ? "Merging..."
                          : inlineConfirm.isArmed("merge")
                            ? "Confirm merge?"
                            : selectedMergeMethodLabel}
                      </span>
                    </span>
                  </AnimatedWidth>
                </Button>
              </span>
            }
          />
          <TooltipPopup side="top">
            {denied["merge"] ??
              (pendingAction === "merge"
                ? "Merging..."
                : inlineConfirm.isArmed("merge")
                  ? "Confirm merge?"
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
  reason,
}: {
  pullRequestKey: string;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  reason: string | undefined;
}) {
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
  const actionPending = pendingAction !== null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="ml-auto inline-flex shrink-0">
            <PullRequestPermissionButton
              size="xs"
              variant="warning-outline"
              disabled={actionPending}
              reason={reason}
              {...inlineConfirm.props("approve-workflows", () => void perform("approve-workflows"))}
              aria-label={
                pendingAction === "approve-workflows"
                  ? "Approving..."
                  : inlineConfirm.isArmed("approve-workflows")
                    ? "Confirm approve?"
                    : "Approve workflows to run"
              }
            >
              <PlayIcon aria-hidden className="size-3.5" />
              <span className="inline-grid">
                <span aria-hidden className="invisible col-start-1 row-start-1">
                  Approve workflows to run
                </span>
                <span aria-hidden className="invisible col-start-1 row-start-1">
                  Confirm approve?
                </span>
                <span className="col-start-1 row-start-1">
                  {pendingAction === "approve-workflows"
                    ? "Approving..."
                    : inlineConfirm.isArmed("approve-workflows")
                      ? "Confirm approve?"
                      : "Approve workflows to run"}
                </span>
              </span>
            </PullRequestPermissionButton>
          </span>
        }
      />
      <TooltipPopup side="top">
        {pendingAction === "approve-workflows"
          ? "Approving..."
          : inlineConfirm.isArmed("approve-workflows")
            ? "Confirm approve?"
            : "Approve workflows to run"}
      </TooltipPopup>
    </Tooltip>
  );
}
