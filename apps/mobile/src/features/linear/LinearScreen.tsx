import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import type { ComponentProps, ReactNode } from "react";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarProps } from "../../components/ui/AppBar.types";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import { useAndroidWorkspaceTab } from "../layout/workspace/useAndroidWorkspaceNavigation";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import type { LinearFilterPill } from "./linearFilterMenu";

/** A pushed Linear page: native header with back, then its content. */
export function LinearScreen(
  props: Pick<AppBarProps, "title" | "subtitle" | "search" | "actions" | "menus"> & {
    readonly children: ReactNode;
  },
) {
  const navigation = useNavigation();
  useAndroidWorkspaceTab("linear");
  return (
    <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
      <AppBar
        title={props.title}
        subtitle={props.subtitle}
        search={props.search}
        actions={props.actions}
        menus={props.menus}
        sidebar={false}
        onBack={() => navigation.goBack()}
      />
      <ScreenContent>{props.children}</ScreenContent>
    </View>
  );
}

type LegendListProps<Item> = ComponentProps<typeof LegendList<Item>>;

/** The virtualized list every Linear page uses: native-header scrolling and pull to refresh. */
export function LinearList<Item>(
  props: Pick<
    LegendListProps<Item>,
    | "data"
    | "renderItem"
    | "keyExtractor"
    | "getItemType"
    | "extraData"
    | "ListHeaderComponent"
    | "ListEmptyComponent"
    | "ListFooterComponent"
  > & {
    readonly estimatedItemSize: number;
    readonly refreshing: boolean;
    readonly onRefresh: () => void;
    /** Extra room under the last row, e.g. the workspace's tab bar. */
    readonly bottomInset?: number;
  },
) {
  const insets = useSafeAreaInsets();
  return (
    <LegendList
      data={props.data}
      renderItem={props.renderItem}
      keyExtractor={props.keyExtractor}
      getItemType={props.getItemType}
      extraData={props.extraData}
      estimatedItemSize={props.estimatedItemSize}
      ListHeaderComponent={props.ListHeaderComponent}
      ListEmptyComponent={props.ListEmptyComponent}
      ListFooterComponent={props.ListFooterComponent}
      drawDistance={1_000}
      recycleItems
      alwaysBounceVertical
      showsVerticalScrollIndicator={Platform.OS !== "android"}
      renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingBottom: props.bottomInset ?? Math.max(insets.bottom, 16) + 16,
      }}
      refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
    />
  );
}

const PILL_ROW_STYLE =
  Platform.OS === "android"
    ? ({ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, gap: 8 } as const)
    : ({ paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10, gap: 8 } as const);

/** Filter pills; each opens its own menu, like the pull request list's. */
export function LinearFilterPills(props: {
  readonly pills: ReadonlyArray<LinearFilterPill>;
  readonly onSelect: (event: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={PILL_ROW_STYLE}
    >
      {props.pills.map((pill) => (
        <ListFilterMenu
          key={pill.field}
          label={pill.label}
          active={pill.active}
          accessibilityLabel={pill.accessibilityLabel}
          actions={pill.actions}
          onSelect={props.onSelect}
        />
      ))}
    </ScrollView>
  );
}
