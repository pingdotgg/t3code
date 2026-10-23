import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestFilterOptionKind,
  type PullRequestFilterOptionsInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useRef, useState } from "react";
import { FlatList, Platform, View, type TextInputInstance } from "react-native";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { EmptyState } from "../../components/ui/EmptyState";
import { SearchField } from "../../components/ui/SearchField";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { Toolbar } from "../../components/ui/Toolbar";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { composerPullRequests } from "../../state/pull-requests";
import { useDebouncedValue } from "../../state/queries";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
} from "../layout/native-mail-search-toolbar";
import { pullRequestFilterChoices, pullRequestLabelColors } from "./pullRequestList";
import { usePullRequestListControls } from "./usePullRequestListControls";

export type PullRequestFilterSearchParams = {
  readonly kind: PullRequestFilterOptionKind;
  /** The list controls' own key: the environment the list is narrowed to, or every one. */
  readonly environmentId: string | null;
  /** The environments the list reads, which the host search covers as well. */
  readonly environmentIds: readonly string[];
  /** What the loaded rows already carry, offered before the host has answered. */
  readonly suggestions: readonly string[];
  /** Dot colors by lowercased label name, from the loaded rows. */
  readonly labelColors?: Readonly<Record<string, string>>;
};

const optionsFamily = Atom.family((key: string) => {
  const targets: readonly {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestFilterOptionsInput;
  }[] = JSON.parse(key);
  return Atom.make((get) => {
    const results = targets.map((target) => get(composerPullRequests.filterOptions(target)));
    return {
      values: results.flatMap((result) => Option.toArray(AsyncResult.value(result))),
      waiting: results.some((result) => result.waiting),
      failed: results.some(AsyncResult.isFailure),
    };
  });
});

export function PullRequestFilterSearchScreen({
  route,
}: StaticScreenProps<PullRequestFilterSearchParams>) {
  const navigation = useNavigation();
  const { kind, environmentId, environmentIds, suggestions, labelColors } = route.params;
  const listControls = usePullRequestListControls();
  const controls = listControls.controlsFor(environmentId);
  const integratedSearch = useNativeMailSearchToolbar();
  const searchRef = useRef<TextInputInstance>(null);
  const [query, setQuery] = useState("");
  const typed = query.trim().slice(0, 100);
  const sent = useDebouncedValue(typed, 250);
  // Until the search catches up with the typing, the host's answers are for older text.
  const settled = sent === typed;
  const key = JSON.stringify(
    environmentIds.map((id) => ({
      environmentId: EnvironmentId.make(id),
      input: {
        kind,
        ...(controls.projectId ? { projectId: ProjectId.make(controls.projectId) } : {}),
        ...(sent ? { query: sent } : {}),
      },
    })),
  );
  const hosted = useAtomValue(optionsFamily(key));
  const selectedLabels = controls.filters.labels?.flat() ?? [];
  const author = controls.filters.author;
  const selected = kind === "labels" ? selectedLabels : author ? [author] : [];
  const rows = pullRequestFilterChoices({
    selected,
    suggestions,
    hosted: (settled ? hosted.values : []).flatMap((options) =>
      kind === "labels"
        ? options.labels.map((label) => label.name)
        : options.authors.map((candidate) => candidate.login),
    ),
    query,
  });
  const colors = {
    ...pullRequestLabelColors(hosted.values.flatMap((options) => options.labels)),
    ...labelColors,
  };
  const isSelected = (value: string) =>
    selected.some((held) => held.toLowerCase() === value.toLowerCase());
  const choose = (value: string) => {
    if (kind === "authors") {
      listControls.setControls(environmentId, {
        ...controls,
        filters: { ...controls.filters, author: isSelected(value) ? undefined : value },
      });
      navigation.goBack();
      return;
    }
    const labels = isSelected(value)
      ? selectedLabels.filter((label) => label.toLowerCase() !== value.toLowerCase())
      : [...selectedLabels, value].slice(0, 10);
    listControls.setControls(environmentId, {
      ...controls,
      filters: {
        ...controls.filters,
        labels: labels.length ? labels.map((label) => [label]) : undefined,
      },
    });
  };
  const placeholder = kind === "labels" ? "Search labels" : "Search authors";
  const list = (
    <FlatList
      data={rows}
      keyExtractor={(value) => value.toLowerCase()}
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: integratedSearch ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET + 16 : 16,
      }}
      renderItem={({ item, index }) => (
        <SelectionRow
          title={item}
          role={kind === "labels" ? "checkbox" : "radio"}
          selected={isSelected(item)}
          isFirst={index === 0}
          isLast={index === rows.length - 1}
          leading={
            kind === "labels" ? (
              // Uncolored labels keep the dot's room so every name starts at the same edge.
              <View
                className="size-2.5 rounded-full"
                style={{ backgroundColor: colors[item.toLowerCase()] ?? "transparent" }}
              />
            ) : undefined
          }
          onPress={() => choose(item)}
        />
      )}
      ListEmptyComponent={
        hosted.waiting || !settled ? (
          <AppActivityIndicator className="my-8" />
        ) : (
          <EmptyState
            title={
              hosted.failed
                ? "Couldn't search the host"
                : kind === "labels"
                  ? "No matching labels"
                  : "No matching authors"
            }
            detail={
              hosted.failed
                ? "The host didn't answer. Try again in a moment."
                : kind === "labels"
                  ? "Search the labels of the repositories this list covers."
                  : "Search people by name or handle on the repositories' hosts."
            }
            variant="plain"
          />
        )
      }
    />
  );
  const title = kind === "labels" ? "Filter by label" : "Filter by author";
  if (Platform.OS === "android") {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <AndroidScreenHeader title={title} hideBottomBorder onBack={() => navigation.goBack()} />
        <View className="bg-header px-4 pb-3 pt-1">
          <SearchField
            inputRef={searchRef}
            accessibilityLabel={placeholder}
            clearAccessibilityLabel={
              kind === "labels" ? "Clear label search" : "Clear author search"
            }
            onChangeText={setQuery}
            placeholder={placeholder}
            value={query}
          />
        </View>
        {list}
      </View>
    );
  }
  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader
        title={title}
        onClose={() => navigation.goBack()}
        accessibilityLabel={kind === "labels" ? "Close label filter" : "Close author filter"}
      />
      <NativeStackScreenOptions
        options={{
          unstable_headerToolbarItems: integratedSearch
            ? () => [
                createNativeMailSearchToolbarItem({
                  placeholder,
                  onSearchTextChange: setQuery,
                  showsSearchDismissButton: true,
                  searchTextChangeId: "pr-filter-option-search",
                }),
              ]
            : undefined,
          headerSearchBarOptions: integratedSearch
            ? undefined
            : {
                placeholder,
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                obscureBackground: false,
                onChangeText: (event) => setQuery(event.nativeEvent.text),
                onCancelButtonPress: () => setQuery(""),
              },
        }}
      />
      {integratedSearch ? null : (
        <Toolbar placement="bottom">
          <Toolbar.SearchBarSlot />
        </Toolbar>
      )}
      {list}
    </View>
  );
}
