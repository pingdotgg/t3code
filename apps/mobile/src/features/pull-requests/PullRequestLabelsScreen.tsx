import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  emptySelection,
  isSelected,
  changeBatches,
  selectionChanges,
  toggleSelection,
} from "@t3tools/client-runtime/pull-request-selection";
import type { PullRequestLabelCandidate } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { T, useGT } from "gt-react-native";
import { useEffect, useState } from "react";
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
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { m } from "../../i18n/messages";

export function PullRequestLabelsScreen({ route }: StaticScreenProps<PullRequestParams>) {
  const navigation = useNavigation();
  const gt = useGT();
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
        ? gt("Reconnect to change labels.")
        : !canWrite
          ? gt("This device isn't allowed to change source control on this environment.")
          : pr.capabilities.labels !== true
            ? gt("This provider doesn't support changing labels.")
            : gt("Changing labels needs triage access on this repository.");
  const result = useEnvironmentQuery(composerPullRequests.labelCandidates(target));
  const setLabels = useAtomCommand(composerPullRequests.setLabels, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(emptySelection<PullRequestLabelCandidate>);
  const needle = query.trim().toLowerCase();
  // Host order, not applied-first: re-sorting on toggle would move the row out from under a tap.
  const candidates = (result.data?.candidates ?? []).filter((candidate) =>
    `${candidate.name} ${candidate.description ?? ""}`.toLowerCase().includes(needle),
  );
  const latest = result.data?.candidates;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- picks are sent when the sheet leaves the navigation stack, however it is dismissed
  useEffect(
    () =>
      navigation.addListener("beforeRemove", () => {
        const { add, remove } = selectionChanges(
          draft,
          (name, label) =>
            latest?.find((entry) => entry.name === name)?.isApplied ?? label.isApplied,
        );
        const sendBatch = async (
          labels: ReadonlyArray<PullRequestLabelCandidate>,
          applied: boolean,
        ) => {
          const names = labels.map((label) => label.name);
          const response = await setLabels({
            ...target,
            input: { ...target.input, labels: names, applied },
          });
          if (!AsyncResult.isFailure(response)) return;
          const cause = squashAtomCommandFailure(response);
          Dialog.alert(
            applied
              ? gt("Couldn't add {labels}", { labels: names.join(", ") })
              : gt("Couldn't remove {labels}", { labels: names.join(", ") }),
            cause instanceof Error
              ? (errorDisplayMessage(cause, m) ?? cause.message)
              : gt("The provider refused the change."),
          );
        };
        const send = async (labels: ReadonlyArray<PullRequestLabelCandidate>, applied: boolean) => {
          for (const batch of changeBatches(labels)) await sendBatch(batch, applied);
        };
        // Adding first keeps the Labels row from showing empty between the two writes.
        void send(add, true).then(() => send(remove, false));
      }),
    [navigation, draft, latest, setLabels, target, gt],
  );
  return (
    <PullRequestSearchSheet
      title={gt("Labels", { $context: "pull request labels sheet title" })}
      placeholder={gt("Search labels")}
      closeAccessibilityLabel={gt("Close labels")}
      clearAccessibilityLabel={gt("Clear label search")}
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
              // Sent when the sheet closes; a failure puts the host's answer back.
              selected={isSelected(draft, item.name, item.isApplied)}
              disabled={!allowed}
              isFirst={index === 0}
              isLast={index === candidates.length - 1}
              leading={<PullRequestLabelDot color={pullRequestLabelColor(item.color)} />}
              onPress={() =>
                setDraft((current) => toggleSelection(current, item.name, item, item.isApplied))
              }
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
                      ? gt("Couldn't load labels")
                      : needle
                        ? gt("No matching labels")
                        : gt("This repository has no labels")
                  }
                  detail={
                    result.error ??
                    (needle
                      ? gt("Try another name.")
                      : gt("Create labels on the provider to use them here."))
                  }
                  variant="plain"
                />
                {result.error ? <Button label={gt("Retry")} onPress={result.refresh} /> : null}
              </View>
            )
          }
          ListFooterComponent={
            result.data?.truncated ? (
              <Text className="py-4 text-xs text-foreground-muted">
                <T>
                  This repository has more labels than are listed here. Apply the rest on the
                  provider.
                </T>
              </Text>
            ) : undefined
          }
        />
      )}
    </PullRequestSearchSheet>
  );
}
