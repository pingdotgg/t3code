import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import {
  PullRequestPermissionButton,
  PullRequestPermissionHint,
  PullRequestPermissionMenuItem,
} from "./PullRequestPermissionButton";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PullRequestDetail,
  PullRequestHostAction,
  PullRequestHostActionResult,
  PullRequestHostDetails,
  PullRequestRef,
  PullRequestReviewerRequestInput,
} from "@t3tools/contracts";
import { AzureDevOpsMergeStrategy } from "@t3tools/contracts";
import {
  azureActionSections,
  azureBranchActions,
  azureCompletionBlock,
  azureCompletionOptions,
  azureCompletionToggles,
  azureMergeStrategyLabels,
  azureReviewerStatus,
  emptyAzureCompletionDraft,
  parseAzureWorkItemIds,
  splitAzureList,
  type AzureActionSection,
} from "@t3tools/client-runtime/azure-devops-pull-request-actions";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEnvironmentQuery } from "~/state/query";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { Button } from "../ui/button";
import { MenuItem, MenuSeparator, MenuSub, MenuSubTrigger, MenuSubPopup } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";
import { pullRequestReviewKey } from "./pullRequestReviewStore";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";

function settled<A, E>(result: AtomCommandResult<A, E>) {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export function AzureDevOpsPullRequestActions(props: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetail;
  children: (menu: ReactNode) => ReactNode;
}) {
  if (!props.detail.capabilities.hostActions) return props.children(null);
  return (
    <AzureActions
      key={`${props.environmentId}:${pullRequestReviewKey(props.reference)}`}
      {...props}
    />
  );
}
function AzureActions({
  environmentId,
  reference,
  detail,
  children,
}: Parameters<typeof AzureDevOpsPullRequestActions>[0]) {
  const allowed = useAtomValue(pullRequestEnvironment.runHostAction.permissionAtom(environmentId));
  const run = useAtomCommand(pullRequestEnvironment.runHostAction, { reportFailure: false });
  const [section, setSectionState] = useState<AzureActionSection | null>(null);
  const openSection = useRef<AzureActionSection | null>(null);
  const setSection = (value: AzureActionSection | null) => {
    openSection.current = value;
    setSectionState(value);
  };
  useEffect(
    () => () => {
      openSection.current = null;
    },
    [openSection],
  );
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const query = useEnvironmentQuery(
    menuOpen || section !== null || busy
      ? pullRequestEnvironment.hostDetails({ environmentId, input: reference })
      : null,
  );
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PullRequestHostActionResult | null>(null);
  const operate = async (operation: () => Promise<unknown>) => {
    if (!allowed || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    await Promise.resolve()
      .then(operation)
      .catch((cause: unknown) => {
        const message = readableFailure(cause, "Azure could not complete this action.");
        setError(message);
        if (openSection.current === null) toastManager.add({ type: "error", title: message });
      })
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  const hostAction = async (action: PullRequestHostAction) => {
    const value = settled(await run({ environmentId, input: { ...reference, action } }));
    setResult(value);
    if (openSection.current === null) toastManager.add({ type: "info", title: value.message });
  };
  const execute = (action: PullRequestHostAction) => operate(() => hostAction(action));
  const disabled = busy || !allowed;
  const details = query.data ?? undefined;
  const denied = { ...detail.viewerPermissions.deniedActions, ...details?.deniedActions };
  const declined = details?.reviewers.find((person) => person.id === details.viewerId)?.declined;
  const feedback = (
    <>
      {busy ? <p role="status">Working… You can close this panel.</p> : null}
      {error || query.error ? (
        <p role="alert" className="text-destructive">
          {error ?? readableFailure(query.error, "Could not load Azure pull request actions.")}
        </p>
      ) : null}
      {details?.warnings.map((warning) => (
        <p key={warning} className="text-warning">
          {warning}
        </p>
      ))}
      {result ? (
        <p role="status">
          {result.message}{" "}
          {result.url ? (
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              View result
            </a>
          ) : null}
        </p>
      ) : null}
    </>
  );
  return (
    <>
      {children(
        <MenuSub onOpenChange={setMenuOpen}>
          <MenuSubTrigger>Azure DevOps</MenuSubTrigger>
          <MenuSubPopup>
            <PullRequestPermissionMenuItem
              reason={denied["follow"]}
              disabled={disabled || details?.following == null}
              onClick={() => void execute({ type: "follow", enabled: !details?.following })}
            >
              {details?.following ? "Unfollow PR" : "Follow PR"}
            </PullRequestPermissionMenuItem>
            <PullRequestPermissionMenuItem
              reason={denied["favorite-source"]}
              disabled={disabled || details?.sourceBranchFavorite == null}
              onClick={() =>
                void execute({ type: "favorite-source", enabled: !details?.sourceBranchFavorite })
              }
            >
              {details?.sourceBranchFavorite
                ? "Unfavorite source branch"
                : "Favorite source branch"}
            </PullRequestPermissionMenuItem>
            <PullRequestPermissionMenuItem
              reason={denied["decline-review"]}
              disabled={disabled || !details?.canDeclineReview}
              onClick={() => void execute({ type: "decline-review", declined: !declined })}
            >
              {declined ? "Resume reviewing" : "Decline review"}
            </PullRequestPermissionMenuItem>
            <MenuSeparator />
            {azureActionSections.map((title) => (
              <MenuItem
                key={title}
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setResult(null);
                  setSection(title);
                }}
              >
                {title}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>,
      )}
      <AzureActionDialog
        section={section}
        onClose={() => setSection(null)}
        environmentId={environmentId}
        reference={reference}
        detail={detail}
        details={details}
        loading={query.isPending}
        denied={denied}
        disabled={disabled}
        feedback={feedback}
        operate={operate}
        hostAction={hostAction}
      />
    </>
  );
}

/** Owns the section forms so typing does not rebuild the header menu. */
function AzureActionDialog({
  section,
  onClose,
  environmentId,
  reference,
  detail,
  details,
  loading,
  denied,
  disabled,
  feedback,
  operate,
  hostAction,
}: {
  section: AzureActionSection | null;
  onClose: () => void;
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetail;
  details: PullRequestHostDetails | undefined;
  loading: boolean;
  denied: Readonly<Record<string, string | undefined>>;
  disabled: boolean;
  feedback: ReactNode;
  operate: (operation: () => Promise<unknown>) => Promise<void>;
  hostAction: (action: PullRequestHostAction) => Promise<void>;
}) {
  const setLabels = useAtomCommand(pullRequestEnvironment.setLabels, { reportFailure: false });
  const requestReviewers = useAtomCommand(pullRequestEnvironment.requestReviewers, {
    reportFailure: false,
  });
  const [confirm, setConfirm] = useState<PullRequestHostAction | null>(null);
  const [reviewer, setReviewer] = useState("");
  const [workItems, setWorkItems] = useState("");
  const [label, setLabel] = useState("");
  const [branch, setBranch] = useState(detail.baseBranch);
  const [newBranch, setNewBranch] = useState("");
  const [completion, setCompletion] = useState(emptyAzureCompletionDraft);
  const [shareReceivers, setShareReceivers] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  const execute = (action: PullRequestHostAction) => operate(() => hostAction(action));
  const active = detail.state === "open";
  const allowedStrategies = details?.allowedMergeStrategies;
  const options = azureCompletionOptions(completion, allowedStrategies, detail.autoMergeMethod);
  const completionBlock = azureCompletionBlock(options, detail, denied, allowedStrategies);
  const branchActions = azureBranchActions(detail, branch, newBranch);
  const review = (reviewers: PullRequestReviewerRequestInput["reviewers"], requested: boolean) =>
    requestReviewers({ environmentId, input: { ...reference, reviewers, requested } }).then(
      settled,
    );
  const changeLabel = (name: string, applied: boolean) =>
    setLabels({ environmentId, input: { ...reference, labels: [name], applied } }).then(settled);
  const upload = (file: File) =>
    operate(async () => {
      if (file.size > 10 * 1024 * 1024) throw new Error("Attachments must be 10 MB or smaller.");
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1] ?? ""), {
          once: true,
        });
        reader.addEventListener(
          "error",
          () => reject(new Error("Could not read the attachment.")),
          { once: true },
        );
        reader.readAsDataURL(file);
      });
      await hostAction({ type: "attachment-upload", fileName: file.name, data });
    });
  const confirmCopy = describeConfirm(confirm, reference.number, detail.baseBranch);
  return (
    <Dialog
      open={section !== null}
      onOpenChange={(open) => {
        if (!open && !confirm) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{section}</DialogTitle>
          <DialogDescription>Pull request #{reference.number}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {section === "Reviewers" ? (
            <div className="space-y-2">
              {details?.reviewers.map((person) => (
                <div key={person.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {person.name} · {azureReviewerStatus(person)}
                  </span>
                  <PullRequestPermissionButton
                    reason={denied["reviewer-flag"]}
                    size="xs"
                    variant="ghost-muted"
                    disabled={disabled || !details.canFlagReview || person.id !== details.viewerId}
                    onClick={() =>
                      void execute({
                        type: "reviewer-flag",
                        reviewerId: person.id,
                        flagged: !person.flagged,
                      })
                    }
                  >
                    {person.flagged ? "Clear reviewer flag" : "Flag reviewer"}
                  </PullRequestPermissionButton>
                  <PullRequestPermissionButton
                    reason={denied["reviewer-required"]}
                    size="xs"
                    variant="ghost-muted"
                    disabled={disabled || !active}
                    onClick={() =>
                      void execute({
                        type: "reviewer-required",
                        reviewerId: person.id,
                        required: !person.required,
                      })
                    }
                  >
                    {person.required ? "Make optional" : "Make required"}
                  </PullRequestPermissionButton>
                  <PullRequestPermissionButton
                    reason={denied["reviewers"]}
                    size="xs"
                    variant="ghost-muted"
                    disabled={disabled}
                    onClick={() =>
                      void operate(() =>
                        review([{ id: person.id, kind: person.group ? "team" : "user" }], false),
                      )
                    }
                  >
                    Remove reviewer
                  </PullRequestPermissionButton>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Reviewer email or ID"
                  placeholder="Reviewer email or ID"
                  value={reviewer}
                  onChange={(event) => setReviewer(event.target.value)}
                />
                <PullRequestPermissionButton
                  reason={denied["reviewers"]}
                  size="xs"
                  variant="outline"
                  disabled={disabled || !reviewer.trim()}
                  onClick={() =>
                    void operate(async () => {
                      await review([{ id: reviewer.trim(), kind: "user" }], true);
                      setReviewer("");
                    })
                  }
                >
                  Add reviewer
                </PullRequestPermissionButton>
              </div>
            </div>
          ) : null}
          {section === "Tags" ? (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {detail.labels.map((item) => (
                  <PullRequestPermissionButton
                    reason={denied["labels"]}
                    key={item.name}
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => void operate(() => changeLabel(item.name, false))}
                  >
                    {item.name} ×
                  </PullRequestPermissionButton>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="New tag"
                  placeholder="Tag name"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
                <PullRequestPermissionButton
                  reason={denied["labels"]}
                  size="xs"
                  variant="outline"
                  disabled={disabled || !label.trim()}
                  onClick={() =>
                    void operate(async () => {
                      await changeLabel(label.trim(), true);
                      setLabel("");
                    })
                  }
                >
                  Add tag
                </PullRequestPermissionButton>
              </div>
            </div>
          ) : null}
          {section === "Linked work items" ? (
            <div className="space-y-2">
              {details?.workItems.map((item) => (
                <div key={item.id} className="flex items-center gap-2">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    #{item.id} {item.title}
                  </a>
                  <span>{item.state}</span>
                  <PullRequestPermissionButton
                    reason={denied["work-items"]}
                    size="xs"
                    variant="ghost-muted"
                    disabled={disabled}
                    onClick={() =>
                      void execute({ type: "work-items", ids: [item.id], linked: false })
                    }
                  >
                    Unlink
                  </PullRequestPermissionButton>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Work item numbers"
                  placeholder="Work item numbers, separated by commas"
                  value={workItems}
                  onChange={(event) => setWorkItems(event.target.value)}
                />
                <PullRequestPermissionButton
                  reason={denied["work-items"]}
                  size="xs"
                  variant="outline"
                  disabled={disabled || !workItems.trim()}
                  onClick={() =>
                    void operate(async () => {
                      const ids = parseAzureWorkItemIds(workItems);
                      if (!ids) throw new Error("Enter up to 25 valid work item numbers.");
                      await hostAction({ type: "work-items", ids, linked: true });
                      setWorkItems("");
                    })
                  }
                >
                  Link work items
                </PullRequestPermissionButton>
              </div>
            </div>
          ) : null}
          {section === "Attachments" ? (
            <div className="space-y-2">
              {details?.attachments.map((file) => (
                <div key={file.url} className="flex flex-wrap items-center gap-2">
                  <a
                    href={file.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    {file.name}
                  </a>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() =>
                      void writeTextToClipboard(
                        `[${file.name.replaceAll("[", "").replaceAll("]", "")}](${file.url})`,
                        "attachment link",
                      )
                    }
                  >
                    Copy Markdown link
                  </Button>
                  <PullRequestPermissionButton
                    reason={denied["attachment-delete"]}
                    size="xs"
                    variant="ghost-muted"
                    disabled={disabled}
                    onClick={() => setConfirm({ type: "attachment-delete", fileName: file.name })}
                  >
                    Delete attachment
                  </PullRequestPermissionButton>
                </div>
              ))}
              <PullRequestPermissionHint reason={denied["attachment-upload"]}>
                <input
                  type="file"
                  aria-label="Upload PR attachment"
                  disabled={disabled || Boolean(denied["attachment-upload"])}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void upload(file);
                  }}
                />
              </PullRequestPermissionHint>
              <p className="text-muted-foreground">
                Upload a file up to 10 MB, then copy its Markdown link into a comment.
              </p>
            </div>
          ) : null}
          {section === "Share by email" ? (
            <div className="space-y-2">
              <Input
                aria-label="Share recipients"
                placeholder="Email addresses, separated by commas"
                value={shareReceivers}
                onChange={(event) => setShareReceivers(event.target.value)}
              />
              <Textarea
                aria-label="Share message"
                placeholder="Optional message"
                maxLength={4000}
                value={shareMessage}
                onChange={(event) => setShareMessage(event.target.value)}
              />
              <PullRequestPermissionButton
                reason={denied["share"]}
                size="xs"
                variant="outline"
                disabled={disabled || !shareReceivers.trim()}
                onClick={() =>
                  setConfirm({
                    type: "share",
                    receivers: splitAzureList(shareReceivers),
                    message: shareMessage,
                  })
                }
              >
                Share pull request
              </PullRequestPermissionButton>
            </div>
          ) : null}
          {section === "Policies and checks" ? (
            <div className="space-y-2">
              {loading ? <p>Loading Azure details…</p> : null}
              {details?.policies.map((policy) => (
                <div key={policy.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {policy.name} · {policy.required ? "Required" : "Optional"} · {policy.status}
                  </span>
                  <PullRequestPermissionButton
                    reason={denied["requeue-policy"]}
                    size="xs"
                    variant="ghost-muted"
                    disabled={disabled || !active}
                    onClick={() =>
                      void execute({ type: "requeue-policy", evaluationId: policy.id })
                    }
                  >
                    Requeue
                  </PullRequestPermissionButton>
                  {policy.url ? (
                    <a
                      href={policy.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline"
                    >
                      View policy
                    </a>
                  ) : null}
                </div>
              ))}
              {details?.policies.length === 0 ? (
                <p className="text-muted-foreground">No branch policies reported.</p>
              ) : null}
            </div>
          ) : null}
          {section === "Branches" ? (
            <div className="space-y-2">
              <label className="flex items-center gap-2">
                Target branch{" "}
                <Input
                  aria-label="Target branch"
                  list="azure-target-branches"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                />
                <datalist id="azure-target-branches">
                  {details?.branches.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </label>
              <div className="flex flex-wrap gap-2">
                <PullRequestPermissionButton
                  reason={denied["retarget"]}
                  size="xs"
                  variant="outline"
                  disabled={disabled || !branchActions.retarget}
                  onClick={() => setConfirm(branchActions.retarget)}
                >
                  Change target branch
                </PullRequestPermissionButton>
                <PullRequestPermissionButton
                  reason={denied["restart-merge"]}
                  size="xs"
                  variant="outline"
                  disabled={disabled || !active}
                  onClick={() => void execute({ type: "restart-merge" })}
                >
                  Restart merge
                </PullRequestPermissionButton>
                {details?.mergePreviewUrl ? (
                  <a
                    href={details.mergePreviewUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline"
                  >
                    View merge changes
                  </a>
                ) : null}
              </div>
              <Input
                aria-label="New branch name"
                placeholder="New branch name for cherry-pick or revert"
                value={newBranch}
                onChange={(event) => setNewBranch(event.target.value)}
              />
              <div className="flex gap-2">
                <PullRequestPermissionButton
                  reason={denied["cherry-pick"]}
                  size="xs"
                  variant="outline"
                  disabled={disabled || !branchActions.cherryPick}
                  onClick={() => setConfirm(branchActions.cherryPick)}
                >
                  Cherry-pick
                </PullRequestPermissionButton>
                <PullRequestPermissionButton
                  reason={denied["revert"]}
                  size="xs"
                  variant="outline"
                  disabled={disabled || !branchActions.revert}
                  onClick={() => setConfirm(branchActions.revert)}
                >
                  Revert
                </PullRequestPermissionButton>
              </div>
            </div>
          ) : null}
          {section === "Completion options" ? (
            <div className="space-y-2">
              <label className="flex items-center gap-2">
                Merge strategy{" "}
                <Select
                  value={options.strategy}
                  onValueChange={(value) => {
                    const strategy = AzureDevOpsMergeStrategy.literals.find(
                      (candidate) => candidate === value,
                    );
                    if (strategy) setCompletion((current) => ({ ...current, strategy }));
                  }}
                >
                  <SelectTrigger size="xs" aria-label="Azure merge strategy">
                    {azureMergeStrategyLabels[options.strategy]}
                  </SelectTrigger>
                  <SelectPopup>
                    {AzureDevOpsMergeStrategy.literals.map((value) => (
                      <SelectItem
                        key={value}
                        value={value}
                        disabled={
                          !completion.bypassPolicy && allowedStrategies?.includes(value) === false
                        }
                      >
                        {azureMergeStrategyLabels[value]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>
              {azureCompletionToggles.map((toggle) => {
                const reason = toggle.permission ? denied[toggle.permission] : undefined;
                return (
                  <PullRequestPermissionHint key={toggle.key} reason={reason}>
                    <label className="flex items-center gap-2">
                      <Checkbox
                        disabled={Boolean(reason) && !completion[toggle.key]}
                        checked={completion[toggle.key]}
                        onCheckedChange={(checked) => {
                          setCompletion((current) => ({ ...current, [toggle.key]: checked }));
                        }}
                      />
                      {toggle.label}
                    </label>
                  </PullRequestPermissionHint>
                );
              })}
              {completion.bypassPolicy ? (
                <Input
                  aria-label="Policy override reason"
                  placeholder="Reason for overriding policies"
                  value={completion.bypassReason}
                  onChange={(event) => {
                    const bypassReason = event.target.value;
                    setCompletion((current) => ({ ...current, bypassReason }));
                  }}
                />
              ) : null}
              <Textarea
                aria-label="Merge commit message"
                placeholder="Optional merge commit message"
                value={completion.message}
                onChange={(event) => {
                  const message = event.target.value;
                  setCompletion((current) => ({ ...current, message }));
                }}
              />
              <div className="flex gap-2">
                <PullRequestPermissionButton
                  reason={completionBlock}
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setConfirm({ type: "complete", automatic: false, ...options })}
                >
                  Complete with these options
                </PullRequestPermissionButton>
                <PullRequestPermissionButton
                  reason={completionBlock}
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setConfirm({ type: "complete", automatic: true, ...options })}
                >
                  Set auto-complete
                </PullRequestPermissionButton>
              </div>
            </div>
          ) : null}
          {feedback}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
        <AlertDialog
          open={confirm !== null}
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
        >
          <AlertDialogPopup backdropVariant="dimmed">
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmCopy.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirmCopy.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <PullRequestPermissionButton
                reason={confirm ? denied[confirm.type] : undefined}
                disabled={disabled}
                onClick={() => {
                  if (!confirm) return;
                  const action = confirm;
                  setConfirm(null);
                  void operate(() => hostAction(action));
                }}
              >
                Confirm
              </PullRequestPermissionButton>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </DialogPopup>
    </Dialog>
  );
}

function describeConfirm(action: PullRequestHostAction | null, number: number, baseBranch: string) {
  switch (action?.type) {
    case "attachment-delete":
      return {
        title: "Delete attachment?",
        description: `Delete ${action.fileName} from PR #${number}.`,
      };
    case "share":
      return {
        title: "Send pull request email?",
        description: `Send PR #${number} to ${action.receivers.join(", ")}.`,
      };
    case "complete":
      return {
        title: action.automatic ? "Set auto-complete?" : "Complete pull request?",
        description: `Apply the selected completion options to #${number}.`,
      };
    case "retarget":
      return {
        title: "Change target branch?",
        description: `Change #${number} from ${baseBranch} to ${action.branch}.`,
      };
    case "revert":
    case "cherry-pick":
      return {
        title: "Create a branch with these changes?",
        description: `Create ${action.newBranch} from ${action.targetBranch} using #${number}.`,
      };
    default:
      return { title: "", description: "" };
  }
}
