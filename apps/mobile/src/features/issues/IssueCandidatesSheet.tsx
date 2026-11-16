import { LegendList } from "@legendapp/list/react-native";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { PullRequestSearchSheet } from "../pull-requests/PullRequestSearchSheet";

interface Candidate {
  readonly key: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly leading: ReactNode;
  readonly selected: boolean;
}

/** The searchable checklist behind the label and assignee pickers. */
export function IssueCandidatesSheet(props: {
  readonly title: string;
  readonly noun: "labels" | "people";
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly candidates: ReadonlyArray<Candidate>;
  readonly allowed: boolean;
  readonly notice: string | null;
  readonly pending: boolean;
  readonly loadError: string | null;
  readonly onRetry: () => void;
  readonly truncated: boolean;
  readonly onToggle: (key: string) => void;
}) {
  const searching = props.query.trim().length > 0;
  return (
    <PullRequestSearchSheet
      title={props.title}
      placeholder={`Search ${props.noun}`}
      closeAccessibilityLabel={`Close ${props.title.toLowerCase()}`}
      clearAccessibilityLabel="Clear search"
      query={props.query}
      onQueryChange={props.onQueryChange}
    >
      {({ paddingBottom }) => (
        <LegendList
          renderScrollComponent={NativeScrollView}
          data={props.candidates}
          keyExtractor={(candidate) => candidate.key}
          extraData={props.candidates}
          estimatedItemSize={64}
          recycleItems
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom }}
          ListHeaderComponent={
            props.notice ? (
              <Text className="pb-3 text-xs text-foreground-muted">{props.notice}</Text>
            ) : undefined
          }
          renderItem={({ item, index }) => (
            <SelectionRow
              title={item.title}
              {...(item.subtitle ? { subtitle: item.subtitle } : {})}
              role="checkbox"
              selected={item.selected}
              disabled={!props.allowed}
              isFirst={index === 0}
              isLast={index === props.candidates.length - 1}
              leading={item.leading}
              onPress={() => props.onToggle(item.key)}
            />
          )}
          ListEmptyComponent={
            props.pending ? (
              <AppActivityIndicator className="my-8" />
            ) : (
              <View>
                <EmptyState
                  title={
                    props.loadError
                      ? `Couldn't load ${props.noun}`
                      : searching
                        ? `No matching ${props.noun}`
                        : props.noun === "labels"
                          ? "This tracker has no labels"
                          : "Nobody can be assigned here"
                  }
                  detail={
                    props.loadError ??
                    (searching ? "Try another name." : "Add them on the tracker to use them here.")
                  }
                  variant="plain"
                />
                {props.loadError ? <Button label="Retry" onPress={props.onRetry} /> : null}
              </View>
            )
          }
          ListFooterComponent={
            props.truncated ? (
              <Text className="py-4 text-xs text-foreground-muted">
                More {props.noun} exist than are listed here.
              </Text>
            ) : undefined
          }
        />
      )}
    </PullRequestSearchSheet>
  );
}
