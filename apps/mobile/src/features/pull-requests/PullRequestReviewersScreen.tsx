import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { AppBar, type AppBarSearch } from "../../components/ui/AppBar";
import { AsyncResult } from "effect/reactivity";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { changeRequestTermKind } from "../../lib/changeRequestTerm";
import {
  hostReviewerQuery,
  reviewerCandidateView,
  type ReviewerTruncation,
} from "@t3tools/client-runtime/pull-request-reviewers";
import {
  emptySelection,
  isSelected,
  changeBatches,
  selectionChanges,
  toggleOnlySelection,
  toggleSelection,
} from "@t3tools/client-runtime/pull-request-selection";
import type { PullRequestReviewerCandidate } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useContentTopInset, useSearchToolbarInset } from "../../components/ui/useBarInset";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { SymbolView } from "../../components/ui/AppSymbol";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import type { MessageResolver } from "../../i18n/messages";
import { m as resolveMessage } from "../../i18n/messages";

const TRUNCATED_LABELS: Record<
  ReviewerTruncation,
  (error: string | null, resolve: MessageResolver) => string
> = {
  unsearchable: (_error, resolve) =>
    resolve(
      msg(
        "The provider has more reviewers than it returned. Find additional reviewers on the provider.",
      ),
    ),
  searchable: (_error, resolve) =>
    resolve(msg("The provider has more reviewers than are listed here. Search to find them.")),
  "search-failed": (error, resolve) =>
    resolve(
      msg("Only listed reviewers are matched: the provider search failed. {error}", {
        error: error ?? "",
      }),
    ),
  "search-truncated": (_error, resolve) =>
    resolve(msg("More reviewers match than the provider returned. Keep typing to narrow it down.")),
};

export function PullRequestReviewersScreen({ route }: StaticScreenProps<PullRequestParams>) {
  const navigation = useNavigation();
  const gt = useGT();
  const m = useMessages();
  const contentTopInset = useContentTopInset();
  const listRef = useRef<LegendListRef>(null);
  const target = pullRequestTarget(route.params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const pr = detail.data;
  const term = changeRequestTermKind(
    sourceControlClients.get((pr ?? route.params.initialSummary)?.provider).changeRequest,
  );
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
  const [draft, setDraft] = useState(emptySelection<PullRequestReviewerCandidate>);
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
  // Hosts that cannot list candidates take one typed id at a time.
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
        cause instanceof Error
          ? (errorDisplayMessage(cause, resolveMessage) ?? cause.message)
          : gt("Couldn't update this review request. Try again."),
      );
      return;
    }
    search("");
    detail.refresh();
  };
  const listCandidates = pr?.capabilities.reviewers.listCandidates === true;
  // Loaded rows first: they carry the request state mutations update.
  const latest = [...(result.data?.candidates ?? []), ...(searchResult.data?.candidates ?? [])];
  const single = result.data?.multiple === false;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- picks are sent when the sheet leaves the navigation stack, however it is dismissed
  useEffect(
    () =>
      navigation.addListener("beforeRemove", () => {
        const { add, remove } = selectionChanges(
          draft,
          (key, person) =>
            latest.find((entry) => `${entry.kind}:${entry.id}` === key)?.isRequested ??
            person.isRequested,
        );
        const sendBatch = async (
          people: ReadonlyArray<PullRequestReviewerCandidate>,
          requested: boolean,
        ) => {
          const response = await request({
            ...target,
            input: {
              ...target.input,
              reviewers: people.map(({ id, kind }) => ({ id, kind })),
              requested,
            },
          });
          if (!AsyncResult.isFailure(response)) return;
          const cause = squashAtomCommandFailure(response);
          const logins = people.map((person) => person.login).join(", ");
          Dialog.alert(
            requested
              ? gt("Couldn't request a review from {logins}", { logins })
              : gt("Couldn't remove the review request from {logins}", { logins }),
            cause instanceof Error
              ? (errorDisplayMessage(cause, resolveMessage) ?? cause.message)
              : gt("The provider refused the change."),
          );
        };
        const send = async (
          people: ReadonlyArray<PullRequestReviewerCandidate>,
          requested: boolean,
        ) => {
          for (const batch of changeBatches(people)) await sendBatch(batch, requested);
        };
        // A search result is keyed by what was typed, so the writes do not reach it on their own.
        const refreshSearch =
          hostQuery !== null && add.length + remove.length > 0 ? searchResult.refresh : null;
        // Removing first lets a host that keeps one reviewer take the new one.
        void send(remove, false)
          .then(() => send(add, true))
          .then(() => refreshSearch?.());
      }),
    [navigation, draft, latest, request, target, hostQuery, searchResult.refresh, gt],
  );
  const reviewerSearch: AppBarSearch | undefined = listCandidates
    ? {
        mode: "inline",
        compactToolbar: true,
        value: query,
        onChangeText: search,
        placeholder: gt("Search reviewers"),
      }
    : undefined;
  const searchToolbarInset = useSearchToolbarInset(reviewerSearch);
  return (
    <View className="flex-1 bg-sheet">
      <AppBar
        title={gt("Request review")}
        subtitle={`#${route.params.number} · ${route.params.repository}`}
        onClose={() => navigation.goBack()}
        closeAccessibilityLabel={gt("Close request review")}
        search={reviewerSearch}
      />
      {listCandidates ? (
        <LegendList
          ref={listRef}
          data={candidates}
          keyExtractor={(candidate) => `${candidate.kind}:${candidate.id}`}
          extraData={{ allowed, draft, single }}
          estimatedItemSize={64}
          recycleItems
          renderScrollComponent={NativeScrollView}
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 24 + searchToolbarInset }}
          ListHeaderComponent={
            <View className="gap-3 px-4 py-4">
              <Text className="text-xs text-foreground-muted">
                <T>
                  Tap someone to request a review. Tap a requested reviewer to remove the request.
                  Changes are sent when you close this sheet.
                </T>
              </Text>
              {!allowed ? (
                <Text className="text-xs text-foreground-muted">
                  {gt(
                    "Requesting reviews requires write access and an open {term, select, mr {merge request} cr {change request} other {pull request}}.",
                    { term },
                  )}
                </Text>
              ) : null}
            </View>
          }
          renderItem={({ item }) => {
            const id = `${item.kind}:${item.id}`;
            const requested = isSelected(draft, id, item.isRequested);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  item.kind === "team"
                    ? requested
                      ? gt("Remove review request from {login} team", { login: item.login })
                      : gt("Request review from {login} team", { login: item.login })
                    : requested
                      ? gt("Remove review request from {login}", { login: item.login })
                      : gt("Request review from {login}", { login: item.login })
                }
                accessibilityState={{ disabled: !allowed }}
                disabled={!allowed}
                onPress={() =>
                  setDraft((current) =>
                    single
                      ? toggleOnlySelection(
                          current,
                          id,
                          item,
                          item.isRequested,
                          latest.map((entry) => ({
                            key: `${entry.kind}:${entry.id}`,
                            item: entry,
                            hostSelected: entry.isRequested,
                          })),
                        )
                      : toggleSelection(current, id, item, item.isRequested),
                  )
                }
                className="min-h-16 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
              >
                <PullRequestAvatar actor={item} size={32} />
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-sm font-t3-medium" numberOfLines={1}>
                    {item.name || item.login}
                  </Text>
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {item.login}
                    {item.kind === "team" ? ` · ${gt("Team", { $context: "reviewer kind" })}` : ""}
                  </Text>
                </View>
                {requested ? (
                  <View className="flex-row items-center gap-1.5">
                    <Text className="text-xs text-foreground-muted">
                      <T context="reviewer state">Requested</T>
                    </Text>
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
                      ? gt("Couldn't load reviewers")
                      : query.trim()
                        ? gt("No matching reviewers")
                        : gt("No reviewers available")
                  }
                  detail={
                    queryError ?? gt("Search people and teams with access to this repository.")
                  }
                  variant="plain"
                />
                {queryError ? (
                  <Button
                    label={gt("Retry")}
                    onPress={result.error ? result.refresh : searchResult.refresh}
                  />
                ) : null}
              </View>
            )
          }
          ListFooterComponent={
            view.truncation ? (
              <Text className="px-4 py-4 text-xs text-foreground-muted">
                {TRUNCATED_LABELS[view.truncation](view.searchError, m)}
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
                {detail.error ??
                  gt(
                    "Couldn't load this {term, select, mr {merge request} cr {change request} other {pull request}}.",
                    { term },
                  )}
              </Text>
            )
          ) : (
            <>
              <Text className="text-sm text-foreground-muted">
                <T>This provider accepts a reviewer ID but cannot list candidates.</T>
              </Text>
              <TextInput
                accessibilityLabel={gt("Reviewer ID")}
                placeholder={gt("Reviewer login or ID")}
                placeholderTextColorClassName="accent-foreground-muted"
                value={query}
                onChangeText={search}
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-12 rounded-xl bg-grouped-card px-3 text-base"
              />
              <Button
                label={gt("Request review")}
                fullWidth
                disabled={!allowed || !query.trim() || pending !== null}
                onPress={() => void update({ id: query.trim(), kind: "user", isRequested: false })}
              />
              <Button
                label={gt("Remove review request")}
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
