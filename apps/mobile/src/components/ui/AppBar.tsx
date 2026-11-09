import { Toolbar } from "./Toolbar";
import { AppActivityIndicator } from "./AppActivityIndicator";
import type { HeaderBarButtonMailSearchToolbarItem } from "react-native-screens";
import { NavigationContext } from "@react-navigation/native";
import { use, useId, useLayoutEffect } from "react";
import { View } from "react-native";
import { createNativeHeaderMenu } from "./nativeHeaderMenu.ios";
import { ScreenHeaderButton } from "./ScreenHeaderButton";
import { NativeStackScreenOptions, useScreenOptionsWriter } from "../../native/StackHeader";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useDeviceType } from "../../native/native-layout-metrics";
import { isDuoDevice } from "../../lib/device-type";
import { useAdaptiveWorkspaceLayout } from "../../features/layout/adaptive-workspace-context";
import { useSidebarToggle } from "../../features/layout/useSidebarToggle";
import { InspectorCloseContext } from "../../features/layout/inspector-bar-store";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../../features/layout/native-mail-search-toolbar";
import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import type { AppBarMenuItem, AppBarProps } from "./AppBar.types";
import type { AppSymbolName } from "./AppSymbol";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { useControlTheme } from "./useControlTheme";

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
  // The Duo's native columns show their own sidebar button while the sidebar is open.
  const showsSidebarToggle =
    sidebarToggle !== null &&
    (!usesNativeWorkspaceColumns || deviceType === "pad" || !sidebarToggle.visible);
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
  if (props.embedded || props.sheet) return null;
  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[props.optionsVersion, compactSearch ? menu : undefined]}
        options={{
          headerShown: true,
          headerBackVisible:
            props.onClose === undefined &&
            splitBack === null &&
            !(layout.usesSplitView && props.onBackToList) &&
            !(props.guardBack && props.onBack),
          ...(props.guardBack ? { gestureEnabled: false } : undefined),
          title: props.title,
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
      ) : rootBack || splitBack || showsSidebarToggle || compose ? (
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
          {showsSidebarToggle ? (
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
          {props.actions?.map(({ loading, ...action }) =>
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
