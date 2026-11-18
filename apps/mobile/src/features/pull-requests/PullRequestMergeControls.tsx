import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { pullRequestMergeRequirementsUnmet } from "@t3tools/client-runtime/review-workspace";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import type { PullRequestDetail, PullRequestMergeMethod } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { AsyncResult } from "effect/reactivity";
import { useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SplitButton } from "../../components/ui/SplitButton";
import { useEnvironmentServerConfig } from "../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  allowedMergeMethods,
  canPerformPullRequestAction,
  mergeUnavailableReason,
  MERGE_METHODS,
  mergeMethodKind,
  PR_ACTION_ICONS,
  pullRequestActionLabel,
  resolveMergeMethod,
  pullRequestMergeConfirmationAction,
} from "./pullRequestActions";
import { pullRequestStackMerge, singlePullRequestMergeAllowed } from "./pullRequestStack";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestAction } from "./usePullRequestAction";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import { PullRequestGlyph } from "./pullRequestGlyphs";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import type { PullRequestStackState } from "./usePullRequestStack";
import { m as resolveMessage } from "../../i18n/messages";

export function PullRequestMergeControls(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
}) {
  const { pr, stack } = props;
  const gt = useGT();
  const m = useMessages();
  const terminology = sourceControlClients.get(pr.provider).changeRequest;
  const target = pullRequestTarget(props.params);
  const permissions = usePullRequestPermissions(props.params, pr);
  const stateAction = usePullRequestAction(props.params, pr);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const serverSettings = useEnvironmentServerConfig(target.environmentId)?.settings;
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const runAction = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(target));
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(target));
  const [selectedMethod, setSelectedMethod] = useState<PullRequestMergeMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [confirmation, setConfirmation] = useState<{ key: string; bypass: boolean } | null>(null);
  const methods = allowedMergeMethods(pr);
  const method = resolveMergeMethod(
    pr,
    selectedMethod,
    serverSettings
      ? resolveProjectSettings(serverSettings, target.input.projectId).settings
          .pullRequestMergeMethod
      : null,
    AsyncResult.isSuccess(preferences) ? preferences.value.pullRequestMergeMethod : undefined,
  );
  const scope = stack.stack ? pullRequestStackMerge(stack.stack, pr.number, terminology, m) : null;
  const canMergeSingle = singlePullRequestMergeAllowed({
    supportsStackActions: stack.supportsStackActions,
    hasStack: stack.stack !== null,
    isFresh: stack.isFresh,
  });
  const checkingStack =
    permissions.connected && stack.supportsStackActions && !stack.isFresh && !stack.error;
  const reason =
    (!permissions.connected
      ? gt("Reconnect to merge.")
      : mergeUnavailableReason(pr, permissions.canWrite, terminology, m)) ??
    (stack.stack
      ? !stack.supportsStackActions
        ? gt("This environment can display stacks but cannot merge them.")
        : !stack.isFresh
          ? gt("Refresh the stack before merging.")
          : scope?.reason
      : !canMergeSingle
        ? stack.error
          ? gt("Couldn't check stack membership. Refresh before merging.")
          : gt("Checking stack membership…")
        : null);
  const canMerge = !busy && method !== undefined && !reason;
  const label = method
    ? scope && scope.layers.length > 1
      ? gt(
          "{kind, select, squash {Squash and merge stack ({count})} merge {Create a merge commit stack ({count})} rebase {Rebase and merge stack ({count})} other {Fast-forward merge stack ({count})}}",
          { kind: mergeMethodKind(method), count: scope.layers.length },
        )
      : m(MERGE_METHODS[method].title)
    : gt("Merge unavailable");
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
          label: pullRequestActionLabel(nextAction, terminology, m),
          icon: PR_ACTION_ICONS[nextAction],
          final: nextAction === "reopen",
          action: nextAction,
        }
      : pr.state === "merged"
        ? {
            label: gt("Merged", { $context: "pull request state" }),
            icon: PullRequestGlyph.merged,
            final: true,
          }
        : pr.state === "closed"
          ? {
              label: gt("Closed", { $context: "pull request state" }),
              icon: PullRequestGlyph.closed,
              final: true,
            }
          : pr.isDraft
            ? {
                label: gt("Draft", { $context: "pull request state" }),
                icon: PullRequestGlyph.draft,
              }
            : pr.mergeability === "conflicting"
              ? { label: gt("Resolve conflicts to merge"), icon: PullRequestGlyph.conflicting }
              : pr.autoMergeEnabled
                ? {
                    label: pr.autoMergeMethod
                      ? gt(
                          "Auto-merge pending ({kind, select, squash {squash} merge {merge} rebase {rebase} fastForward {fast-forward} other {{method}}})",
                          {
                            kind: mergeMethodKind(pr.autoMergeMethod),
                            method: pr.autoMergeMethod,
                          },
                        )
                      : gt("Auto-merge pending"),
                    icon: "clock",
                  }
                : checkingStack && !busy
                  ? { label: gt("Checking stack…"), icon: PullRequestGlyph.merged }
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
    pr.headSha != null &&
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
  const confirmAction = pullRequestMergeConfirmationAction({
    bypass,
    requirementsUnmet,
    canConfirmAutoMerge,
  });
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
          ...(adminOverride
            ? { adminOverride: true, mergeMethod: method, expectedHeadSha: pr.headSha ?? undefined }
            : {}),
          ...(action === "merge" && method && stack.stack && scope
            ? {
                stackNumber: stack.stack.number,
                expectedStackHeads: scope.heads,
                mergeMethod: method,
              }
            : action === "merge" && method && !adminOverride
              ? {
                  resolveMergeMethod: (fresh) => {
                    if (
                      !canPerformPullRequestAction(fresh, "merge") ||
                      !allowedMergeMethods(fresh).includes(method)
                    )
                      throw new Error(
                        gt(
                          "The {term, select, mr {merge request} cr {change request} other {pull request}} changed. Refresh before merging.",
                          { term: changeRequestTermKind(terminology) },
                        ),
                      );
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
          gt("Couldn't complete the merge action"),
          cause instanceof Error
            ? (errorDisplayMessage(cause, resolveMessage) ?? cause.message)
            : gt("Try again."),
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
          ? gt(
              "{count, plural, one {Merge {count} stack layers?} other {Merge {count} stack layers?}}",
              { count: scope.layers.length },
            )
          : gt(
              "Merge {term, select, mr {merge request} cr {change request} other {pull request}}?",
              { term: changeRequestTermKind(terminology) },
            )
        : action === "enable-auto-merge"
          ? gt("Enable auto-merge?")
          : gt("Disable auto-merge?");
    const message =
      action === "merge" && scope
        ? gt(
            "Merge {layers} into {base} using {kind, select, squash {squash} merge {merge} rebase {rebase} fastForward {fast-forward} other {{method}}}. Layers above #{number} stay open.",
            {
              layers: scope.layers.map((layer) => `#${layer.number}`).join(" → "),
              base: stack.stack?.base ?? "",
              kind: mergeMethodKind(method),
              method: method ?? "",
              number: pr.number,
            },
          )
        : action === "enable-auto-merge"
          ? gt(
              "Merge #{number} using {kind, select, squash {squash} merge {merge} rebase {rebase} fastForward {fast-forward} other {{method}}} when its requirements are met. This may happen immediately.",
              { number: pr.number, kind: mergeMethodKind(method), method: method ?? "" },
            )
          : action === "disable-auto-merge"
            ? gt(
                "Stop the provider from automatically merging this {term, select, mr {merge request} cr {change request} other {pull request}}.",
                {
                  term: changeRequestTermKind(terminology),
                },
              )
            : gt(
                "Merge #{number} into {branch} using {kind, select, squash {squash} merge {merge} rebase {rebase} fastForward {fast-forward} other {{method}}}.",
                {
                  number: pr.number,
                  branch: pr.baseBranch,
                  kind: mergeMethodKind(method),
                  method: method ?? "",
                },
              );
    Dialog.alert(title, message, [
      { text: gt("Cancel"), style: "cancel" },
      {
        text:
          action === "merge"
            ? label
            : action === "enable-auto-merge"
              ? gt("Enable auto-merge")
              : gt("Disable auto-merge"),
        onPress: () => void perform(action),
      },
    ]);
  };
  return (
    <View className="gap-2 border-t border-border-subtle p-3">
      <SplitButton
        label={
          busy || stateAction.busy
            ? gt("Working…")
            : !permissions.connected
              ? gt("Reconnect to merge")
              : (status?.label ?? label)
        }
        accessibilityLabel={
          status
            ? status.label
            : scope
              ? gt(
                  "{count, plural, one {{label}, {count} stack layers through '#'{number}} other {{label}, {count} stack layers through '#'{number}}}",
                  {
                    label,
                    count: scope.layers.length,
                    number: pr.number,
                  },
                )
              : label
        }
        icon={status?.icon ?? PullRequestGlyph.merged}
        disabled={status?.action ? stateAction.busy : !canMerge || status !== null}
        loading={busy || stateAction.busy || (!status?.action && checkingStack)}
        onPress={() =>
          status?.action ? void stateAction.perform(status.action) : confirm("merge")
        }
        menuTitle={gt("Merge options")}
        actions={
          status?.final
            ? []
            : [
                ...methods.map((id) => ({
                  id,
                  title: m(MERGE_METHODS[id].title),
                  state: id === method ? ("on" as const) : ("off" as const),
                  attributes: { disabled: !canMerge && !canAutoMerge },
                })),
                ...(canAutoMerge
                  ? [
                      {
                        id: autoAction,
                        title: pr.autoMergeEnabled
                          ? gt("Disable auto-merge")
                          : gt("Enable auto-merge"),
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
                {method
                  ? m(MERGE_METHODS[method].title)
                  : gt(
                      "Merge {term, select, mr {merge request} cr {change request} other {pull request}}",
                      { term: changeRequestTermKind(terminology) },
                    )}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {bypass
                  ? gt("Merge #{number} into {branch} before its requirements are met.", {
                      number: pr.number,
                      branch: pr.baseBranch,
                    })
                  : requirementsUnmet
                    ? canConfirmAutoMerge || pr.autoMergeEnabled
                      ? gt(
                          "Merge requirements have not passed. Auto-merge waits for them to be met.",
                        )
                      : gt("Merge requirements have not passed.")
                    : gt(
                        "Merge #{number} into {branch} using {kind, select, squash {squash} merge {merge} rebase {rebase} fastForward {fast-forward} other {{method}}}.",
                        {
                          number: pr.number,
                          branch: pr.baseBranch,
                          kind: mergeMethodKind(method),
                          method: method ?? "",
                        },
                      )}
              </Text>
            </View>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={gt("Merge with admin permissions")}
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
                {gt("Merge with admin permissions")}
              </Text>
            </Pressable>
            <View className="flex-row flex-wrap justify-end gap-2">
              <Button label={gt("Cancel")} disabled={busy} onPress={() => setConfirmation(null)} />
              <Button
                label={
                  busy
                    ? gt("Working…")
                    : bypass
                      ? gt("Bypass rules and merge")
                      : confirmAction === "enable-auto-merge"
                        ? gt("Enable auto-merge")
                        : gt("Confirm merge")
                }
                tone={bypass ? "danger" : "primary"}
                disabled={
                  busy ||
                  (!bypass && (confirmAction === "merge" ? !canMerge : !canConfirmAutoMerge))
                }
                loading={busy}
                onPress={async () => {
                  const completed = await perform(confirmAction, bypass);
                  if (completed) setConfirmation(null);
                }}
              />
            </View>
          </View>
        </View>
      </Modal>
      {stack.error && stack.supportsStackActions ? (
        <Button label={gt("Retry stack lookup")} tone="text" onPress={stack.refresh} />
      ) : null}
    </View>
  );
}
