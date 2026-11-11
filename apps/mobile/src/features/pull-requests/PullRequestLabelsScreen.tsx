import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  PULL_REQUEST_LABEL_CHANGE_LIMIT,
  type PullRequestLabelCandidate,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Platform, View } from "react-native";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestLabelDot } from "./PullRequestLabelDot";
import { pullRequestLabelColor } from "./pullRequestList";
import { PullRequestSearchSheet } from "./PullRequestSearchSheet";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { useSelectionDraft } from "./useSelectionDraft";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

export function PullRequestLabelsScreen({ route }: StaticScreenProps<PullRequestParams>) {
  const target = pullRequestTarget(route.params);
  const pr = useEnvironmentQuery(composerPullRequests.detail(target)).data;
  const canWrite = useAtomValue(
    composerPullRequests.setLabels.permissionAtom(target.environmentId),
  );
  const connected = usePullRequestConnected(route.params.environmentId);
  const allowed =
    connected &&
    canWrite &&
    pr?.capabilities.labels === true &&
    pr.viewerPermissions.labels !== false;
  // Name the first thing in the way, so the notice says what would actually fix it.
  const readOnlyReason =
    !pr || allowed
      ? null
      : !connected
        ? "Reconnect to change labels."
        : !canWrite
          ? "This device isn't allowed to change source control on this environment."
          : pr.capabilities.labels !== true
            ? "This provider doesn't support changing labels."
            : "Changing labels needs triage access on this repository.";
  const result = useEnvironmentQuery(composerPullRequests.labelCandidates(target));
  const setLabels = useAtomCommand(composerPullRequests.setLabels, { reportFailure: false });
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const send = async (
    labels: ReadonlyArray<PullRequestLabelCandidate>,
    applied: boolean,
    // Removals that wait on this add and are dropped when it fails.
    skipped: ReadonlyArray<PullRequestLabelCandidate> = [],
  ) => {
    if (labels.length === 0) return true;
    const names = labels.map((label) => label.name);
    for (let start = 0; start < names.length; start += PULL_REQUEST_LABEL_CHANGE_LIMIT) {
      const response = await setLabels({
        ...target,
        input: {
          ...target.input,
          labels: names.slice(start, start + PULL_REQUEST_LABEL_CHANGE_LIMIT),
          applied,
        },
      });
      if (!AsyncResult.isFailure(response)) continue;
      const cause = squashAtomCommandFailure(response);
      Dialog.alert(
        `Couldn't ${applied ? "add" : "remove"} ${names.slice(start).join(", ")}${skipped.length > 0 ? ` or remove ${skipped.map((label) => label.name).join(", ")}` : ""}`,
        cause instanceof Error ? cause.message : "The provider refused the change. Try again.",
      );
      return false;
    }
    return true;
  };
  const draft = useSelectionDraft({
    allowed,
    candidates: result.data?.candidates ?? [],
    candidateKey: (candidate) => candidate.name,
    isSelected: (candidate) => candidate.isApplied,
    single: false,
    commit: async ({ add, remove }) => {
      // Adds first, so the row never shows empty between the two writes, or after a failed add.
      if (await send(add, true, remove)) await send(remove, false);
    },
  });
  // Host order, not applied-first: re-sorting on toggle would move the row out from under a tap.
  const candidates = (result.data?.candidates ?? []).filter((candidate) =>
    `${candidate.name} ${candidate.description ?? ""}`.toLowerCase().includes(needle),
  );
  return (
    <PullRequestSearchSheet
      title="Labels"
      placeholder="Search labels"
      closeAccessibilityLabel="Close labels"
      clearAccessibilityLabel="Clear label search"
      query={query}
      onQueryChange={setQuery}
    >
      {({ paddingBottom }) => (
        <LegendList
          renderScrollComponent={NativeScrollView}
          data={candidates}
          keyExtractor={(candidate) => candidate.name}
          extraData={{ draft, allowed, count: candidates.length }}
          estimatedItemSize={72}
          recycleItems
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom }}
          ListHeaderComponent={
            readOnlyReason ? (
              <View className="pb-3">
                <Text className="text-xs text-foreground-muted">{readOnlyReason}</Text>
              </View>
            ) : undefined
          }
          renderItem={({ item, index }) => (
            <SelectionRow
              title={item.name}
              {...(item.description ? { subtitle: item.description } : {})}
              role="checkbox"
              selected={draft.isSelected(item)}
              disabled={!allowed}
              isFirst={index === 0}
              isLast={index === candidates.length - 1}
              leading={<PullRequestLabelDot color={pullRequestLabelColor(item.color)} />}
              onPress={() => draft.toggle(item)}
            />
          )}
          ListEmptyComponent={
            result.isPending && !result.data ? (
              <AppActivityIndicator className="my-8" />
            ) : (
              <View>
                <EmptyState
                  title={
                    result.error
                      ? "Couldn't load labels"
                      : needle
                        ? "No matching labels"
                        : "This repository has no labels"
                  }
                  detail={
                    result.error ??
                    (needle
                      ? "Try another name."
                      : "Create labels on the provider to use them here.")
                  }
                  variant="plain"
                />
                {result.error ? <Button label="Retry" onPress={result.refresh} /> : null}
              </View>
            )
          }
          ListFooterComponent={
            result.data?.truncated ? (
              <Text className="py-4 text-xs text-foreground-muted">
                This repository has more labels than are listed here. Apply the rest on the
                provider.
              </Text>
            ) : undefined
          }
        />
      )}
    </PullRequestSearchSheet>
  );
}
