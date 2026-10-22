import * as Dialog from "../../components/ui/Dialog";
import { PullRequestPermissionButton } from "./PullRequestPermissionButton";
import { useAtomValue } from "@effect/atom-react";
import {
  AzureDevOpsMergeStrategy,
  AzureDevOpsReviewVote,
  type PullRequestDetail,
  type PullRequestHostAction,
  type PullRequestHostActionResult,
  type PullRequestHostDetails,
  type PullRequestReviewerRequestInput,
} from "@t3tools/contracts";
import {
  azureActionSections,
  azureBranchActions,
  azureCompletionBlock,
  azureCompletionOptions,
  azureCompletionToggles,
  azureMergeStrategyLabels,
  azureReviewerStatus,
  azureVoteLabels,
  emptyAzureCompletionDraft,
  parseAzureWorkItemIds,
  splitAzureList,
  type AzureActionSection,
} from "@t3tools/client-runtime/azure-devops-pull-request-actions";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MenuAction } from "@react-native-menu/menu";
import { Toolbar } from "../../components/ui/Toolbar";
import { Linking, Platform, Pressable, ScrollView, Switch, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Sheet } from "../../components/ui/Sheet";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";

type AzureMenu = {
  actions: MenuAction[];
  onSelect: (id: string) => void;
  nativeMenu: ReactNode;
};
type ActionsProps = {
  pr: PullRequestDetail;
  params: PullRequestParams;
  children: (menu: AzureMenu | null) => ReactNode;
};
const inputClass = "min-h-12 rounded-xl border border-border-subtle px-3 text-foreground";

function settled<A, E>(result: AtomCommandResult<A, E>) {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

type AzureMenuEntry = {
  id: string;
  title: string;
  reason: string | undefined;
  disabled: boolean;
  onPress: () => void;
};

// A render prop can invoke its arguments; keep event handlers that capture refs behind a component boundary.
function AzureActionMenu({
  voteEntries,
  entries,
  children,
}: {
  voteEntries: ReadonlyArray<AzureMenuEntry>;
  entries: ReadonlyArray<AzureMenuEntry>;
  children: ActionsProps["children"];
}) {
  const menuAction = (entry: AzureMenuEntry): MenuAction => ({
    id: entry.id,
    title: entry.reason ? `${entry.title} — ${entry.reason}` : entry.title,
    attributes: { disabled: entry.disabled || Boolean(entry.reason) },
  });
  const nativeAction = (entry: AzureMenuEntry) => (
    <Toolbar.MenuAction
      key={entry.id}
      disabled={entry.disabled || Boolean(entry.reason)}
      subtitle={entry.reason}
      onPress={entry.onPress}
    >
      <Toolbar.Label>{entry.title}</Toolbar.Label>
    </Toolbar.MenuAction>
  );
  return children({
    actions: [
      {
        id: "azure",
        title: "Azure DevOps",
        subactions: [
          { id: "azure-vote", title: "Your review", subactions: voteEntries.map(menuAction) },
          ...entries.map(menuAction),
        ],
      },
    ],
    onSelect: (id) => {
      const entry = [...voteEntries, ...entries].find((entry) => entry.id === id);
      if (entry && !entry.disabled && !entry.reason) entry.onPress();
    },
    nativeMenu: (
      <Toolbar.Menu title="Azure DevOps">
        <Toolbar.Menu title="Your review">{voteEntries.map(nativeAction)}</Toolbar.Menu>
        {entries.map(nativeAction)}
      </Toolbar.Menu>
    ),
  });
}

export function AzureDevOpsPullRequestActions(
  props: Omit<ActionsProps, "pr"> & {
    pr: PullRequestDetail | null;
  },
) {
  if (!props.pr?.capabilities.hostActions) return props.children(null);
  return <Actions key={pullRequestReviewKey(props.params)} {...props} pr={props.pr} />;
}
function Actions({ pr, params, children }: ActionsProps) {
  const target = pullRequestTarget(params);
  const query = useEnvironmentQuery(composerPullRequests.hostDetails(target));
  const allowed = useAtomValue(
    composerPullRequests.runHostAction.permissionAtom(target.environmentId),
  );
  const command = useAtomCommand(composerPullRequests.runHostAction, { reportFailure: false });
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
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PullRequestHostActionResult | null>(null);
  const operate = async (run: () => Promise<unknown>) => {
    if (!allowed || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    await Promise.resolve()
      .then(run)
      .catch((cause: unknown) => {
        const message =
          cause instanceof Error ? cause.message : "Azure could not complete this action.";
        setError(message);
        if (openSection.current === null) Dialog.alert("Azure DevOps", message);
      })
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  const hostAction = async (action: PullRequestHostAction) => {
    const value = settled(await command({ ...target, input: { ...target.input, action } }));
    setResult(value);
    if (openSection.current === null) Dialog.alert("Azure DevOps", value.message);
  };
  const execute = (action: PullRequestHostAction) => operate(() => hostAction(action));
  const disabled = busy || !allowed;
  const details = query.data ?? undefined;
  const denied = { ...pr.viewerPermissions.deniedActions, ...details?.deniedActions };
  const declined = details?.reviewers.find((person) => person.id === details.viewerId)?.declined;
  const resultUrl = result?.url;
  const feedback = (
    <>
      {busy ? (
        <Text accessibilityRole="progressbar">Working… You can close this panel.</Text>
      ) : null}
      {details?.warnings.map((warning) => (
        <Text key={warning} className="text-foreground-muted">
          {warning}
        </Text>
      ))}
      {error || query.error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error ?? query.error}
        </Text>
      ) : null}
      {result ? <Text>{result.message}</Text> : null}
      {resultUrl ? (
        <Button label="View result" onPress={() => void Linking.openURL(resultUrl)} />
      ) : null}
    </>
  );
  const voteEntries = AzureDevOpsReviewVote.literals.map((vote) => ({
    id: `vote:${vote}`,
    title: azureVoteLabels[vote],
    reason: denied.vote ?? (pr.isDraft ? "Publish this draft before voting." : undefined),
    disabled: disabled || pr.isDraft || pr.state !== "open",
    onPress: () => void execute({ type: "vote", vote }),
  }));
  const entries = [
    {
      id: "follow",
      title: details?.following ? "Unfollow PR" : "Follow PR",
      reason: denied.follow,
      disabled: disabled || details?.following == null,
      onPress: () => void execute({ type: "follow", enabled: !details?.following }),
    },
    {
      id: "favorite-source",
      title: details?.sourceBranchFavorite ? "Unfavorite source branch" : "Favorite source branch",
      reason: denied["favorite-source"],
      disabled: disabled || details?.sourceBranchFavorite == null,
      onPress: () =>
        void execute({ type: "favorite-source", enabled: !details?.sourceBranchFavorite }),
    },
    {
      id: "decline-review",
      title: declined ? "Resume reviewing" : "Decline review",
      reason: denied["decline-review"],
      disabled: disabled || !details?.canDeclineReview,
      onPress: () => void execute({ type: "decline-review", declined: !declined }),
    },
    ...azureActionSections.map((title) => ({
      id: title,
      title,
      reason: undefined,
      disabled: busy,
      onPress: () => {
        setError(null);
        setResult(null);
        setSection(title);
      },
    })),
  ];
  return (
    <>
      <AzureActionMenu voteEntries={voteEntries} entries={entries}>
        {children}
      </AzureActionMenu>
      <AzureActionSheet
        section={section}
        onClose={() => setSection(null)}
        pr={pr}
        target={target}
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

/** Owns the section forms so typing does not reapply the native header menus. */
function AzureActionSheet({
  section,
  onClose,
  pr,
  target,
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
  pr: PullRequestDetail;
  target: ReturnType<typeof pullRequestTarget>;
  details: PullRequestHostDetails | undefined;
  loading: boolean;
  denied: Readonly<Record<string, string | undefined>>;
  disabled: boolean;
  feedback: ReactNode;
  operate: (run: () => Promise<unknown>) => Promise<void>;
  hostAction: (action: PullRequestHostAction) => Promise<void>;
}) {
  const reviewersCommand = useAtomCommand(composerPullRequests.requestReviewers, {
    reportFailure: false,
  });
  const labelsCommand = useAtomCommand(composerPullRequests.setLabels, { reportFailure: false });
  const insets = useSafeAreaInsets();
  const [reviewer, setReviewer] = useState("");
  const [tag, setTag] = useState("");
  const [items, setItems] = useState("");
  const [branch, setBranch] = useState(pr.baseBranch);
  const [newBranch, setNewBranch] = useState("");
  const [completion, setCompletion] = useState(emptyAzureCompletionDraft);
  const [shareReceivers, setShareReceivers] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  if (section === null) return null;
  const execute = (action: PullRequestHostAction) => operate(() => hostAction(action));
  const active = pr.state === "open";
  const allowedStrategies = details?.allowedMergeStrategies;
  const options = azureCompletionOptions(completion, allowedStrategies, pr.autoMergeMethod);
  const completionBlock = azureCompletionBlock(options, pr, denied, allowedStrategies);
  const branchActions = azureBranchActions(pr, branch, newBranch);
  const mergePreviewUrl = details?.mergePreviewUrl;
  const review = (reviewers: PullRequestReviewerRequestInput["reviewers"], requested: boolean) =>
    reviewersCommand({ ...target, input: { ...target.input, reviewers, requested } }).then(settled);
  const changeLabel = (name: string, applied: boolean) =>
    labelsCommand({ ...target, input: { ...target.input, labels: [name], applied } }).then(settled);
  const upload = () =>
    operate(async () => {
      const selection = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      const file = selection.canceled ? undefined : selection.assets[0];
      if (!file) return;
      if ((file.size ?? new File(file.uri).size) > 10 * 1024 * 1024)
        throw new Error("Attachments must be 10 MB or smaller.");
      const data = await new File(file.uri).base64();
      await hostAction({ type: "attachment-upload", fileName: file.name, data });
    });
  const confirm = (title: string, action: PullRequestHostAction | null) => {
    if (!action) return;
    Dialog.alert(title, `Apply this action to pull request #${pr.number}?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Confirm", onPress: () => void execute(action) },
    ]);
  };
  return (
    <Sheet title={section} onClose={onClose}>
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 12,
            paddingBottom: Math.max(20, insets.bottom),
          }}
        >
          <View className="gap-4">
            {section === "Reviewers" ? (
              <View className="gap-3">
                {details?.reviewers.map((person) => (
                  <View key={person.id} className="gap-2">
                    <Text>
                      {person.name} · {azureReviewerStatus(person)}
                    </Text>
                    <View className="flex-row flex-wrap gap-2">
                      <PullRequestPermissionButton
                        reason={denied["reviewer-required"]}
                        label={person.required ? "Make optional" : "Make required"}
                        disabled={disabled || !active}
                        onPress={() =>
                          void execute({
                            type: "reviewer-required",
                            reviewerId: person.id,
                            required: !person.required,
                          })
                        }
                      />
                      <PullRequestPermissionButton
                        reason={denied["reviewer-flag"]}
                        label={person.flagged ? "Clear reviewer flag" : "Flag reviewer"}
                        disabled={
                          disabled || !details.canFlagReview || person.id !== details.viewerId
                        }
                        onPress={() =>
                          void execute({
                            type: "reviewer-flag",
                            reviewerId: person.id,
                            flagged: !person.flagged,
                          })
                        }
                      />
                      <PullRequestPermissionButton
                        reason={denied["reviewers"]}
                        label="Remove reviewer"
                        disabled={disabled}
                        onPress={() =>
                          void operate(() =>
                            review(
                              [{ id: person.id, kind: person.group ? "team" : "user" }],
                              false,
                            ),
                          )
                        }
                      />
                    </View>
                  </View>
                ))}
                <TextInput
                  accessibilityLabel="Reviewer email or ID"
                  placeholder="Reviewer email or ID"
                  value={reviewer}
                  onChangeText={setReviewer}
                  className={inputClass}
                />
                <PullRequestPermissionButton
                  reason={denied["reviewers"]}
                  label="Add reviewer"
                  disabled={disabled || !reviewer.trim()}
                  onPress={() =>
                    void operate(async () => {
                      await review([{ id: reviewer.trim(), kind: "user" }], true);
                      setReviewer("");
                    })
                  }
                />
              </View>
            ) : null}
            {section === "Tags" ? (
              <View className="gap-3">
                {pr.labels.map((label) => (
                  <PullRequestPermissionButton
                    reason={denied["labels"]}
                    key={label.name}
                    label={`Remove ${label.name}`}
                    disabled={disabled}
                    onPress={() => void operate(() => changeLabel(label.name, false))}
                  />
                ))}
                <TextInput
                  accessibilityLabel="New tag"
                  placeholder="Tag name"
                  value={tag}
                  onChangeText={setTag}
                  className={inputClass}
                />
                <PullRequestPermissionButton
                  reason={denied["labels"]}
                  label="Add tag"
                  disabled={disabled || !tag.trim()}
                  onPress={() =>
                    void operate(async () => {
                      await changeLabel(tag.trim(), true);
                      setTag("");
                    })
                  }
                />
              </View>
            ) : null}
            {section === "Linked work items" ? (
              <View className="gap-3">
                {details?.workItems.map((item) => (
                  <View key={item.id} className="gap-2">
                    <Text>
                      #{item.id} {item.title} · {item.state}
                    </Text>
                    <PullRequestPermissionButton
                      reason={denied["work-items"]}
                      label="Unlink"
                      disabled={disabled}
                      onPress={() =>
                        void execute({ type: "work-items", ids: [item.id], linked: false })
                      }
                    />
                  </View>
                ))}
                <TextInput
                  accessibilityLabel="Work item numbers"
                  placeholder="Work item numbers, separated by commas"
                  value={items}
                  onChangeText={setItems}
                  className={inputClass}
                />
                <PullRequestPermissionButton
                  reason={denied["work-items"]}
                  label="Link work items"
                  disabled={disabled || !items.trim()}
                  onPress={() =>
                    void operate(async () => {
                      const ids = parseAzureWorkItemIds(items);
                      if (!ids) throw new Error("Enter up to 25 valid work item numbers.");
                      await hostAction({ type: "work-items", ids, linked: true });
                      setItems("");
                    })
                  }
                />
              </View>
            ) : null}
            {section === "Attachments" ? (
              <View className="gap-3">
                {details?.attachments.map((file) => (
                  <View key={file.url} className="gap-2">
                    <Text>{file.name}</Text>
                    <Button
                      label="Open attachment"
                      onPress={() => void Linking.openURL(file.url)}
                    />
                    <Button
                      label="Copy Markdown link"
                      onPress={() =>
                        copyTextWithHaptic(
                          `[${file.name.replaceAll("[", "").replaceAll("]", "")}](${file.url})`,
                          { target: "attachment link" },
                        )
                      }
                    />
                    <PullRequestPermissionButton
                      reason={denied["attachment-delete"]}
                      label="Delete attachment"
                      disabled={disabled}
                      onPress={() =>
                        confirm(`Delete ${file.name}?`, {
                          type: "attachment-delete",
                          fileName: file.name,
                        })
                      }
                    />
                  </View>
                ))}
                <PullRequestPermissionButton
                  reason={denied["attachment-upload"]}
                  label="Upload PR attachment"
                  disabled={disabled}
                  onPress={() => void upload()}
                />
              </View>
            ) : null}
            {section === "Share by email" ? (
              <View className="gap-3">
                <TextInput
                  accessibilityLabel="Share recipients"
                  placeholder="Email addresses, separated by commas"
                  value={shareReceivers}
                  onChangeText={setShareReceivers}
                  className={inputClass}
                />
                <TextInput
                  accessibilityLabel="Share message"
                  placeholder="Optional message"
                  multiline
                  maxLength={4000}
                  value={shareMessage}
                  onChangeText={setShareMessage}
                  className={inputClass}
                />
                <PullRequestPermissionButton
                  reason={denied["share"]}
                  label="Share pull request"
                  disabled={disabled || !shareReceivers.trim()}
                  onPress={() => {
                    const receivers = splitAzureList(shareReceivers);
                    confirm(`Send PR #${pr.number} to ${receivers.join(", ")}?`, {
                      type: "share",
                      receivers,
                      message: shareMessage,
                    });
                  }}
                />
              </View>
            ) : null}
            {section === "Policies and checks" ? (
              <View className="gap-3">
                {loading ? <Text>Loading policies…</Text> : null}
                {details?.policies.map((policy) => (
                  <View key={policy.id} className="gap-2">
                    <Text>
                      {policy.name} · {policy.required ? "Required" : "Optional"} · {policy.status}
                    </Text>
                    {policy.url ? (
                      <Button
                        label="View policy"
                        onPress={() => {
                          if (policy.url) void Linking.openURL(policy.url);
                        }}
                      />
                    ) : null}
                    <PullRequestPermissionButton
                      reason={denied["requeue-policy"]}
                      label="Requeue"
                      disabled={disabled || !active}
                      onPress={() =>
                        void execute({ type: "requeue-policy", evaluationId: policy.id })
                      }
                    />
                  </View>
                ))}
                {details?.policies.length === 0 ? (
                  <Text className="text-foreground-muted">No branch policies reported.</Text>
                ) : null}
              </View>
            ) : null}
            {section === "Branches" ? (
              <View className="gap-3">
                <TextInput
                  accessibilityLabel="Target branch"
                  placeholder="Target branch"
                  value={branch}
                  onChangeText={setBranch}
                  className={inputClass}
                />
                <PullRequestPermissionButton
                  reason={denied["retarget"]}
                  label="Change target branch"
                  disabled={disabled || !branchActions.retarget}
                  onPress={() => confirm("Change target branch?", branchActions.retarget)}
                />
                <PullRequestPermissionButton
                  reason={denied["restart-merge"]}
                  label="Restart merge"
                  disabled={disabled || !active}
                  onPress={() => void execute({ type: "restart-merge" })}
                />
                {mergePreviewUrl ? (
                  <Button
                    label="View merge changes"
                    onPress={() => void Linking.openURL(mergePreviewUrl)}
                  />
                ) : null}
                <TextInput
                  accessibilityLabel="New branch name"
                  placeholder="New branch name"
                  value={newBranch}
                  onChangeText={setNewBranch}
                  className={inputClass}
                />
                <View className="flex-row gap-2">
                  <PullRequestPermissionButton
                    reason={denied["cherry-pick"]}
                    label="Cherry-pick"
                    disabled={disabled || !branchActions.cherryPick}
                    onPress={() => confirm("Cherry-pick changes?", branchActions.cherryPick)}
                  />
                  <PullRequestPermissionButton
                    reason={denied["revert"]}
                    label="Revert"
                    disabled={disabled || !branchActions.revert}
                    onPress={() => confirm("Revert changes?", branchActions.revert)}
                  />
                </View>
              </View>
            ) : null}
            {section === "Completion options" ? (
              <View className="gap-3">
                <Menu
                  title="Merge strategy"
                  actions={AzureDevOpsMergeStrategy.literals.map((value) => ({
                    id: value,
                    title: azureMergeStrategyLabels[value],
                    state: options.strategy === value ? "on" : "off",
                    attributes: {
                      disabled:
                        !completion.bypassPolicy && allowedStrategies?.includes(value) === false,
                    },
                  }))}
                  onPressAction={({ nativeEvent }) => {
                    const strategy = AzureDevOpsMergeStrategy.literals.find(
                      (value) => value === nativeEvent.event,
                    );
                    if (strategy) setCompletion((current) => ({ ...current, strategy }));
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Azure merge strategy"
                    className="min-h-12 justify-center"
                  >
                    <Text>{azureMergeStrategyLabels[options.strategy]} ▾</Text>
                  </Pressable>
                </Menu>
                {azureCompletionToggles.map((toggle) => {
                  const reason = toggle.permission ? denied[toggle.permission] : undefined;
                  return (
                    <View key={toggle.key} className="flex-row items-center justify-between">
                      <Text>{toggle.label}</Text>
                      <Switch
                        disabled={Boolean(reason) && !completion[toggle.key]}
                        accessibilityLabel={reason ? `${toggle.label}. ${reason}` : toggle.label}
                        value={completion[toggle.key]}
                        onValueChange={(value) =>
                          setCompletion((current) => ({ ...current, [toggle.key]: value }))
                        }
                      />
                    </View>
                  );
                })}
                {completion.bypassPolicy ? (
                  <TextInput
                    accessibilityLabel="Policy override reason"
                    placeholder="Override reason"
                    value={completion.bypassReason}
                    onChangeText={(bypassReason) =>
                      setCompletion((current) => ({ ...current, bypassReason }))
                    }
                    className={inputClass}
                  />
                ) : null}
                <TextInput
                  accessibilityLabel="Merge commit message"
                  placeholder="Optional merge commit message"
                  multiline
                  value={completion.message}
                  onChangeText={(message) => setCompletion((current) => ({ ...current, message }))}
                  className={inputClass}
                />
                <PullRequestPermissionButton
                  reason={completionBlock}
                  label="Complete with these options"
                  disabled={disabled}
                  onPress={() =>
                    confirm("Complete pull request?", {
                      type: "complete",
                      automatic: false,
                      ...options,
                    })
                  }
                />
                <PullRequestPermissionButton
                  reason={completionBlock}
                  label="Set auto-complete"
                  disabled={disabled}
                  onPress={() =>
                    confirm("Set auto-complete?", { type: "complete", automatic: true, ...options })
                  }
                />
              </View>
            ) : null}
            {feedback}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  );
}
