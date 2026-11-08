import * as Dialog from "../../components/ui/Dialog";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { pullRequestChecksState } from "@t3tools/client-runtime/pull-request-checks";
import {
  allowsSinglePullRequestMerge,
  PULL_REQUEST_MERGE_METHOD_LABELS,
  pullRequestArmedAutoMergeLabel,
  pullRequestPendingAutoMergeLabel,
  pullRequestShowsAutoMerge,
  pullRequestShowsMergeNow,
  resolvePullRequestPrimaryControl,
} from "@t3tools/client-runtime/pull-request-merge";
import type { PullRequestDetail, PullRequestMergeMethod } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";
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
import { pullRequestStackMerge } from "./pullRequestStack";
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
  const canMergeSingle = allowsSinglePullRequestMerge({
    supportsStackActions: stack.supportsStackActions,
    hasStack: stack.stack !== null,
    stackPending: !stack.isFresh,
    stackError: stack.error,
  });
  const stackOwnsMerge = stack.supportsStackActions && stack.stack !== null;
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
  const canEnableAutoMergeAction =
    !stackOwnsMerge && permissions.canWrite && canPerformPullRequestAction(pr, "enable-auto-merge");
  const canDisableAutoMergeAction =
    !stackOwnsMerge &&
    permissions.canWrite &&
    canPerformPullRequestAction(pr, "disable-auto-merge");
  const canEnableAutoMerge = !busy && canMergeSingle && canEnableAutoMergeAction;
  const canDisableAutoMerge = !busy && canDisableAutoMergeAction;
  const detailChecksState = pullRequestChecksState(pr.checks);
  // List rollups can omit workflows awaiting approval. Only refreshed detail can clear those.
  const checksState =
    detailChecksState !== "failing" && pr.checks.some((check) => check.status === "action-required")
      ? "pending"
      : detailChecksState;
  const primaryAction = resolvePullRequestPrimaryControl({
    state: pr.state,
    isDraft: pr.isDraft,
    mergeability: pr.mergeability,
    checksState,
    autoMergeEnabled: pr.autoMergeEnabled,
    hasMergeMethod: methods.length > 0,
    canMerge: !stackOwnsMerge && canPerformPullRequestAction(pr, "merge"),
    canMarkReady: stateAction.available("ready"),
    canEnableAutoMerge: canEnableAutoMergeAction,
  });
  const methodLabel = method ? MERGE_METHODS[method].title : "Merge unavailable";
  const selectedMergeMethodLabel = method ? PULL_REQUEST_MERGE_METHOD_LABELS[method] : methodLabel;
  const pendingAutoMergeLabel = pullRequestPendingAutoMergeLabel(selectedMergeMethodLabel);
  const armedAutoMergeLabel = pullRequestArmedAutoMergeLabel(pr.autoMergeMethod);
  const mergeLabel =
    scope && method && scope.layers.length > 1
      ? `${MERGE_METHODS[method].title} stack (${scope.layers.length})`
      : methodLabel;
  const showsMergeNow = pullRequestShowsMergeNow({
    canMergeSingle,
    state: pr.state,
    primaryAction,
    canMerge: canPerformPullRequestAction(pr, "merge"),
    isDraft: pr.isDraft,
    conflicting: pr.mergeability === "conflicting",
    hasMergeMethod: methods.length > 0,
  });
  const showsAutoMerge = pullRequestShowsAutoMerge({
    canMergeSingle,
    state: pr.state,
    autoMergeArmed: primaryAction === "auto-merge-armed",
    canDisableAutoMerge,
    canEnableAutoMerge,
    primaryAction,
    isDraft: pr.isDraft,
    conflicting: pr.mergeability === "conflicting",
    hasMergeMethod: methods.length > 0,
  });
  const nextAction =
    pr.state === "closed" ? "reopen" : pr.state === "open" && pr.isDraft ? "ready" : null;
  // States the button itself names, instead of a reason line under it. Draft and
  // closed offer their way forward when the viewer can take it. Stacks keep merge
  // on this control; desktop moves that to the stack menu.
  const status: {
    label: string;
    icon: AppSymbolName;
    final?: boolean;
    action?: "ready" | "reopen" | "enable-auto-merge" | "merge";
  } | null =
    nextAction && stateAction.available(nextAction) && primaryAction !== "ready"
      ? {
          label: pullRequestActionLabel(nextAction, terminology),
          icon: PR_ACTION_ICONS[nextAction],
          final: nextAction === "reopen",
          action: nextAction,
        }
      : primaryAction === "merged"
        ? { label: "Merged", icon: PullRequestGlyph.merged, final: true }
        : primaryAction === "closed"
          ? { label: "Closed", icon: PullRequestGlyph.closed, final: true }
          : primaryAction === "resolve"
            ? { label: "Resolve conflicts to merge", icon: PullRequestGlyph.conflicting }
            : primaryAction === "ready"
              ? {
                  label: pullRequestActionLabel("ready", terminology),
                  icon: PR_ACTION_ICONS.ready,
                  action: "ready",
                }
              : primaryAction === "auto-merge-armed"
                ? { label: armedAutoMergeLabel, icon: "clock" }
                : primaryAction === "enable-auto-merge"
                  ? {
                      label: pendingAutoMergeLabel,
                      icon: "clock",
                      action: "enable-auto-merge",
                    }
                  : primaryAction === "merge" || stackOwnsMerge
                    ? null
                    : pr.isDraft
                      ? { label: "Draft", icon: PullRequestGlyph.draft }
                      : checkingStack && !busy
                        ? { label: "Checking stack…", icon: PullRequestGlyph.merged }
                        : null;
  const primaryMerge =
    status === null && (primaryAction === "merge" || stackOwnsMerge) ? ("merge" as const) : null;
  const buttonAction = status?.action ?? primaryMerge;
  const buttonLabel =
    buttonAction === "enable-auto-merge"
      ? pendingAutoMergeLabel
      : buttonAction === "merge"
        ? mergeLabel
        : (status?.label ?? mergeLabel);

  const perform = async (action: "merge" | "enable-auto-merge" | "disable-auto-merge") => {
    const allowed =
      action === "merge"
        ? canMerge || (showsMergeNow && !busy && method !== undefined)
        : action === "enable-auto-merge"
          ? canEnableAutoMerge
          : canDisableAutoMerge;
    if (pending.current || (action !== "disable-auto-merge" && !method) || !allowed) return;
    pending.current = true;
    setBusy(true);
    const response = await runAction({
      ...target,
      input: {
        ...target.input,
        action,
        ...(action === "merge" && method && stack.stack && scope
          ? {
              stackNumber: stack.stack.number,
              expectedStackHeads: scope.heads,
              mergeMethod: method,
            }
          : action === "merge" && method
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
            : action === "enable-auto-merge" && method
              ? { mergeMethod: method }
              : {}),
      },
    });
    // A stack can partly merge before the provider reports a failure.
    if (!AsyncResult.isSuccess(response)) refreshDetail();
    refreshActivity();
    stack.refresh();
    pending.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      Dialog.alert(
        "Couldn't complete the merge action",
        cause instanceof Error ? cause.message : "Try again.",
      );
    }
  };
  const confirm = (action: "merge" | "enable-auto-merge" | "disable-auto-merge") => {
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
        text:
          action === "merge"
            ? showsMergeNow && primaryAction !== "merge"
              ? "Merge now"
              : mergeLabel
            : action === "enable-auto-merge"
              ? "Enable auto-merge"
              : "Disable auto-merge",
        onPress: () => void perform(action),
      },
    ]);
  };
  const pressPrimary = () => {
    if (buttonAction === "ready" || buttonAction === "reopen") {
      void stateAction.perform(buttonAction);
      return;
    }
    if (buttonAction === "enable-auto-merge") {
      confirm("enable-auto-merge");
      return;
    }
    if (buttonAction === "merge") confirm("merge");
  };
  return (
    <View className="gap-2 border-t border-border-subtle p-3">
      <SplitButton
        label={
          busy || stateAction.busy
            ? "Working…"
            : !permissions.connected
              ? "Reconnect to merge"
              : buttonLabel
        }
        accessibilityLabel={
          scope && buttonAction === "merge"
            ? `${mergeLabel}, ${scope.layers.length} stack layers through #${pr.number}`
            : buttonLabel
        }
        icon={
          buttonAction === "enable-auto-merge" || primaryAction === "auto-merge-armed"
            ? "clock"
            : (status?.icon ?? PullRequestGlyph.merged)
        }
        disabled={
          buttonAction === "ready" || buttonAction === "reopen"
            ? stateAction.busy
            : buttonAction === "enable-auto-merge"
              ? !canEnableAutoMerge
              : buttonAction === "merge"
                ? !(canMerge || (showsMergeNow && !busy && method !== undefined))
                : true
        }
        loading={busy || stateAction.busy || (buttonAction === null && checkingStack)}
        onPress={pressPrimary}
        menuTitle="Merge options"
        actions={
          status?.final
            ? []
            : [
                ...methods.map((id) => ({
                  id,
                  title: MERGE_METHODS[id].title,
                  state: id === method ? ("on" as const) : ("off" as const),
                  attributes: {
                    disabled: !canMerge && !canEnableAutoMerge && !showsMergeNow,
                  },
                })),
                ...(showsMergeNow
                  ? [
                      {
                        id: "merge",
                        title: "Merge now",
                        image: PullRequestGlyph.merged,
                      },
                    ]
                  : []),
                ...(showsAutoMerge
                  ? [
                      {
                        id:
                          primaryAction === "auto-merge-armed"
                            ? "disable-auto-merge"
                            : "enable-auto-merge",
                        title:
                          primaryAction === "auto-merge-armed"
                            ? "Disable auto-merge"
                            : "Enable auto-merge",
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
          } else if (id === "merge" && showsMergeNow) confirm("merge");
          else if (id === "enable-auto-merge" && canEnableAutoMerge) confirm("enable-auto-merge");
          else if (id === "disable-auto-merge" && canDisableAutoMerge)
            confirm("disable-auto-merge");
        }}
      />
      {permissions.connected &&
      reason &&
      !status?.final &&
      buttonAction !== "ready" &&
      buttonAction !== "reopen" ? (
        <Text className="px-1 text-xs text-foreground-muted">{reason}</Text>
      ) : null}
      {stack.error && stack.supportsStackActions ? (
        <Button label="Retry stack lookup" tone="text" onPress={stack.refresh} />
      ) : null}
    </View>
  );
}
