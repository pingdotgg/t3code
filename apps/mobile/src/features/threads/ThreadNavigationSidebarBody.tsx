import { ThreadUndoNotice } from "../home/ThreadUndoNotice";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { THREAD_SIDEBAR_ROW_LAYOUT } from "./threadListAnimations";
import type { MenuAction } from "@react-native-menu/menu";
import type { LayoutChangeEvent, TextInputInstance } from "react-native";
import { Platform, StyleSheet, TextInput, View } from "react-native";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import { FLOATING_TABS } from "../workspace/floating-workspace-tabs";
import type { SearchBarCommands } from "react-native-screens";

import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useNavigationThreadShells } from "../../state/entities";
import { useHomeListOptions } from "../home/home-list-options";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import {
  getConnectionAwareBrandHeaderOptions,
  WorkspaceConnectionTitle,
} from "../home/WorkspaceConnectionTitle";
import { SidebarHeaderActions } from "./sidebar-header-actions";
import { ThreadListToolbar } from "../home/ThreadListToolbar";
import { SidebarFilterButton } from "./sidebar-filter-button";
import { createSidebarHeaderItems } from "./sidebar-native-header-items";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import type { ReactElement, RefObject } from "react";
import type { EdgeInsets } from "react-native-safe-area-context";
import type { SidebarListItem, ThreadNavigationSidebarPaneProps } from "./ThreadNavigationSidebar";

export interface ThreadNavigationSidebarBodyProps {
  readonly sidebarProps: ThreadNavigationSidebarPaneProps;
  readonly drawerColor: string;
  readonly fabClearance: number;
  readonly fabSize: number;
  readonly scrollGateHandlers: ReturnType<typeof useSwipeableScrollGate>["scrollGateHandlers"];
  readonly filterCustomized: boolean;
  readonly floatingTabsEnabled: boolean;
  readonly handleListMenuAction: (event: {
    readonly nativeEvent: { readonly event: string };
  }) => void;
  readonly handleStickyHeaderLayout: (event: LayoutChangeEvent) => void;
  readonly insets: EdgeInsets;
  readonly listEmpty: ReactElement;
  readonly listExtraData: unknown;
  readonly listItems: ReadonlyArray<SidebarListItem>;
  readonly listMenuActions: MenuAction[];
  readonly nativeHeaderItems: ReturnType<typeof createSidebarHeaderItems>;
  readonly renderListItem: (info: { readonly item: SidebarListItem }) => ReactElement | null;
  readonly searchBarRef: RefObject<SearchBarCommands | null>;
  readonly searchInputRef: RefObject<TextInputInstance | null>;
  readonly sidebarItemsAreEqual: (previous: SidebarListItem, item: SidebarListItem) => boolean;
  readonly sidebarScrollGesture: ReturnType<typeof useNativeGesture>;
  readonly stickyHeaderHeight: number;
  readonly swipeEnabled: boolean;
  readonly topListInset: number;
}

export function ThreadNavigationSidebarBody(input: ThreadNavigationSidebarBodyProps) {
  const {
    sidebarProps: props_,
    drawerColor,
    fabClearance,
    fabSize,
    scrollGateHandlers,
    filterCustomized,
    floatingTabsEnabled,
    handleListMenuAction,
    handleStickyHeaderLayout,
    insets,
    listEmpty,
    listExtraData,
    listItems,
    listMenuActions,
    nativeHeaderItems,
    renderListItem,
    searchBarRef,
    searchInputRef,
    sidebarItemsAreEqual,
    sidebarScrollGesture,
    stickyHeaderHeight,
    swipeEnabled,
    topListInset,
  } = input;
  const props = props_;
  const filterIcon = filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  if (props.nativeChrome) {
    return (
      <>
        <NativeStackScreenOptions
          optionsVersion={[nativeHeaderItems, props.width]}
          options={{
            ...getConnectionAwareBrandHeaderOptions({
              headerWidth: props.width,
              trailingItemCount: nativeHeaderItems.length,
              onOpenEnvironments: props.onOpenEnvironmentSettings,
              fallbackTitleStyle: { fontSize: 18, fontWeight: "800" },
            }),
            headerSearchBarOptions: {
              ref: searchBarRef,
              autoCapitalize: "none",
              hideNavigationBar: false,
              hideWhenScrolling: false,
              obscureBackground: false,
              placeholder: "Search",
              placement: "stacked",
              onCancelButtonPress: () => {
                props.onSearchQueryChange("");
              },
              onChangeText: (event) => {
                props.onSearchQueryChange(event.nativeEvent.text);
              },
            },
            unstable_headerRightItems: () => nativeHeaderItems,
          }}
        />
        <View className="flex-1">
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <AnimatedLegendList
                renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
                itemLayoutAnimation={THREAD_SIDEBAR_ROW_LAYOUT}
                data={listItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                automaticallyAdjustsScrollIndicatorInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
                contentInsetAdjustmentBehavior={
                  NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never"
                }
                contentContainerStyle={[
                  styles.threadListContent,
                  Platform.OS === "android" ? { paddingHorizontal: 0 } : null,
                  {
                    paddingBottom: Math.max(insets.bottom, 16) + 16,
                    paddingTop: 6,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
          <ThreadUndoNotice visible={props.visible} />
        </View>
      </>
    );
  }

  return (
    <View
      testID="thread-navigation-sidebar"
      className={
        Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 border-r border-border bg-drawer"
      }
      // Android fills its pane, which animates its width while a hinge resizes the split.
      style={Platform.OS === "android" ? undefined : { width: props.width }}
    >
      <View
        className="flex-1"
        style={
          Platform.OS === "android"
            ? {
                marginTop: stickyHeaderHeight,
                marginHorizontal: 4,
                paddingBottom: insets.bottom,
                backgroundColor: drawerColor,
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                overflow: "hidden",
              }
            : { paddingBottom: insets.bottom }
        }
      >
        {Platform.OS === "android" && listItems.length === 0 ? (
          <View className="flex-1 items-center justify-center">{listEmpty}</View>
        ) : (
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- Only the non-native workspace layout (Android and the fallback) renders this sidebar, which has no native header to register with. */}
              <AnimatedLegendList
                itemLayoutAnimation={THREAD_SIDEBAR_ROW_LAYOUT}
                data={listItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                contentContainerStyle={[
                  styles.threadListContent,
                  Platform.OS === "android" ? { paddingHorizontal: 0 } : null,
                  {
                    paddingBottom:
                      Platform.OS === "android"
                        ? floatingTabsEnabled
                          ? FLOATING_TABS.bottom + FLOATING_TABS.edge + fabSize
                          : Math.max(insets.bottom, 16) + fabClearance - insets.bottom
                        : 16 + insets.bottom,
                    paddingTop: Platform.OS === "android" ? 6 : topListInset,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
        )}
      </View>

      {Platform.OS === "android" ? (
        <ThreadListToolbar
          sidebar
          onLayout={handleStickyHeaderLayout}
          searchQuery={props.searchQuery}
          onSearchQueryChange={props.onSearchQueryChange}
          filterActions={listMenuActions}
          filterCustomized={filterCustomized}
          onFilterAction={handleListMenuAction}
          onOpenEnvironments={props.onOpenEnvironmentSettings}
          onRequestVisibility={props.onRequestVisibility}
        />
      ) : (
        <View
          className="absolute inset-x-0 top-0 z-[4] bg-drawer"
          collapsable={false}
          onLayout={handleStickyHeaderLayout}
          pointerEvents="auto"
          style={{ paddingTop: insets.top }}
        >
          <View className="h-[50px] flex-row items-end gap-0.5 pr-2 pl-5">
            <WorkspaceConnectionTitle
              grow
              onPress={props.onOpenEnvironmentSettings}
              size="pageTitle"
              brand={
                <View className="h-11 flex-1 justify-center">
                  <CompactBrandTitle allowFontScaling={false} />
                </View>
              }
            />
            <View className="flex-row items-center gap-2.5">
              <Menu actions={listMenuActions} onPressAction={handleListMenuAction}>
                <SidebarFilterButton accessibilityLabel="Filter threads" icon={filterIcon} />
              </Menu>
              <SidebarHeaderActions onOpenSettings={props.onOpenSettings} />
            </View>
          </View>

          <View className="mx-4 mt-[9px] h-[38px] flex-row items-center gap-1.5 rounded-xl bg-sidebar-search pr-2.5 pl-[11px]">
            <SymbolView
              name="magnifyingglass"
              size={15}
              tintColorClassName="accent-drawer-foreground-muted"
              type="monochrome"
            />
            <TextInput
              ref={searchInputRef}
              accessibilityLabel="Search threads"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              onChangeText={props.onSearchQueryChange}
              placeholder="Search"
              placeholderTextColorClassName="accent-placeholder"
              selectionColorClassName={undefined}
              cursorColorClassName={undefined}
              selectionHandleColorClassName={undefined}
              returnKeyType="search"
              className="h-[34px] flex-1 px-0 py-0 font-sans text-base text-drawer-foreground"
              value={props.searchQuery}
            />
          </View>
        </View>
      )}
      <ThreadUndoNotice visible={props.visible} />
    </View>
  );
}

const styles = StyleSheet.create({
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});
