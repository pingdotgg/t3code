import { AppBar, type AppBarSearch } from "../../components/ui/AppBar";
import { AsyncResult } from "effect/reactivity";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  hostReviewerQuery,
  reviewerCandidateView,
  type ReviewerTruncation,
} from "@t3tools/client-runtime/pull-request-reviewers";
import type { PullRequestReviewerCandidate } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, View } from "react-native";
import { renderNativeScrollView } from "../../native/NativeScrollViewMarker";
import { useContentTopInset, useSearchToolbarInset } from "../../components/ui/useBarInset";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { SymbolView } from "../../components/ui/AppSymbol";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

const TRUNCATED_LABELS: Record<ReviewerTruncation, (error: string | null) => string> = {
  unsearchable: () =>
    "The provider has more reviewers than it returned. Find additional reviewers on the provider.",
  searchable: () => "The provider has more reviewers than are listed here. Search to find them.",
  "search-failed": (error) =>
    `Only listed reviewers are matched: the provider search failed. ${error ?? ""}`,
  "search-truncated": () =>
    "More reviewers match than the provider returned. Keep typing to narrow it down.",
};

export function PullRequestReviewersScreen({ route }: StaticScreenProps<PullRequestParams>) {
  const navigation = useNavigation();
  const contentTopInset = useContentTopInset();
  const listRef = useRef<FlatList<PullRequestReviewerCandidate>>(null);
  const target = pullRequestTarget(route.params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const pr = detail.data;
  const { singular } = sourceControlClients.get(
    (pr ?? route.params.initialSummary)?.provider,
  ).changeRequest;
  const canWrite = useAtomValue(
    composerPullRequests.requestReviewers.permissionAtom(target.environmentId),
  );
  const connected = usePullRequestConnected(route.params.environmentId);
  const allowed =
    connected &&
    canWrite &&
    pr?.state === "open" &&
    pr.capabilities.reviewers.request &&
    pr.viewerPermissions.requestReviewers;
  const result = useEnvironmentQuery(
    pr?.capabilities.reviewers.listCandidates
      ? composerPullRequests.reviewerCandidates(target)
      : null,
  );
  const request = useAtomCommand(composerPullRequests.requestReviewers, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const searchInput = {
    loaded: result.data,
    searchable: pr?.capabilities.reviewers.searchCandidates === true,
    query,
    debouncedQuery,
  };
  const hostQuery = hostReviewerQuery(searchInput);
  const searchResult = useEnvironmentQuery(
    hostQuery !== null
      ? composerPullRequests.reviewerSearch({
          ...target,
          input: { ...target.input, query: hostQuery },
        })
      : null,
  );
  const view = reviewerCandidateView({
    ...searchInput,
    search: searchResult,
  });
  const candidates = [...view.candidates].sort(
    (a, b) => Number(b.isRequested) - Number(a.isRequested) || a.login.localeCompare(b.login),
  );
  const queryError = result.error ?? view.searchError;
  // A new search shows its best matches from the top.
  const search = (next: string) => {
    setQuery(next);
    listRef.current?.scrollToOffset({
      offset: -contentTopInset,
      animated: false,
    });
  };
  const update = async (
    candidate: Pick<PullRequestReviewerCandidate, "id" | "kind" | "isRequested">,
  ) => {
    if (!allowed || inFlight.current) return;
    inFlight.current = true;
    setPending(`${candidate.kind}:${candidate.id}`);
    setError(null);
    const response = await request({
      ...target,
      input: {
        ...target.input,
        reviewers: [{ id: candidate.id, kind: candidate.kind }],
        requested: !candidate.isRequested,
      },
    });
    inFlight.current = false;
    setPending(null);
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      setError(
        cause instanceof Error ? cause.message : "Couldn't update this review request. Try again.",
      );
      return;
    }
    if (hostQuery !== null) searchResult.refresh();
    if (!pr?.capabilities.reviewers.listCandidates) {
      search("");
      detail.refresh();
    }
  };
  const listCandidates = pr?.capabilities.reviewers.listCandidates === true;
  const reviewerSearch: AppBarSearch | undefined = listCandidates
    ? {
        mode: "inline",
        compactToolbar: true,
        value: query,
        onChangeText: search,
        placeholder: "Search reviewers",
      }
    : undefined;
  const searchToolbarInset = useSearchToolbarInset(reviewerSearch);
  return (
    <View className="flex-1 bg-sheet">
      <AppBar
        title="Request review"
        subtitle={`#${route.params.number} · ${route.params.repository}`}
        onClose={() => navigation.goBack()}
        closeAccessibilityLabel="Close request review"
        search={reviewerSearch}
      />
      {listCandidates ? (
        <FlatList
          ref={listRef}
          data={candidates}
          keyExtractor={(candidate) => `${candidate.kind}:${candidate.id}`}
          renderScrollComponent={renderNativeScrollView}
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 24 + searchToolbarInset }}
          ListHeaderComponent={
            <View className="gap-3 px-4 py-4">
              <Text className="text-xs text-foreground-muted">
                Tap someone to request a review. Tap a requested reviewer to remove the request.
              </Text>
              {!allowed ? (
                <Text className="text-xs text-foreground-muted">
                  Requesting reviews requires write access and an open {singular}.
                </Text>
              ) : null}
              {error ? (
                <Text selectable className="text-sm text-danger-foreground">
                  {error}
                </Text>
              ) : null}
            </View>
          }
          renderItem={({ item }) => {
            const id = `${item.kind}:${item.id}`;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.isRequested ? "Remove review request from" : "Request review from"} ${item.login}${item.kind === "team" ? " team" : ""}`}
                accessibilityState={{ disabled: !allowed || pending !== null }}
                disabled={!allowed || pending !== null}
                onPress={() => void update(item)}
                className="min-h-16 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
              >
                <PullRequestAvatar actor={item} size={32} />
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-sm font-t3-medium" numberOfLines={1}>
                    {item.name || item.login}
                  </Text>
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {item.login}
                    {item.kind === "team" ? " · Team" : ""}
                  </Text>
                </View>
                {pending === id ? (
                  <AppActivityIndicator />
                ) : item.isRequested ? (
                  <View className="flex-row items-center gap-1.5">
                    <Text className="text-xs text-foreground-muted">Requested</Text>
                    <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon" />
                  </View>
                ) : (
                  <SymbolView name="plus" size={16} tintColorClassName="accent-icon-muted" />
                )}
              </Pressable>
            );
          }}
          ListEmptyComponent={
            (result.isPending && !result.data) || view.searchPending ? (
              <AppActivityIndicator className="my-8" />
            ) : (
              <View className="px-4 py-6">
                <EmptyState
                  title={
                    queryError
                      ? "Couldn't load reviewers"
                      : query.trim()
                        ? "No matching reviewers"
                        : "No reviewers available"
                  }
                  detail={queryError ?? "Search people and teams with access to this repository."}
                  variant="plain"
                />
                {queryError ? (
                  <Button
                    label="Retry"
                    onPress={result.error ? result.refresh : searchResult.refresh}
                  />
                ) : null}
              </View>
            )
          }
          ListFooterComponent={
            view.truncation ? (
              <Text className="px-4 py-4 text-xs text-foreground-muted">
                {TRUNCATED_LABELS[view.truncation](view.searchError)}
              </Text>
            ) : undefined
          }
        />
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, gap: 16 }}
        >
          {!pr ? (
            detail.isPending ? (
              <AppActivityIndicator />
            ) : (
              <Text className="text-danger-foreground">
                {detail.error ?? `Couldn't load this ${singular}.`}
              </Text>
            )
          ) : (
            <>
              <Text className="text-sm text-foreground-muted">
                This provider accepts a reviewer ID but cannot list candidates.
              </Text>
              <TextInput
                accessibilityLabel="Reviewer ID"
                placeholder="Reviewer login or ID"
                placeholderTextColorClassName="accent-foreground-muted"
                value={query}
                onChangeText={search}
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-12 rounded-xl bg-grouped-card px-3 text-base"
              />
              <Button
                label="Request review"
                fullWidth
                disabled={!allowed || !query.trim() || pending !== null}
                onPress={() => void update({ id: query.trim(), kind: "user", isRequested: false })}
              />
              <Button
                label="Remove review request"
                fullWidth
                tone="text"
                disabled={!allowed || !query.trim() || pending !== null}
                onPress={() => void update({ id: query.trim(), kind: "user", isRequested: true })}
              />
              {error ? (
                <Text selectable className="text-danger-foreground">
                  {error}
                </Text>
              ) : null}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}
