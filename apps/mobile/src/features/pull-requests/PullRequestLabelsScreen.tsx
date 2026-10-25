import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestLabelCandidate } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { FlatList, Platform, View } from "react-native";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
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
  const [pending, setPending] = useState<{ readonly name: string; readonly applied: boolean }>();
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const needle = query.trim().toLowerCase();
  // Host order, not applied-first: re-sorting on toggle would move the row out from under a tap.
  const candidates = (result.data?.candidates ?? []).filter((candidate) =>
    `${candidate.name} ${candidate.description ?? ""}`.toLowerCase().includes(needle),
  );
  const toggle = async (candidate: PullRequestLabelCandidate) => {
    if (!allowed || inFlight.current) return;
    inFlight.current = true;
    setPending({ name: candidate.name, applied: !candidate.isApplied });
    setError(null);
    const response = await setLabels({
      ...target,
      input: { ...target.input, labels: [candidate.name], applied: !candidate.isApplied },
    });
    inFlight.current = false;
    setPending(undefined);
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      setError(cause instanceof Error ? cause.message : "Couldn't update this label. Try again.");
    }
  };
  return (
    <PullRequestSearchSheet
      title="Labels"
      placeholder="Search labels"
      closeAccessibilityLabel="Close labels"
      clearAccessibilityLabel="Clear label search"
      searchTextChangeId="pr-label-search"
      query={query}
      onQueryChange={setQuery}
    >
      {({ paddingBottom }) => (
        <FlatList
          data={candidates}
          keyExtractor={(candidate) => candidate.name}
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom }}
          ListHeaderComponent={
            readOnlyReason || error ? (
              <View className="gap-2 pb-3">
                {readOnlyReason ? (
                  <Text className="text-xs text-foreground-muted">{readOnlyReason}</Text>
                ) : null}
                {error ? (
                  <Text selectable className="text-sm text-danger-foreground">
                    {error}
                  </Text>
                ) : null}
              </View>
            ) : undefined
          }
          renderItem={({ item, index }) => (
            <SelectionRow
              title={item.name}
              {...(item.description ? { subtitle: item.description } : {})}
              role="checkbox"
              // The change shows as soon as it is tapped; a failure puts the host's answer back.
              selected={pending?.name === item.name ? pending.applied : item.isApplied}
              disabled={!allowed}
              isFirst={index === 0}
              isLast={index === candidates.length - 1}
              leading={<PullRequestLabelDot color={pullRequestLabelColor(item.color)} />}
              onPress={() => void toggle(item)}
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
