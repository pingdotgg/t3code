import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { pullRequestMergeRequirementsUnmet } from "@t3tools/client-runtime/review-workspace";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestDetail, PullRequestMergeMethod } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Modal, Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
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
import { PullRequestGlyph } from "./pullRequestGlyphs";

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
  const canBypassRequirements = canAdminMerge && requirementsUnmet;
  const confirmationKey = `${target.environmentId}:${pr.projectId}:${pr.repository}:${pr.number}:${pr.headSha ?? ""}:${method ?? ""}`;
  const bypass = confirmation?.key === confirmationKey && confirmation.bypass;
  const confirmationOpen = confirmation?.key === confirmationKey && canBypassRequirements;
  const canConfirmAutoMerge = canAutoMerge && autoAction === "enable-auto-merge";
  if (confirmation !== null && (!canBypassRequirements || confirmation.key !== confirmationKey))
    setConfirmation(null);
  const perform = async (
    action: "merge" | "enable-auto-merge" | "disable-auto-merge",
    adminOverride = false,
  ) => {
    if (
      pending.current ||
      (action !== "disable-auto-merge" && !method) ||
      (action === "merge" ? (adminOverride ? !canBypassRequirements : !canMerge) : !canAutoMerge)
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
                    throw new Error("The pull request changed. Refresh before merging.");
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
    if (action === "merge" && canBypassRequirements) {
      setConfirmation({ key: confirmationKey, bypass: false });
      return;
    }
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
              <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
            ) : (
              <SymbolView
                name={PullRequestGlyph.merged}
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
          <Menu
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
                <IconButton
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
          </Menu>
        ) : null}
      </View>
      {permissions.connected &&
      reason &&
      reason !== MERGE_CONFLICT_REASON &&
      reason !== "Checking stack membership…" &&
      !(checkingStack && reason === "Refresh the stack before merging.") ? (
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
                  : canConfirmAutoMerge || pr.autoMergeEnabled
                    ? "Merge requirements have not passed. Auto-merge waits for them to be met."
                    : "Merge requirements have not passed."}
              </Text>
            </View>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel="Merge without waiting for requirements to be met (bypass rules)"
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
                Merge without waiting for requirements to be met (bypass rules)
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
      {pr.autoMergeEnabled ? (
        <Text className="px-1 text-xs text-foreground-muted">
          Auto-merge is enabled{pr.autoMergeMethod ? ` · ${pr.autoMergeMethod}` : ""}
        </Text>
      ) : null}
      {stack.error && stack.supportsStackActions ? (
        <Button label="Retry stack lookup" tone="text" onPress={stack.refresh} />
      ) : null}
    </View>
  );
}
