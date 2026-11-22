import { useId, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  canEditPullRequestMaintainerEdits,
  maintainerEditsChoiceInForce,
  type MaintainerEditsChoice,
} from "@t3tools/client-runtime/pull-request-editing";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
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
  ArrowDownUpIcon,
  BookOpenIcon,
  CopyIcon,
  HammerIcon,
  LinkIcon,
  LayoutPanelTopIcon,
  MessageCircleQuestionIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  Trash2Icon,
  FolderGit2Icon,
  PencilIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { Branch, msg, T, useGT, useMessages, Var } from "gt-react";

import { useOpenLink } from "~/browser/useOpenLink";
import { m } from "~/i18n/messages";

import { shortcutLabelForCommand } from "~/keybindings";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
  MenuGroup,
  MenuGroupLabel,
} from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ActOnEnvironmentPicker, type PerformPullRequestAction } from "./PullRequestDetailActions";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  pullRequestActionMenuHasGroup,
  readableFailure,
} from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import { type PickableEnvironment } from "./pullRequestProjectAssignment.logic";
import { PullRequestThreadLinks } from "./PullRequestThreadLinks";
import { useInlineActionConfirm } from "./useInlineActionConfirm";
import { canEditPullRequestChangeRequest } from "@t3tools/client-runtime/pull-request-editing";

import { changeRequestTermKind } from "./changeRequestTerm";

/** Everything else the reader can do with the pull request, behind the header's overflow button. */
export function PullRequestActionsMenu({
  environmentId,
  reference,
  pullRequestKey,
  detail,
  terminology,
  threadRef,
  linkThreadRef,
  onOpenAsWorkspace,
  onThreadPickerOpenChange,
  refreshing,
  refreshFromHost,
  timelineOrder,
  onToggleTimelineOrder,
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
  canWriteSourceControl,
  onMaintainerEditsSaved,
  confirmDeleteBranch,
  pendingAction,
  perform,
  openOnHostText,
  copyReference,
  inlineConfirm,
  showCheckout,
  checkoutMenuItems,
  onEditTitle,
  repositoryUrl,
  checkoutCommand,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  pullRequestKey: string;
  detail: PullRequestDetail;
  terminology: ChangeRequestTerminology;
  threadRef: ScopedThreadRef | null;
  linkThreadRef: ScopedThreadRef | null;
  onOpenAsWorkspace?: (() => void) | undefined;
  onThreadPickerOpenChange: (open: boolean) => void;
  refreshing: boolean;
  refreshFromHost: () => Promise<void>;
  timelineOrder: "newest" | "oldest" | null;
  onToggleTimelineOrder: () => void;
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
  canWriteSourceControl: boolean;
  onMaintainerEditsSaved: () => void;
  confirmDeleteBranch: () => Promise<void>;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  openOnHostText: string;
  copyReference: (value: string, failureTitle: string) => void;
  inlineConfirm: ReturnType<typeof useInlineActionConfirm>;
  showCheckout: boolean;
  checkoutMenuItems: ReactNode;
  onEditTitle: () => void;
  repositoryUrl: string | null;
  checkoutCommand: string | null;
}) {
  const gt = useGT();
  const openLink = useOpenLink(threadRef);
  const resolve = useMessages();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const actionPending = pendingAction !== null;
  const maintainerEditsHintId = useId();
  const updatePullRequest = useAtomCommand(pullRequestEnvironment.update, {
    reportFailure: false,
  });
  const [maintainerEditsChoice, setMaintainerEditsChoice] = useState<MaintainerEditsChoice | null>(
    null,
  );
  const [maintainerEditsSaving, setMaintainerEditsSaving] = useState(false);
  const maintainerEditsChoiceKept = maintainerEditsChoiceInForce(
    maintainerEditsChoice,
    pullRequestKey,
    detail.observedAt,
    maintainerEditsSaving,
  );
  if (maintainerEditsChoiceKept !== maintainerEditsChoice) {
    setMaintainerEditsChoice(maintainerEditsChoiceKept);
  }
  const maintainerCanModify = maintainerEditsChoiceKept?.value ?? detail.maintainerCanModify;
  const canSaveMaintainerEdits =
    canWriteSourceControl && environmentConnected && !maintainerEditsSaving;
  const saveMaintainerEdits = async (value: boolean) => {
    if (!canSaveMaintainerEdits) return;
    const previousChoice = maintainerEditsChoice;
    setMaintainerEditsChoice({ key: pullRequestKey, observedAt: detail.observedAt, value });
    setMaintainerEditsSaving(true);
    const result = await updatePullRequest({
      environmentId,
      input: { ...reference, maintainerCanModify: value },
    });
    setMaintainerEditsSaving(false);
    if (result._tag === "Failure") {
      setMaintainerEditsChoice(previousChoice);
      toastManager.add({
        type: "error",
        title: m(msg("Could not save maintainer access")),
        description: readableFailure(squashAtomCommandFailure(result), m(msg("Try again."))),
      });
      return;
    }
    onMaintainerEditsSaved();
  };
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label={
                    refreshing
                      ? gt(
                          "Refreshing {term, select, mr {merge request} cr {change request} other {pull request}}",
                          { term: changeRequestTermKind(terminology) },
                        )
                      : gt(
                          "More {term, select, mr {merge request} cr {change request} other {pull request}} actions",
                          { term: changeRequestTermKind(terminology) },
                        )
                  }
                  size="icon-xs"
                  variant="ghost-muted"
                />
              }
            >
              {refreshing ? (
                <RefreshIcon refreshing size="md" />
              ) : (
                <MoreHorizontalIcon className="size-4" />
              )}
            </MenuTrigger>
          }
        />
        <TooltipPopup>
          {refreshing
            ? gt(
                "Refreshing {term, select, mr {merge request} cr {change request} other {pull request}}",
                { term: changeRequestTermKind(terminology) },
              )
            : gt(
                "More {term, select, mr {merge request} cr {change request} other {pull request}} actions",
                { term: changeRequestTermKind(terminology) },
              )}
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
          <T context="verb, menu item">Refresh</T>
        </MenuItem>
        {timelineOrder !== null ? (
          <MenuItem onClick={onToggleTimelineOrder}>
            <ArrowDownUpIcon className="size-3.5" />
            {timelineOrder === "newest"
              ? gt("Show oldest activity first")
              : gt("Show newest activity first")}
          </MenuItem>
        ) : null}
        <MenuItem disabled={handoff !== null} onClick={askAboutPullRequest}>
          <MessageCircleQuestionIcon className="mt-1 size-3.5 shrink-0 self-start sm:mt-0.5" />
          <span className="flex min-w-0 flex-col">
            <span>{handoff === "ask" ? gt("Opening...") : gt("Ask a question")}</span>
            <span className="text-meta text-muted-foreground">
              {attachesToComposer
                ? gt(
                    "Adds the {term, select, mr {merge request} cr {change request} other {pull request}} to this thread's composer.",
                    { term: changeRequestTermKind(terminology) },
                  )
                : gt(
                    "Opens a thread that knows which {term, select, mr {merge request} cr {change request} other {pull request}} you mean.",
                    {
                      term: changeRequestTermKind(terminology),
                    },
                  )}
            </span>
          </span>
        </MenuItem>
        <MenuItem disabled={handoff !== null} onClick={explainPullRequest}>
          <BookOpenIcon className="mt-1 size-3.5 shrink-0 self-start sm:mt-0.5" />
          <span className="flex min-w-0 flex-col">
            <span>
              {handoff === "explain"
                ? gt("Opening...")
                : gt("Explain this {term, select, mr {MR} cr {change request} other {PR}}", {
                    term: changeRequestTermKind(terminology),
                  })}
            </span>
            <span className="text-meta text-muted-foreground">
              <T>A walk through the diff and what to read closely.</T>
            </span>
          </span>
        </MenuItem>
        <MenuItem disabled={handoff !== null || !canFixFindings} onClick={startFixFindings}>
          <HammerIcon className="size-3.5" />
          {handoff === "findings" ? gt("Preparing...") : handoffLabels.fixFindings}
        </MenuItem>
        {canWriteGuide ? (
          <MenuItem disabled={guideRunning} onClick={writeGuide}>
            <ScrollTextIcon className="size-3.5" />
            {guideRunning
              ? gt("Writing guide...")
              : !guideWritten
                ? gt("Write guide")
                : gt("Rewrite guide")}
          </MenuItem>
        ) : null}
        {onOpenAsWorkspace ? (
          // Its own workspace: the chat with its terminal, and this panel beside it.
          <MenuItem onClick={onOpenAsWorkspace}>
            <LayoutPanelTopIcon className="size-3.5" />
            <T>Open as workspace</T>
          </MenuItem>
        ) : null}
        {showCheckout ? (
          <>
            <MenuSeparator />
            {checkoutMenuItems}
          </>
        ) : null}
        {pickableEnvironments.length > 0 ? (
          <ActOnEnvironmentPicker
            environments={pickableEnvironments}
            value={actingEnvironmentId}
            onChange={(next) => onActingEnvironmentChange(next)}
            disabled={handoff !== null}
          />
        ) : null}
        <MenuSeparator />
        {canEditPullRequestMaintainerEdits(detail) ? (
          <>
            <MenuCheckboxItem
              variant="icon"
              checked={maintainerCanModify === true}
              disabled={!canSaveMaintainerEdits}
              closeOnClick={false}
              aria-label={gt("Allow edits from maintainers")}
              aria-describedby={maintainerEditsHintId}
              onCheckedChange={(value) => void saveMaintainerEdits(value)}
            >
              <span className="flex max-w-xs flex-col gap-0.5">
                <span>
                  <T>Allow edits from maintainers</T>
                </span>
                <span id={maintainerEditsHintId} className="text-meta text-muted-foreground">
                  <T>
                    Maintainers can push to this branch. If your fork has workflows, this can also
                    give access to its secrets.
                  </T>
                </span>
                {maintainerEditsSaving ? (
                  <span role="status" className="text-meta text-muted-foreground">
                    <T>Saving…</T>
                  </span>
                ) : null}
              </span>
            </MenuCheckboxItem>
            <MenuSeparator />
          </>
        ) : null}
        {detail.state === "open" ? (
          <>
            {showsDraftToggle ? (
              <MenuItem
                disabled={actionPending}
                onClick={() => void perform(detail.isDraft ? "ready" : "draft")}
              >
                {detail.isDraft ? (
                  <PullRequestGlyph.pullRequest className="size-3.5" />
                ) : (
                  <PullRequestGlyph.draft className="size-3.5" />
                )}
                {detail.isDraft ? gt("Ready for review") : gt("Convert to draft")}
              </MenuItem>
            ) : null}
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
            {showsMergeMethods ? (
              <>
                {showsDraftToggle || showsMergeNow || showsAutoMerge ? <MenuSeparator /> : null}
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
                      <MenuRadioItem
                        key={method}
                        value={method}
                        disabled={actionPending}
                        closeOnClick
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <PullRequestGlyph.merged className="size-3.5" />
                          <span>{resolve(PULL_REQUEST_MERGE_METHOD_LABELS[method])}</span>
                        </span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
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
        {canEditPullRequestChangeRequest(detail) ? (
          <MenuItem onClick={() => onEditTitle()}>
            <PencilIcon className="size-3.5" />
            <T>Edit title</T>
          </MenuItem>
        ) : null}
        <MenuItem onClick={(event) => void openLink(detail.url, { event }).catch(console.error)}>
          <ArrowUpRightIcon className="size-3.5" />
          {openOnHostText}
        </MenuItem>
        {repositoryUrl ? (
          <MenuItem
            onClick={(event) => void openLink(repositoryUrl, { event }).catch(console.error)}
          >
            <FolderGit2Icon className="size-3.5" />
            <T>
              Open <Var>{detail.repository}</Var>
            </T>
          </MenuItem>
        ) : null}
        <MenuItem
          onClick={() =>
            copyReference(
              detail.url,
              resolve(
                msg("Failed to copy {term, select, mr {MR} cr {change request} other {PR}} link", {
                  term: changeRequestTermKind(terminology),
                }),
              ),
            )
          }
        >
          <LinkIcon className="size-3.5" />
          <T>Copy link</T>
          <MenuShortcut>
            {shortcutLabelForCommand(keybindings, "thread.copyReference")}
          </MenuShortcut>
        </MenuItem>
        <MenuItem
          onClick={() =>
            copyReference(
              `#${reference.number}`,
              resolve(
                msg(
                  "Failed to copy {term, select, mr {MR} cr {change request} other {PR}} number",
                  { term: changeRequestTermKind(terminology) },
                ),
              ),
            )
          }
        >
          <CopyIcon className="size-3.5" />
          <T>
            Copy{" "}
            <Branch branch={changeRequestTermKind(terminology)} mr="MR" cr="change request">
              PR
            </Branch>{" "}
            number
          </T>
          <MenuShortcut>
            {shortcutLabelForCommand(keybindings, "pullRequest.copyNumber")}
          </MenuShortcut>
        </MenuItem>
        {checkoutCommand ? (
          <MenuItem
            onClick={() =>
              copyReference(checkoutCommand, resolve(msg("Failed to copy checkout command")))
            }
          >
            <SquareTerminalIcon className="size-3.5" />
            <T>Copy checkout command</T>
          </MenuItem>
        ) : null}
        {detail.state === "open" && can("close") ? (
          <>
            <MenuSeparator />
            <MenuItem
              closeOnClick={inlineConfirm.isArmed("close")}
              aria-label={
                inlineConfirm.isArmed("close")
                  ? gt("Confirm close?")
                  : gt(
                      "Close {term, select, mr {merge request} cr {change request} other {pull request}}",
                      { term: changeRequestTermKind(terminology) },
                    )
              }
              variant="destructive"
              disabled={actionPending}
              {...inlineConfirm.props("close", () => void perform("close"))}
            >
              <PullRequestGlyph.closed className="size-3.5" />
              {inlineConfirm.isArmed("close")
                ? gt("Confirm close?")
                : gt(
                    "Close {term, select, mr {merge request} cr {change request} other {pull request}}",
                    { term: changeRequestTermKind(terminology) },
                  )}
            </MenuItem>
          </>
        ) : detail.state === "closed" && can("reopen") ? (
          <>
            <MenuSeparator />
            <MenuItem disabled={actionPending} onClick={() => void perform("reopen")}>
              <PullRequestGlyph.reopen className="size-3.5" />
              <T>
                Reopen{" "}
                <Branch
                  branch={changeRequestTermKind(terminology)}
                  mr="merge request"
                  cr="change request"
                >
                  pull request
                </Branch>
              </T>
            </MenuItem>
          </>
        ) : detail.state === "merged" && can("revert") ? (
          <>
            <MenuSeparator />
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
                  {pendingAction === "delete-branch"
                    ? gt("Deleting branch...")
                    : gt("Delete branch")}
                </span>
                <span className="truncate text-meta text-muted-foreground">
                  {environmentConnected ? detail.headBranch : gt("Reconnect to delete this branch")}
                </span>
              </span>
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
