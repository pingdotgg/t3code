import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  CopyIcon,
  HammerIcon,
  LinkIcon,
  MessageCircleQuestionIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";

import { shortcutLabelForCommand } from "~/keybindings";
import { readLocalApi } from "~/localApi";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ActOnEnvironmentPicker, type PerformPullRequestAction } from "./PullRequestDetailActions";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  pullRequestActionMenuHasGroup,
} from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import type { PickableEnvironment } from "./pullRequestProjectAssignment.logic";
import { PullRequestThreadLinks } from "./PullRequestThreadLinks";
import { AzureDevOpsPullRequestActions } from "./AzureDevOpsPullRequestActions";
import { PullRequestPermissionMenuItem } from "./PullRequestPermissionButton";
import { useInlineActionConfirm } from "./useInlineActionConfirm";

/** Everything else the reader can do with the pull request, behind the header's overflow button. */
export function PullRequestActionsMenu({
  environmentId,
  reference,
  pullRequestKey,
  detail,
  linkThreadRef,
  onThreadPickerOpenChange,
  refreshing,
  refreshFromHost,
  handoff,
  attachesToComposer,
  askAboutPullRequest,
  explainPullRequest,
  canFixFindings,
  startFixFindings,
  handoffLabels,
  canWriteGuide,
  guideRunning,
  guideWritten,
  writeGuide,
  pickableEnvironments,
  actingEnvironmentId,
  onActingEnvironmentChange,
  can,
  autoMergeArmed,
  showsDraftToggle,
  showsMergeNow,
  showsAutoMerge,
  showsMergeMethods,
  allowedMergeMethods,
  selectedMergeMethod,
  onSelectMergeMethod,
  showsDeleteBranch,
  environmentConnected,
  confirmDeleteBranch,
  pendingAction,
  perform,
  openOnHostText,
  copyReference,
  showResolveConflicts,
  resolveConflictsUnavailable,
  onResolveConflicts,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  pullRequestKey: string;
  detail: PullRequestDetail;
  linkThreadRef: ScopedThreadRef | null;
  onThreadPickerOpenChange: (open: boolean) => void;
  refreshing: boolean;
  refreshFromHost: () => Promise<void>;
  handoff: string | null;
  attachesToComposer: boolean;
  askAboutPullRequest: () => void;
  explainPullRequest: () => void;
  canFixFindings: boolean;
  startFixFindings: () => void;
  handoffLabels: { readonly fixFindings: string };
  canWriteGuide: boolean;
  guideRunning: boolean;
  guideWritten: boolean;
  writeGuide: () => void;
  pickableEnvironments: ReadonlyArray<PickableEnvironment>;
  actingEnvironmentId: EnvironmentId;
  onActingEnvironmentChange: (environmentId: EnvironmentId) => void;
  can: (action: PullRequestAction) => boolean;
  autoMergeArmed: boolean;
  showsDraftToggle: boolean;
  showsMergeNow: boolean;
  showsAutoMerge: boolean;
  showsMergeMethods: boolean;
  allowedMergeMethods: ReadonlyArray<PullRequestMergeMethod>;
  selectedMergeMethod: PullRequestMergeMethod;
  onSelectMergeMethod: (method: PullRequestMergeMethod) => void;
  showsDeleteBranch: boolean;
  environmentConnected: boolean;
  confirmDeleteBranch: () => Promise<void>;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  openOnHostText: string;
  copyReference: (value: string, label: string) => void;
  showResolveConflicts: boolean;
  resolveConflictsUnavailable: boolean;
  onResolveConflicts: () => void;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
  const actionPending = pendingAction !== null;
  const denied = detail.viewerPermissions.deniedActions ?? {};
  const readyLabel = detail.provider === "azure-devops" ? "Publish" : "Ready for review";
  return (
    <AzureDevOpsPullRequestActions
      environmentId={environmentId}
      reference={reference}
      detail={detail}
    >
      {(azureMenu) => (
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      aria-label={
                        refreshing ? "Refreshing pull request" : "More pull request actions"
                      }
                      size="icon-xs"
                      variant="ghost-muted"
                    />
                  }
                >
                  {/* The refresh lives in this menu, so while one runs the trigger wears
                            the spinning glyph in place of the dots: the reader sees the panel
                            is fetching without a control appearing or the row shifting. */}
                  {refreshing ? (
                    <RefreshIcon refreshing size="md" />
                  ) : (
                    <MoreHorizontalIcon className="size-4" />
                  )}
                </MenuTrigger>
              }
            />
            <TooltipPopup>
              {refreshing ? "Refreshing pull request" : "More pull request actions"}
            </TooltipPopup>
          </Tooltip>
          <MenuPopup align="end" side="bottom">
            <PullRequestThreadLinks
              display="menu-item"
              environmentId={environmentId}
              reference={reference}
              url={detail.url}
              threadRef={linkThreadRef}
              onPickerOpenChange={onThreadPickerOpenChange}
            />
            <MenuItem disabled={refreshing} onClick={() => void refreshFromHost()}>
              <RefreshIcon size="sm" refreshing={refreshing} />
              Refresh
            </MenuItem>
            {showResolveConflicts ? (
              <MenuItem
                disabled={handoff !== null || resolveConflictsUnavailable}
                onClick={onResolveConflicts}
              >
                <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
                {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts"}
              </MenuItem>
            ) : null}
            <MenuItem disabled={handoff !== null} onClick={askAboutPullRequest}>
              <MessageCircleQuestionIcon className="mt-1 size-3.5 shrink-0 self-start" />
              <span className="flex min-w-0 flex-col">
                <span>{handoff === "ask" ? "Opening..." : "Ask a question"}</span>
                <span className="text-xs text-muted-foreground">
                  {attachesToComposer
                    ? "Adds the pull request to this thread's composer."
                    : "Opens a thread that knows which pull request you mean."}
                </span>
              </span>
            </MenuItem>
            <MenuItem disabled={handoff !== null} onClick={explainPullRequest}>
              <BookOpenIcon className="mt-1 size-3.5 shrink-0 self-start" />
              <span className="flex min-w-0 flex-col">
                <span>{handoff === "explain" ? "Opening..." : "Explain this PR"}</span>
                <span className="text-xs text-muted-foreground">
                  A walk through the diff and what to read closely.
                </span>
              </span>
            </MenuItem>
            <MenuItem disabled={handoff !== null || !canFixFindings} onClick={startFixFindings}>
              <HammerIcon className="size-3.5" />
              {handoff === "findings" ? "Preparing..." : handoffLabels.fixFindings}
            </MenuItem>
            {canWriteGuide ? (
              <MenuItem disabled={guideRunning} onClick={writeGuide}>
                <SparklesIcon className="size-3.5" />
                {guideRunning
                  ? "Writing guide..."
                  : !guideWritten
                    ? "Write guide"
                    : "Rewrite guide"}
              </MenuItem>
            ) : null}
            {pickableEnvironments.length > 0 ? (
              <ActOnEnvironmentPicker
                environments={pickableEnvironments}
                value={actingEnvironmentId}
                onChange={onActingEnvironmentChange}
                disabled={handoff !== null}
              />
            ) : null}
            <MenuSeparator />
            {detail.state === "open" ? (
              <>
                {/* Only where the button row could not take it: "Ready for review" on a
                          draft is the primary header button, so offering it here as well would
                          show the same action twice. */}
                {showsDraftToggle ? (
                  <PullRequestPermissionMenuItem
                    disabled={actionPending || Boolean(denied[detail.isDraft ? "ready" : "draft"])}
                    reason={denied[detail.isDraft ? "ready" : "draft"]}
                    onClick={() => void perform(detail.isDraft ? "ready" : "draft")}
                  >
                    {detail.isDraft ? (
                      <PullRequestGlyph.pullRequest className="size-3.5" />
                    ) : (
                      <PullRequestGlyph.draft className="size-3.5" />
                    )}
                    {detail.isDraft ? readyLabel : "Convert to draft"}
                  </PullRequestPermissionMenuItem>
                ) : null}
                {showsMergeNow ? (
                  <PullRequestPermissionMenuItem
                    closeOnClick={inlineConfirm.isArmed("merge")}
                    aria-label={inlineConfirm.isArmed("merge") ? "Confirm merge?" : "Merge now"}
                    disabled={actionPending || Boolean(denied["merge"])}
                    reason={denied["merge"]}
                    {...inlineConfirm.props(
                      "merge",
                      () => void perform("merge", selectedMergeMethod),
                    )}
                  >
                    <PullRequestGlyph.merged className="size-3.5" />
                    {inlineConfirm.isArmed("merge") ? "Confirm merge?" : "Merge now"}
                  </PullRequestPermissionMenuItem>
                ) : null}
                {/* The same merge, left with the host to carry out once its requirements
                          pass. A conflicting branch cannot be armed because nothing the host
                          waits for will clear the conflict. */}
                {autoMergeArmed && can("disable-auto-merge") ? (
                  <PullRequestPermissionMenuItem
                    disabled={actionPending || Boolean(denied["disable-auto-merge"])}
                    reason={denied["disable-auto-merge"]}
                    onClick={() => void perform("disable-auto-merge")}
                  >
                    <PullRequestGlyph.merged className="size-3.5" />
                    Disable auto-merge
                  </PullRequestPermissionMenuItem>
                ) : showsAutoMerge ? (
                  <PullRequestPermissionMenuItem
                    closeOnClick={inlineConfirm.isArmed("enable-auto-merge")}
                    aria-label={
                      inlineConfirm.isArmed("enable-auto-merge")
                        ? "Confirm auto-merge?"
                        : "Enable auto-merge"
                    }
                    disabled={actionPending || Boolean(denied["enable-auto-merge"])}
                    reason={denied["enable-auto-merge"]}
                    {...inlineConfirm.props(
                      "enable-auto-merge",
                      () => void perform("enable-auto-merge", selectedMergeMethod),
                    )}
                  >
                    <PullRequestGlyph.merged className="size-3.5" />
                    {inlineConfirm.isArmed("enable-auto-merge")
                      ? "Confirm auto-merge?"
                      : "Enable auto-merge"}
                  </PullRequestPermissionMenuItem>
                ) : null}
                {/* A preference for the merge action rather than a second action, so it
                          is a radio group here instead of a chevron welded to the Merge pill.
                          Hidden while conflicting: every method would fail. */}
                {/* Only where merging is on offer at all: a strategy to merge with is not
                          a choice for someone who may not merge. */}
                {showsMergeMethods ? (
                  <>
                    {/* Only below the draft control. A host with no draft of its own, or
                              a draft whose control is already the header button, would leave
                              this against the separator that opened the group. */}
                    {showsDraftToggle || showsMergeNow || showsAutoMerge ? <MenuSeparator /> : null}
                    <MenuRadioGroup
                      value={selectedMergeMethod}
                      onValueChange={(method) =>
                        onSelectMergeMethod(method as PullRequestMergeMethod)
                      }
                    >
                      {allowedMergeMethods.map((method) => (
                        <MenuRadioItem
                          key={method}
                          value={method}
                          disabled={actionPending}
                          closeOnClick
                        >
                          {/* The radio item lays its children out as one block, so the
                                    icon and the label need their own row to share a line. */}
                          <span className="flex min-w-0 items-center gap-2">
                            <PullRequestGlyph.merged className="size-3.5" />
                            <span>{PULL_REQUEST_MERGE_METHOD_LABELS[method]}</span>
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </>
                ) : null}
                {pullRequestActionMenuHasGroup(
                  showsDraftToggle,
                  showsAutoMerge || showsMergeNow,
                  showsMergeMethods,
                ) ? (
                  <MenuSeparator />
                ) : null}
              </>
            ) : null}
            {azureMenu}
            <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}>
              <ArrowUpRightIcon className="size-3.5" />
              {openOnHostText}
            </MenuItem>
            <MenuItem onClick={() => copyReference(detail.url, "PR link")}>
              <LinkIcon className="size-3.5" />
              Copy link
              <MenuShortcut>
                {shortcutLabelForCommand(keybindings, "thread.copyReference")}
              </MenuShortcut>
            </MenuItem>
            <MenuItem onClick={() => copyReference(`#${reference.number}`, "PR number")}>
              <CopyIcon className="size-3.5" />
              Copy PR number
              <MenuShortcut>
                {shortcutLabelForCommand(keybindings, "pullRequest.copyNumber")}
              </MenuShortcut>
            </MenuItem>
            {detail.state === "open" && can("close") ? (
              <>
                <MenuSeparator />
                <PullRequestPermissionMenuItem
                  closeOnClick={inlineConfirm.isArmed("close")}
                  aria-label={
                    inlineConfirm.isArmed("close") ? "Confirm close?" : "Close pull request"
                  }
                  variant="destructive"
                  disabled={actionPending || Boolean(denied["close"])}
                  reason={denied["close"]}
                  {...inlineConfirm.props("close", () => void perform("close"))}
                >
                  <PullRequestGlyph.closed className="size-3.5" />
                  {inlineConfirm.isArmed("close") ? "Confirm close?" : "Close pull request"}
                </PullRequestPermissionMenuItem>
              </>
            ) : detail.state === "closed" && can("reopen") ? (
              <>
                <MenuSeparator />
                <PullRequestPermissionMenuItem
                  disabled={actionPending || Boolean(denied["reopen"])}
                  reason={denied["reopen"]}
                  onClick={() => void perform("reopen")}
                >
                  <PullRequestGlyph.reopen className="size-3.5" />
                  Reopen pull request
                </PullRequestPermissionMenuItem>
              </>
            ) : detail.state === "merged" && can("revert") ? (
              <>
                <MenuSeparator />
                <PullRequestPermissionMenuItem
                  closeOnClick={inlineConfirm.isArmed("revert")}
                  aria-label={
                    inlineConfirm.isArmed("revert") ? "Confirm revert?" : "Revert changes"
                  }
                  variant={inlineConfirm.isArmed("revert") ? "destructive" : "default"}
                  disabled={actionPending || Boolean(denied["revert"])}
                  reason={denied["revert"]}
                  {...inlineConfirm.props("revert", () => void perform("revert"))}
                >
                  <RotateCcwIcon className="size-3.5" />
                  {inlineConfirm.isArmed("revert") ? "Confirm revert?" : "Revert changes"}
                </PullRequestPermissionMenuItem>
              </>
            ) : null}
            {showsDeleteBranch ? (
              <>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  disabled={actionPending || !environmentConnected}
                  onClick={() => void confirmDeleteBranch()}
                >
                  <Trash2Icon className="mt-1 size-3.5 shrink-0 self-start" />
                  <span className="flex min-w-0 flex-col">
                    <span>
                      {pendingAction === "delete-branch" ? "Deleting branch..." : "Delete branch"}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {environmentConnected ? detail.headBranch : "Reconnect to delete this branch"}
                    </span>
                  </span>
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      )}
    </AzureDevOpsPullRequestActions>
  );
}
