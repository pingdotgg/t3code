import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestDetail, PullRequestMergeMethod } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { Button } from "../../components/Button";
import { MaterialIconButton } from "../../components/MaterialIconButton";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  allowedMergeMethods,
  canPerformPullRequestAction,
  mergeUnavailableReason,
  MERGE_CONFLICT_REASON,
  MERGE_METHODS,
} from "./pullRequestActions";
import { pullRequestStackMerge, singlePullRequestMergeAllowed } from "./pullRequestStack";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import type { PullRequestStackState } from "./usePullRequestStack";

export function PullRequestMergeControls(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
}) {
  const { pr, stack } = props;
  const target = pullRequestTarget(props.params);
  const permissions = usePullRequestPermissions(props.params, pr);
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
  const scope = stack.stack ? pullRequestStackMerge(stack.stack, pr.number) : null;
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
      : mergeUnavailableReason(pr, permissions.canWrite)) ??
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
  const autoAction = pr.autoMergeEnabled ? "disable-auto-merge" : "enable-auto-merge";
  const canAutoMerge =
    !busy &&
    (autoAction === "disable-auto-merge" || (!stack.stack && canMergeSingle)) &&
    permissions.canWrite &&
    canPerformPullRequestAction(pr, autoAction);

  const perform = async (action: "merge" | "enable-auto-merge" | "disable-auto-merge") => {
    if (
      pending.current ||
      (action !== "disable-auto-merge" && !method) ||
      (action === "merge" ? !canMerge : !canAutoMerge)
    )
      return;
    pending.current = true;
    setBusy(true);
    try {
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
    } catch (cause) {
      Alert.alert(
        "Couldn't complete the merge action",
        cause instanceof Error ? cause.message : "Try again.",
      );
    } finally {
      // A stack can partly merge before the provider reports a failure.
      refreshDetail();
      refreshActivity();
      stack.refresh();
      pending.current = false;
      setBusy(false);
    }
  };
  const confirm = (action: "merge" | "enable-auto-merge" | "disable-auto-merge") => {
    const title =
      action === "merge"
        ? scope && scope.layers.length > 1
          ? `Merge ${scope.layers.length} stack layers?`
          : "Merge pull request?"
        : action === "enable-auto-merge"
          ? "Enable auto-merge?"
          : "Disable auto-merge?";
    const message =
      action === "merge" && scope
        ? `Merge ${scope.layers.map((layer) => `#${layer.number}`).join(" → ")} into ${stack.stack?.base} using ${method}. Layers above #${pr.number} stay open.`
        : action === "enable-auto-merge"
          ? `Merge #${pr.number} using ${method} when its requirements are met. This may happen immediately.`
          : action === "disable-auto-merge"
            ? "Stop the provider from automatically merging this pull request."
            : `Merge #${pr.number} into ${pr.baseBranch} using ${method}.`;
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: action === "merge" ? label : title.replace("?", ""),
        onPress: () => void perform(action),
      },
    ]);
  };
  return (
    <View className="gap-2 border-t border-border-subtle p-3">
      <View
        className={
          Platform.OS === "android"
            ? "flex-row items-center gap-2"
            : `flex-row overflow-hidden rounded-xl border-continuous ${canMerge ? "bg-prominent-action" : "bg-subtle-strong"}`
        }
      >
        {Platform.OS === "android" ? (
          <View className="min-w-0 flex-1">
            <Button
              label={busy ? "Working…" : !permissions.connected ? "Reconnect to merge" : label}
              tone="primary"
              fullWidth
              disabled={!canMerge}
              loading={busy || checkingStack}
              onPress={() => confirm("merge")}
            />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              scope ? `${label}, ${scope.layers.length} stack layers through #${pr.number}` : label
            }
            accessibilityState={{ disabled: !canMerge, busy: busy || checkingStack }}
            disabled={!canMerge}
            onPress={() => confirm("merge")}
            className="min-h-11 min-w-0 flex-1 flex-row items-center justify-center gap-2 px-3 py-2 active:opacity-70"
          >
            {busy || checkingStack ? (
              <ActivityIndicator size="small" colorClassName="accent-icon-muted" />
            ) : (
              <SymbolView
                name="arrow.triangle.merge"
                size={16}
                tintColorClassName={
                  canMerge ? "accent-prominent-action-foreground" : "accent-icon-muted"
                }
              />
            )}
            <Text
              className={`shrink text-center text-sm font-t3-semibold ${canMerge ? "text-prominent-action-foreground" : "text-foreground-muted"}`}
            >
              {busy ? "Working…" : !permissions.connected ? "Reconnect to merge" : label}
            </Text>
          </Pressable>
        )}
        {methods.length > 0 || canAutoMerge ? (
          <ControlPillMenu
            title="Merge options"
            actions={[
              ...methods.map((id) => ({
                id,
                title: MERGE_METHODS[id].title,
                state: id === method ? ("on" as const) : ("off" as const),
                attributes: { disabled: busy },
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
            ]}
            onPressAction={({ nativeEvent }) => {
              const selected = methods.find((id) => id === nativeEvent.event);
              if (selected) {
                setSelectedMethod(selected);
                savePreferences({ pullRequestMergeMethod: selected });
              } else if (nativeEvent.event === autoAction && canAutoMerge) confirm(autoAction);
            }}
          >
            {Platform.OS === "android" ? (
              <View pointerEvents="none">
                <MaterialIconButton
                  accessibilityLabel="Merge options"
                  icon="chevron.down"
                  variant="tonal"
                />
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Merge options"
                className="min-h-11 w-11 items-center justify-center border-l border-border-subtle"
              >
                <SymbolView
                  name="chevron.down"
                  size={13}
                  tintColorClassName={
                    canMerge ? "accent-prominent-action-foreground" : "accent-icon-muted"
                  }
                />
              </Pressable>
            )}
          </ControlPillMenu>
        ) : null}
      </View>
      {permissions.connected &&
      reason &&
      reason !== MERGE_CONFLICT_REASON &&
      reason !== "Checking stack membership…" &&
      !(checkingStack && reason === "Refresh the stack before merging.") ? (
        <Text className="px-1 text-xs text-foreground-muted">{reason}</Text>
      ) : null}
      {pr.autoMergeEnabled ? (
        <Text className="px-1 text-xs text-foreground-muted">
          Auto-merge is enabled{pr.autoMergeMethod ? ` · ${pr.autoMergeMethod}` : ""}
        </Text>
      ) : null}
      {stack.error && stack.supportsStackActions ? (
        <Pressable
          accessibilityRole="button"
          onPress={stack.refresh}
          className="min-h-11 justify-center px-1"
        >
          <Text className="text-sm text-primary-text">Retry stack lookup</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
