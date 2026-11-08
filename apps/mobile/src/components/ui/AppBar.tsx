import { Toolbar } from "./Toolbar";
import { AppActivityIndicator } from "./AppActivityIndicator";
import type { HeaderBarButtonMailSearchToolbarItem } from "react-native-screens";
import { NavigationContext } from "@react-navigation/native";
import { use, useId, useLayoutEffect, type ReactElement } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { createNativeHeaderMenu } from "./nativeHeaderMenu.ios";
import { ScreenHeaderButton } from "./ScreenHeaderButton";
import { NativeStackScreenOptions, useScreenOptionsWriter } from "../../native/StackHeader";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useDeviceType, useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { isDuoDevice } from "../../lib/device-type";
import { useAdaptiveWorkspaceLayout } from "../../features/layout/AdaptiveWorkspaceLayout";
import { useSidebarToggle } from "../../features/layout/useSidebarToggle";
import { InspectorCloseContext } from "../../features/layout/inspector-bar-store";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../../features/layout/native-mail-search-toolbar";
import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import type { AppBarMenu, AppBarMenuItem, AppBarProps } from "./AppBar.types";
import type { AppSymbolName } from "./AppSymbol";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { useControlTheme } from "./useControlTheme";
import { Menu } from "./Menu";
import { androidHeaderMenuActions, findHeaderMenuAction } from "./headerMenu.android";

function iosIcon(icon: AppSymbolName) {
  return typeof icon === "string" ? icon : icon.ios;
}

type MailMenu = NonNullable<HeaderBarButtonMailSearchToolbarItem["filterMenu"]>;
function mailMenuItems(items: ReadonlyArray<AppBarMenuItem>): MailMenu["items"] {
  return items.map((item) =>
    "items" in item
      ? { type: "submenu", title: item.title ?? "", items: mailMenuItems(item.items) }
      : {
          type: "action",
          title: item.title,
          state: item.selected ? "on" : "off",
          disabled: item.disabled,
          onPress: item.onPress,
        },
  );
}

const TITLE_BAR_MARGIN = 32;
const TITLE_BAR_BUTTON = 44;

/** Custom title that long-presses open a menu without UIKit's title-menu chevron. */
function AppBarTitleMenu(props: {
  readonly title: string;
  readonly titleMenu: AppBarMenu;
  readonly tintColor: string;
  readonly leadingButtons: number;
  readonly trailingButtons: number;
}): ReactElement {
  const { width: windowWidth } = useWindowDimensions();
  const columnWidth = useNativeColumnLayoutMetrics()?.width;
  const screenWidth = columnWidth ?? windowWidth;
  // UIKit centers the title view in the full bar. Reserve the heavier side on both sides.
  const leadingWidth = TITLE_BAR_MARGIN / 2 + props.leadingButtons * TITLE_BAR_BUTTON;
  const trailingWidth = TITLE_BAR_MARGIN / 2 + props.trailingButtons * TITLE_BAR_BUTTON;
  const width = Math.max(0, screenWidth - 2 * Math.max(leadingWidth, trailingWidth));
  return (
    <View style={{ width, overflow: "hidden" }}>
      <Menu
        shouldOpenOnLongPress
        title={props.titleMenu.status ?? props.titleMenu.title}
        actions={androidHeaderMenuActions(props.titleMenu.items)}
        onPressAction={({ nativeEvent }) => {
          const action = findHeaderMenuAction(props.titleMenu.items, nativeEvent.event);
          if (action && !action.disabled) action.onPress();
        }}
        style={{ width }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.title}
          accessibilityHint="Shows more actions"
          style={{ width }}
        >
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              color: props.tintColor,
              fontSize: 16,
              fontWeight: "800",
              width,
            }}
          >
            {props.title}
          </Text>
        </Pressable>
      </Menu>
    </View>
  );
}

export function AppBar(props: AppBarProps) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const deviceType = useDeviceType();
  const headerId = useId();
  const { layout } = useAdaptiveWorkspaceLayout();
  const sidebarToggle = useSidebarToggle();
  const closeInspector = use(InspectorCloseContext);
  const setOptions = useScreenOptionsWriter();
  const ownsInspectorBar = closeInspector !== null && !props.embedded && !props.sheet;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an inspector pane that stops drawing its bar must not leave it in the out-of-tree inspector bar
  useLayoutEffect(() => {
    if (!ownsInspectorBar || !setOptions) return;
    setOptions({ headerShown: true });
    return () => setOptions({ headerShown: false });
  }, [ownsInspectorBar, setOptions]);
  const splitBackPress = props.backInSplitView?.onPress ?? props.onBack;
  const splitBack =
    layout.usesSplitView && props.backInSplitView && splitBackPress
      ? { ...props.backInSplitView, onPress: splitBackPress }
      : null;
  const navigation = use(NavigationContext);
  const rootBack =
    !layout.usesSplitView && props.onBackToList && navigation?.canGoBack() === false
      ? props.onBackToList
      : props.guardBack && props.onBack
        ? props.onBack
        : null;
  const compose =
    layout.usesSplitView && !(usesNativeWorkspaceColumns && isDuoDevice(deviceType))
      ? props.onCompose
      : undefined;
  const { themeVariables } = useAppearancePreferences();
  const { colors } = useControlTheme();
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  const { search, menus } = props;
  const menu = menus?.[0];
  const compactSearch =
    search !== undefined &&
    (search.compactToolbar ?? !layout.usesSplitView) &&
    usesNativeMailSearchToolbar;
  const visibleMenus = compactSearch ? (menus?.slice(1) ?? []) : (menus ?? []);
  // Where the mail toolbar isn't used, the Duo keeps search at the bottom of the pane like its
  // workspace lists; elsewhere inline search is a button in the bar.
  const duoBottomSearch =
    search !== undefined &&
    !compactSearch &&
    NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED &&
    isDuoDevice(deviceType);
  const titleMenu = props.titleMenu;
  const titleLeadingButtons = Math.max(
    1,
    (props.onClose || rootBack || splitBack || showsSidebarToggle ? 1 : 0) + (compose ? 1 : 0),
  );
  const titleTrailingButtons =
    (props.actions?.length ?? 0) +
    visibleMenus.length +
    (props.trailing ? 1 : 0) +
    (props.confirm ? 1 : 0) +
    (closeInspector ? 1 : 0);
  if (props.embedded || props.sheet) return null;
  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[props.optionsVersion, compactSearch ? menu : undefined, titleMenu]}
        options={{
          headerShown: true,
          headerBackVisible:
            props.onClose === undefined &&
            splitBack === null &&
            !(layout.usesSplitView && props.onBackToList) &&
            !(props.guardBack && props.onBack),
          ...(props.guardBack ? { gestureEnabled: false } : undefined),
          title: props.title,
          // Long-press MenuView instead of UIKit titleMenu — the latter adds a disclosure
          // chevron that squeezes trailing git/terminal/files into the system More overflow.
          ...(titleMenu
            ? {
                // React Navigation treats headerTitle as a render callback, not a child component type.
                // oxlint-disable-next-line react/no-unstable-nested-components -- headerTitle render prop
                headerTitle: () => (
                  <AppBarTitleMenu
                    title={props.title}
                    titleMenu={titleMenu}
                    tintColor={String(colors["--color-header-foreground"])}
                    leadingButtons={titleLeadingButtons}
                    trailingButtons={titleTrailingButtons}
                  />
                ),
              }
            : undefined),
          unstable_headerSubtitle: props.subtitle || undefined,
          ...(props.matchSearchSurface
            ? { contentStyle: { backgroundColor: themeVariables["--color-sheet-solid"] } }
            : undefined),
          ...(search
            ? {
                unstable_headerToolbarItems: compactSearch
                  ? () => [
                      createNativeMailSearchToolbarItem({
                        showsSearchDismissButton: true,
                        placeholder: search.compactPlaceholder ?? search.placeholder,
                        onSearchTextChange: search.onChangeText,
                        searchTextChangeId: `${headerId}-search-text`,
                        ...(menu
                          ? {
                              filterButtonId: `${headerId}-filter`,
                              filterSystemImageName: iosIcon(menu.icon),
                              filterMenu: { title: menu.title, items: mailMenuItems(menu.items) },
                            }
                          : undefined),
                      }),
                    ]
                  : () => [],
                headerSearchBarOptions: compactSearch
                  ? undefined
                  : {
                      allowToolbarIntegration: true,
                      ...(duoBottomSearch
                        ? { placement: "integrated" as const }
                        : NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED && search.mode === "inline"
                          ? { placement: "integratedButton" as const }
                          : undefined),
                      autoCapitalize: "none",
                      hideNavigationBar: false,
                      ...(search.mode === "inline" || duoBottomSearch
                        ? { obscureBackground: false }
                        : undefined),
                      placeholder: search.placeholder,
                      onChangeText: (event) => search.onChangeText(event.nativeEvent.text),
                      onCancelButtonPress: () => search.onChangeText(""),
                    },
              }
            : undefined),
        }}
      />
      {props.onClose ? (
        <Toolbar placement="left">
          <Toolbar.Button
            icon="xmark"
            accessibilityLabel={props.closeAccessibilityLabel ?? "Close"}
            onPress={props.onClose}
          />
        </Toolbar>
      ) : rootBack || splitBack || sidebarToggle || compose ? (
        <Toolbar placement="left">
          {rootBack ? (
            <ScreenHeaderButton
              accessibilityLabel="Back"
              icon="chevron.left"
              onPress={rootBack}
              separateBackground
            />
          ) : null}
          {splitBack ? <ScreenHeaderButton {...splitBack} /> : null}
          {sidebarToggle ? (
            <ScreenHeaderButton
              axisBehavior={usesNativeWorkspaceColumns ? "horizontalOnly" : undefined}
              accessibilityLabel={sidebarToggle.accessibilityLabel}
              icon={sidebarToggle.icon}
              onPress={sidebarToggle.onPress}
              separateBackground={splitBack ? splitBack.separateBackground : true}
            />
          ) : null}
          {compose ? (
            <ScreenHeaderButton
              accessibilityLabel="New task"
              label="New task"
              icon="square.and.pencil"
              onPress={compose}
              separateBackground
            />
          ) : null}
        </Toolbar>
      ) : null}
      {props.actions?.length ||
      visibleMenus.length ||
      props.trailing ||
      props.confirm ||
      closeInspector ? (
        <Toolbar placement="right">
          {props.actions?.map(({ loading, visibilityPriority, ...action }) =>
            loading ? (
              <Toolbar.Custom key={action.accessibilityLabel}>
                <View
                  accessibilityLabel={action.accessibilityLabel}
                  className="size-9 items-center justify-center"
                >
                  <AppActivityIndicator color={action.tintColor} />
                </View>
              </Toolbar.Custom>
            ) : (
              <ScreenHeaderButton
                key={action.accessibilityLabel}
                {...action}
                icon={iosIcon(action.icon)}
                separateBackground={action.separateBackground ?? true}
                visibilityPriority={visibilityPriority}
              />
            ),
          )}
          {visibleMenus.map(createNativeHeaderMenu)}
          {props.trailing}
          {props.confirm?.loading ? (
            <Toolbar.Custom>
              <View
                className="size-11 items-center justify-center"
                accessible
                accessibilityLabel={props.confirm.label}
                accessibilityState={{ busy: true }}
              >
                <AppActivityIndicator colorClassName="accent-prominent-action" />
              </View>
            </Toolbar.Custom>
          ) : props.confirm ? (
            <Toolbar.Button
              icon="checkmark"
              variant="prominent"
              visibilityPriority="high"
              tintColor={colors["--color-prominent-action"]}
              accessibilityLabel={props.confirm.label}
              disabled={props.confirm.disabled}
              onPress={props.confirm.onPress}
            />
          ) : null}
          {closeInspector ? (
            <ScreenHeaderButton
              accessibilityLabel="Close inspector"
              icon="xmark"
              onPress={closeInspector}
              separateBackground
            />
          ) : null}
        </Toolbar>
      ) : null}
      {duoBottomSearch ? (
        <Toolbar placement="bottom">
          <Toolbar.SearchBarSlot />
        </Toolbar>
      ) : null}
    </>
  );
}

export type {
  AppBarAction,
  AppBarConfirm,
  AppBarMenu,
  AppBarMenuItem,
  AppBarProps,
  AppBarSearch,
} from "./AppBar.types";
