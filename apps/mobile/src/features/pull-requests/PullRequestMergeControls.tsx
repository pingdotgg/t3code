import * as Dialog from "../../components/ui/Dialog";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { pullRequestMergeRequirementsUnmet } from "@t3tools/client-runtime/review-workspace";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestDetail, PullRequestMergeMethod } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Modal, Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SplitButton } from "../../components/ui/SplitButton";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  allowedMergeMethods,
  canPerformPullRequestAction,
  mergeUnavailableReason,
  MERGE_METHODS,
  PR_ACTION_ICONS,
  pullRequestActionLabel,
} from "./pullRequestActions";
import { pullRequestStackMerge, singlePullRequestMergeAllowed } from "./pullRequestStack";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestAction } from "./usePullRequestAction";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { PullRequestGlyph } from "./pullRequestGlyphs";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import type { PullRequestStackState } from "./usePullRequestStack";

export function PullRequestMergeControls(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
}) {
  const { pr, stack } = props;
  const terminology = sourceControlClients.get(pr.provider).changeRequest;
  const target = pullRequestTarget(props.params);
  const permissions = usePullRequestPermissions(props.params, pr);
  const stateAction = usePullRequestAction(props.params, pr);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const runAction = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(target));
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(target));
  const [selectedMethod, setSelectedMethod] = useState<PullRequestMergeMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [confirmation, setConfirmation] = useState<{ key: string; bypass: boolean } | null>(null);
  const methods = allowedMergeMethods(pr);
  const preferred =
    selectedMethod ??
    (AsyncResult.isSuccess(preferences) ? preferences.value.pullRequestMergeMethod : undefined) ??
    "squash";
  const method = methods.includes(preferred)
    ? preferred
    : methods.includes("squash")
      ? "squash"
      : methods[0];
  const scope = stack.stack ? pullRequestStackMerge(stack.stack, pr.number, terminology) : null;
  const canMergeSingle = singlePullRequestMergeAllowed({
    supportsStackActions: stack.supportsStackActions,
    hasStack: stack.stack !== null,
    isFresh: stack.isFresh,
  });
  const checkingStack =
    permissions.connected && stack.supportsStackActions && !stack.isFresh && !stack.error;
  const reason =
    (!permissions.connected
      ? "Reconnect to merge."
      : mergeUnavailableReason(pr, permissions.canWrite, terminology)) ??
    (stack.stack
      ? !stack.supportsStackActions
        ? "This environment can display stacks but cannot merge them."
        : !stack.isFresh
          ? "Refresh the stack before merging."
          : scope?.reason
      : !canMergeSingle
        ? stack.error
          ? "Couldn't check stack membership. Refresh before merging."
          : "Checking stack membership…"
        : null);
  const canMerge = !busy && method !== undefined && !reason;
  const label = method
    ? scope && scope.layers.length > 1
      ? `${MERGE_METHODS[method].title} stack (${scope.layers.length})`
      : MERGE_METHODS[method].title
    : "Merge unavailable";
  const nextAction =
    pr.state === "closed" ? "reopen" : pr.state === "open" && pr.isDraft ? "ready" : null;
  // States the button itself names, instead of a reason line under it. Draft and
  // closed offer their way forward when the viewer can take it.
  const status: {
    label: string;
    icon: AppSymbolName;
    final?: boolean;
    action?: "ready" | "reopen";
  } | null =
    nextAction && stateAction.available(nextAction)
      ? {
          label: pullRequestActionLabel(nextAction, terminology),
          icon: PR_ACTION_ICONS[nextAction],
          final: nextAction === "reopen",
          action: nextAction,
        }
      : pr.state === "merged"
        ? { label: "Merged", icon: PullRequestGlyph.merged, final: true }
        : pr.state === "closed"
          ? { label: "Closed", icon: PullRequestGlyph.closed, final: true }
          : pr.isDraft
            ? { label: "Draft", icon: PullRequestGlyph.draft }
            : pr.mergeability === "conflicting"
              ? { label: "Resolve conflicts to merge", icon: PullRequestGlyph.conflicting }
              : pr.autoMergeEnabled
                ? {
                    label: `Auto-merge pending${pr.autoMergeMethod ? ` (${pr.autoMergeMethod})` : ""}`,
                    icon: "clock",
                  }
                : checkingStack && !busy
                  ? { label: "Checking stack…", icon: PullRequestGlyph.merged }
                  : null;
  const autoAction = pr.autoMergeEnabled ? "disable-auto-merge" : "enable-auto-merge";
  const canAutoMerge =
    !busy &&
    (autoAction === "disable-auto-merge" || (!stack.stack && canMergeSingle)) &&
    permissions.canWrite &&
    canPerformPullRequestAction(pr, autoAction);

  const canAdminMerge =
    permissions.connected &&
    permissions.canWrite &&
    pr.viewerPermissions.adminMerge === true &&
    canPerformPullRequestAction(pr, "merge") &&
    !stack.stack &&
    canMergeSingle &&
    method !== undefined;
  const requirementsUnmet = pullRequestMergeRequirementsUnmet({
    mergeRequirementsSatisfied: pr.mergeRequirementsSatisfied,
    checks: pr.checks,
    baseBehind: pr.baseComparison === "behind" && pr.mergeability === "mergeable",
  });
  const confirmationKey = `${target.environmentId}:${pr.projectId}:${pr.repository}:${pr.number}:${pr.headSha ?? ""}:${method ?? ""}`;
  const bypass = confirmation?.key === confirmationKey && confirmation.bypass;
  const confirmationOpen = confirmation?.key === confirmationKey && canAdminMerge;
  const canConfirmAutoMerge = canAutoMerge && autoAction === "enable-auto-merge";
  if (confirmation !== null && (!canAdminMerge || confirmation.key !== confirmationKey))
    setConfirmation(null);
  const perform = async (
    action: "merge" | "enable-auto-merge" | "disable-auto-merge",
    adminOverride = false,
  ) => {
    if (
      pending.current ||
      (action !== "disable-auto-merge" && !method) ||
      (action === "merge" ? (adminOverride ? !canAdminMerge : !canMerge) : !canAutoMerge)
    )
      return false;
    pending.current = true;
    setBusy(true);
    return await (async () => {
      const response = await runAction({
        ...target,
        input: {
          ...target.input,
          action,
          ...(adminOverride ? { adminOverride: true, mergeMethod: method } : {}),
          ...(action === "merge" && method && stack.stack && scope
            ? {
                resolveMergeMethod: (fresh) => {
                  if (
                    !canPerformPullRequestAction(fresh, "merge") ||
                    !allowedMergeMethods(fresh).includes(method)
                  )
                    throw new Error(`The ${terminology.singular} changed. Refresh before merging.`);
                  return method;
                },
              }
            : action === "merge" && method && !adminOverride
              ? {
                  resolveMergeMethod: (fresh) => {
                    if (
                      !canPerformPullRequestAction(fresh, "merge") ||
                      !allowedMergeMethods(fresh).includes(method)
                    )
                      throw new Error("The pull request changed. Refresh before merging.");
                    return method;
                  },
                }
              : action === "enable-auto-merge" && method
                ? { mergeMethod: method }
                : {}),
        },
      });
      if (response._tag === "Failure") throw squashAtomCommandFailure(response);
      return true;
    })()
      .catch(async (cause: unknown) => {
        Dialog.alert(
          "Couldn't complete the merge action",
          cause instanceof Error ? cause.message : "Try again.",
        );
        return false;
      })
      .finally(async () => {
        // A stack can partly merge before the provider reports a failure.
        refreshDetail();
        refreshActivity();
        stack.refresh();
        pending.current = false;
        setBusy(false);
      });
  };
  const confirm = (action: "merge" | "enable-auto-merge" | "disable-auto-merge") => {
    if (action === "merge" && canAdminMerge) {
      setConfirmation({ key: confirmationKey, bypass: false });
      return;
    }
    const title =
      action === "merge"
        ? scope && scope.layers.length > 1
          ? `Merge ${scope.layers.length} stack layers?`
          : `${pullRequestActionLabel("merge", terminology)}?`
        : action === "enable-auto-merge"
          ? "Enable auto-merge?"
          : "Disable auto-merge?";
    const message =
      action === "merge" && scope
        ? `Merge ${scope.layers.map((layer) => `#${layer.number}`).join(" → ")} into ${stack.stack?.base} using ${method}. Layers above #${pr.number} stay open.`
        : action === "enable-auto-merge"
          ? `Merge #${pr.number} using ${method} when its requirements are met. This may happen immediately.`
          : action === "disable-auto-merge"
            ? `Stop the provider from automatically merging this ${terminology.singular}.`
            : `Merge #${pr.number} into ${pr.baseBranch} using ${method}.`;
    Dialog.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: action === "merge" ? label : title.replace("?", ""),
        onPress: () => void perform(action),
      },
    ]);
  };
  return (
    <View className="gap-2 border-t border-border-subtle p-3">
      <SplitButton
        label={
          busy || stateAction.busy
            ? "Working…"
            : !permissions.connected
              ? "Reconnect to merge"
              : (status?.label ?? label)
        }
        accessibilityLabel={
          status
            ? status.label
            : scope
              ? `${label}, ${scope.layers.length} stack layers through #${pr.number}`
              : label
        }
        icon={status?.icon ?? PullRequestGlyph.merged}
        disabled={status?.action ? stateAction.busy : !canMerge || status !== null}
        loading={busy || stateAction.busy || (!status?.action && checkingStack)}
        onPress={() =>
          status?.action ? void stateAction.perform(status.action) : confirm("merge")
        }
        menuTitle="Merge options"
        actions={
          status?.final
            ? []
            : [
                ...methods.map((id) => ({
                  id,
                  title: MERGE_METHODS[id].title,
                  state: id === method ? ("on" as const) : ("off" as const),
                  attributes: { disabled: !canMerge && !canAutoMerge },
                })),
                ...(canAutoMerge
                  ? [
                      {
                        id: autoAction,
                        title: pr.autoMergeEnabled ? "Disable auto-merge" : "Enable auto-merge",
                        image: "clock",
                      },
                    ]
                  : []),
              ]
        }
        onPressAction={(id) => {
          const selected = methods.find((method) => method === id);
          if (selected) {
            setSelectedMethod(selected);
            savePreferences({ pullRequestMergeMethod: selected });
          } else if (id === autoAction && canAutoMerge) confirm(autoAction);
        }}
      />
      {permissions.connected && !status && reason ? (
        <Text className="px-1 text-xs text-foreground-muted">{reason}</Text>
      ) : null}
      <Modal
        visible={confirmationOpen}
        transparent
        animationType="fade"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => {
          if (!pending.current) setConfirmation(null);
        }}
      >
        <View className="flex-1 items-center justify-center bg-backdrop px-6">
          <View className="w-full max-w-lg gap-4 rounded-[24px] bg-card px-5 py-5">
            <View className="gap-1">
              <Text className="text-lg font-t3-semibold">
                {method ? MERGE_METHODS[method].title : "Merge pull request"}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {bypass
                  ? `Merge #${pr.number} into ${pr.baseBranch} before its requirements are met.`
                  : requirementsUnmet
                    ? canConfirmAutoMerge || pr.autoMergeEnabled
                      ? "Merge requirements have not passed. Auto-merge waits for them to be met."
                      : "Merge requirements have not passed."
                    : `Merge #${pr.number} into ${pr.baseBranch} using ${method}.`}
              </Text>
            </View>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel="Merge with admin permissions"
              accessibilityState={{ checked: bypass, disabled: busy }}
              disabled={busy}
              className="min-h-11 flex-row items-start gap-2 py-2"
              onPress={() => setConfirmation({ key: confirmationKey, bypass: !bypass })}
            >
              <View
                className={`mt-0.5 size-5 shrink-0 items-center justify-center rounded border ${bypass ? "border-primary bg-primary" : "border-border"}`}
              >
                {bypass ? (
                  <SymbolView
                    name="checkmark"
                    size={12}
                    tintColorClassName="accent-primary-foreground"
                  />
                ) : null}
              </View>
              <Text className="min-w-0 flex-1 text-sm text-danger-foreground">
                Merge with admin permissions
              </Text>
            </Pressable>
            <View className="flex-row flex-wrap justify-end gap-2">
              <Button label="Cancel" disabled={busy} onPress={() => setConfirmation(null)} />
              <Button
                label={
                  busy
                    ? "Working…"
                    : bypass
                      ? "Bypass rules and merge"
                      : canConfirmAutoMerge
                        ? "Enable auto-merge"
                        : "Confirm merge"
                }
                tone={bypass ? "danger" : "primary"}
                disabled={busy || (!bypass && !canMerge && !canConfirmAutoMerge)}
                loading={busy}
                onPress={async () => {
                  const completed = await perform(
                    bypass || !canConfirmAutoMerge ? "merge" : "enable-auto-merge",
                    bypass,
                  );
                  if (completed) setConfirmation(null);
                }}
              />
            </View>
          </View>
        </View>
      </Modal>
      {stack.error && stack.supportsStackActions ? (
        <Button label="Retry stack lookup" tone="text" onPress={stack.refresh} />
      ) : null}
    </View>
  );
}
