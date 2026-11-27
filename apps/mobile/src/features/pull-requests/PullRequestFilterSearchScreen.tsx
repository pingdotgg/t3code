import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { LegendList } from "@legendapp/list/react-native";
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
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Platform } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { EmptyState } from "../../components/ui/EmptyState";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { composerPullRequests } from "../../state/pull-requests";
import { useDebouncedValue } from "../../state/queries";
import { pullRequestFilterChoices, pullRequestLabelColors } from "./pullRequestList";
import { PullRequestLabelDot } from "./PullRequestLabelDot";
import { PullRequestSearchSheet } from "./PullRequestSearchSheet";
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
  const gt = useGT();
  const { kind, environmentId, environmentIds, suggestions, labelColors } = route.params;
  const listControls = usePullRequestListControls();
  const controls = listControls.controlsFor(environmentId);
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
  const hostedColors = pullRequestLabelColors(hosted.values.flatMap((options) => options.labels));
  // A label picked from an earlier search keeps its dot once the host answers a new query without it.
  const [seenColors, setSeenColors] = useState(hostedColors);
  if (Object.entries(hostedColors).some(([name, color]) => seenColors[name] !== color)) {
    setSeenColors((previous) => ({ ...previous, ...hostedColors }));
  }
  const colors = { ...seenColors, ...labelColors };
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
  const placeholder = kind === "labels" ? gt("Search labels") : gt("Search authors");
  return (
    <PullRequestSearchSheet
      title={kind === "labels" ? gt("Filter by label") : gt("Filter by author")}
      placeholder={placeholder}
      closeAccessibilityLabel={
        kind === "labels" ? gt("Close label filter") : gt("Close author filter")
      }
      clearAccessibilityLabel={
        kind === "labels" ? gt("Clear label search") : gt("Clear author search")
      }
      query={query}
      onQueryChange={setQuery}
    >
      {({ paddingBottom }) => (
        <LegendList
          renderScrollComponent={NativeScrollView}
          data={rows}
          keyExtractor={(value) => value.toLowerCase()}
          extraData={{ selected, colors, count: rows.length }}
          estimatedItemSize={56}
          recycleItems
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom }}
          renderItem={({ item, index }) => (
            <SelectionRow
              title={item}
              role={kind === "labels" ? "checkbox" : "radio"}
              selected={isSelected(item)}
              isFirst={index === 0}
              isLast={index === rows.length - 1}
              leading={
                kind === "labels" ? (
                  <PullRequestLabelDot color={colors[item.toLowerCase()] ?? null} />
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
                    ? gt("Couldn't search the host")
                    : kind === "labels"
                      ? gt("No matching labels")
                      : gt("No matching authors")
                }
                detail={
                  hosted.failed
                    ? gt("The host didn't answer. Try again in a moment.")
                    : kind === "labels"
                      ? gt("Search the labels of the repositories this list covers.")
                      : gt("Search people by name or handle on the repositories' hosts.")
                }
                variant="plain"
              />
            )
          }
        />
      )}
    </PullRequestSearchSheet>
  );
}
