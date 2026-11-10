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
import { useId, useState } from "react";

import { shortcutLabelForCommand } from "~/keybindings";
import { readLocalApi } from "~/localApi";
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
import type { PickableEnvironment } from "./pullRequestProjectAssignment.logic";
import { PullRequestThreadLinks } from "./PullRequestThreadLinks";
import { useInlineActionConfirm } from "./useInlineActionConfirm";

/** Everything else the reader can do with the pull request, behind the header's overflow button. */
export function PullRequestActionsMenu({
  environmentId,
  reference,
  pullRequestKey,
  detail,
  terminology,
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
  canWriteSourceControl,
  onMaintainerEditsSaved,
  confirmDeleteBranch,
  pendingAction,
  perform,
  openOnHostText,
  copyReference,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  pullRequestKey: string;
  detail: Pick<
    PullRequestDetail,
    | "url"
    | "state"
    | "isDraft"
    | "headBranch"
    | "capabilities"
    | "viewerPermissions"
    | "maintainerCanModify"
    | "observedAt"
  >;
  terminology: ChangeRequestTerminology;
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
  canWriteSourceControl: boolean;
  onMaintainerEditsSaved: () => void;
  confirmDeleteBranch: () => Promise<void>;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  openOnHostText: string;
  copyReference: (value: string, label: string) => void;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
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
        title: "Could not save maintainer access",
        description: readableFailure(squashAtomCommandFailure(result), "Try again."),
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
                      ? `Refreshing ${terminology.singular}`
                      : `More ${terminology.singular} actions`
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
            ? `Refreshing ${terminology.singular}`
            : `More ${terminology.singular} actions`}
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
        <MenuItem disabled={handoff !== null} onClick={askAboutPullRequest}>
          <MessageCircleQuestionIcon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>{handoff === "ask" ? "Opening..." : "Ask a question"}</span>
            <span className="text-xs text-muted-foreground">
              {attachesToComposer
                ? `Adds the ${terminology.singular} to this thread's composer.`
                : `Opens a thread that knows which ${terminology.singular} you mean.`}
            </span>
          </span>
        </MenuItem>
        <MenuItem disabled={handoff !== null} onClick={explainPullRequest}>
          <BookOpenIcon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>
              {handoff === "explain" ? "Opening..." : `Explain this ${terminology.shortLabel}`}
            </span>
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
            {guideRunning ? "Writing guide..." : !guideWritten ? "Write guide" : "Rewrite guide"}
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
        {canEditPullRequestMaintainerEdits(detail) ? (
          <>
            <MenuCheckboxItem
              variant="icon"
              checked={maintainerCanModify === true}
              disabled={!canSaveMaintainerEdits}
              closeOnClick={false}
              aria-label="Allow edits from maintainers"
              aria-describedby={maintainerEditsHintId}
              onCheckedChange={(value) => void saveMaintainerEdits(value)}
            >
              <span className="flex max-w-xs flex-col gap-0.5">
                <span>Allow edits from maintainers</span>
                <span id={maintainerEditsHintId} className="text-xs text-muted-foreground">
                  Maintainers can push to this branch. If your fork has workflows, this can also
                  give access to its secrets.
                </span>
                {maintainerEditsSaving ? (
                  <span role="status" className="text-xs text-muted-foreground">
                    Saving…
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
                {detail.isDraft ? "Ready for review" : "Convert to draft"}
              </MenuItem>
            ) : null}
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
            {showsMergeMethods ? (
              <>
                {showsDraftToggle || showsMergeNow || showsAutoMerge ? <MenuSeparator /> : null}
                <MenuRadioGroup
                  value={selectedMergeMethod}
                  onValueChange={(method) => onSelectMergeMethod(method as PullRequestMergeMethod)}
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
        <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}>
          <ArrowUpRightIcon className="size-3.5" />
          {openOnHostText}
        </MenuItem>
        <MenuItem onClick={() => copyReference(detail.url, `${terminology.shortLabel} link`)}>
          <LinkIcon className="size-3.5" />
          Copy link
          <MenuShortcut>
            {shortcutLabelForCommand(keybindings, "thread.copyReference")}
          </MenuShortcut>
        </MenuItem>
        <MenuItem
          onClick={() => copyReference(`#${reference.number}`, `${terminology.shortLabel} number`)}
        >
          <CopyIcon className="size-3.5" />
          Copy {terminology.shortLabel} number
          <MenuShortcut>
            {shortcutLabelForCommand(keybindings, "pullRequest.copyNumber")}
          </MenuShortcut>
        </MenuItem>
        {detail.state === "open" && can("close") ? (
          <>
            <MenuSeparator />
            <MenuItem
              closeOnClick={inlineConfirm.isArmed("close")}
              aria-label={
                inlineConfirm.isArmed("close") ? "Confirm close?" : `Close ${terminology.singular}`
              }
              variant="destructive"
              disabled={actionPending}
              {...inlineConfirm.props("close", () => void perform("close"))}
            >
              <PullRequestGlyph.closed className="size-3.5" />
              {inlineConfirm.isArmed("close") ? "Confirm close?" : `Close ${terminology.singular}`}
            </MenuItem>
          </>
        ) : detail.state === "closed" && can("reopen") ? (
          <>
            <MenuSeparator />
            <MenuItem disabled={actionPending} onClick={() => void perform("reopen")}>
              <PullRequestGlyph.reopen className="size-3.5" />
              Reopen {terminology.singular}
            </MenuItem>
          </>
        ) : detail.state === "merged" && can("revert") ? (
          <>
            <MenuSeparator />
            <MenuItem
              closeOnClick={inlineConfirm.isArmed("revert")}
              aria-label={inlineConfirm.isArmed("revert") ? "Confirm revert?" : "Revert changes"}
              variant={inlineConfirm.isArmed("revert") ? "destructive" : "default"}
              disabled={actionPending}
              {...inlineConfirm.props("revert", () => void perform("revert"))}
            >
              <RotateCcwIcon className="size-3.5" />
              {inlineConfirm.isArmed("revert") ? "Confirm revert?" : "Revert changes"}
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
  );
}
