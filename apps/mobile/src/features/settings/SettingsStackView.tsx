import { CommonActions } from "@react-navigation/native";
import { NativeStackView } from "@react-navigation/native-stack";
import { useCallback, useMemo, type ComponentProps } from "react";
import { Platform, View } from "react-native";

import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { SettingsSheetTarget } from "./components/settings-sheet-targets";
import { SettingsPaneContext } from "./settings-pane-context";
import { settingsSectionNavigationAction } from "./settings-section-navigation";
import { SettingsPaneStackView } from "./SettingsPaneStackView";

export function SettingsStackView(props: ComponentProps<typeof NativeStackView>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const root = props.state.routes.find((route) => route.name === "Settings");
  const descriptor = root ? props.descriptors[root.key] : undefined;
  const split = layout.usesSplitView;
  const selectSection = useCallback(
    (target: SettingsSheetTarget) => {
      props.navigation.dispatch((state) => {
        return settingsSectionNavigationAction(state, target) ?? CommonActions.navigate(target);
      });
    },
    [props.navigation],
  );
  const listContext = useMemo(
    () => ({
      role: "list" as const,
      split,
      selectedSection: props.state.routes[1]?.name,
      selectSection: split ? selectSection : undefined,
    }),
    [split, props.state.routes, selectSection],
  );
  // Duo's rail must reserve only the outer edge of each pane.
  const detailDescriptors = Object.fromEntries(
    Object.entries(props.descriptors).map(([key, item]) => {
      const options = item.options as AppNativeStackNavigationOptions;
      return [
        key,
        {
          ...item,
          options: {
            ...item.options,
            ...(split &&
            options.nativeContentInsetHorizontally !== false &&
            (options.presentation === undefined || options.presentation === "card")
              ? { nativeContentInsetHorizontally: "right" as const }
              : {}),
          },
        },
      ];
    }),
  );
  const detailContext = useMemo(() => ({ role: "detail" as const, split }), [split]);
  if (!root || !descriptor) return <SettingsPaneStackView {...props} />;

  const listOptions = { ...descriptor.options, nativeContentInsetHorizontally: "left" as const };
  const emptyDetailOptions = split
    ? {
        ...descriptor.options,
        nativeContentInsetHorizontally: "right" as const,
        headerShown: false,
      }
    : descriptor.options;
  const listVisible = split;
  const detailLeft = split
    ? (layout.listPaneWidth ?? 320) + (layout.listPaneGap ?? (Platform.OS === "android" ? 0 : 1))
    : 0;
  return (
    <View className="flex-1 bg-header">
      {/* Both stacks keep their controllers and form state while the window collapses. */}
      <View
        pointerEvents={listVisible ? "auto" : "none"}
        accessibilityElementsHidden={!listVisible}
        importantForAccessibility={listVisible ? "auto" : "no-hide-descendants"}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          ...(split ? { width: layout.listPaneWidth ?? 320 } : { right: 0 }),
          opacity: listVisible ? 1 : 0,
        }}
      >
        <SettingsPaneContext value={listContext}>
          <SettingsPaneStackView
            {...props}
            descriptors={{
              ...props.descriptors,
              [root.key]: {
                ...descriptor,
                options: listOptions,
              },
            }}
            state={{ ...props.state, routes: [root], index: 0, preloadedRoutes: [] }}
          />
        </SettingsPaneContext>
      </View>
      <View
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: detailLeft,
          right: 0,
        }}
      >
        <SettingsPaneContext value={detailContext}>
          <SettingsPaneStackView
            // A category reset gives the router a new key. UIKit needs a new stack too,
            // rather than trying to pop the old category while pushing its replacement.
            key={props.state.key}
            {...props}
            descriptors={{
              ...detailDescriptors,
              [root.key]: {
                ...descriptor,
                options: emptyDetailOptions,
                render: () =>
                  split ? (
                    <View className="flex-1 bg-header">
                      {Platform.OS === "android" ? (
                        <AppBar title="" sidebar={false} hideBottomBorder />
                      ) : null}
                      <ScreenContent insetHorizontal>
                        <View className="flex-1 items-center justify-center bg-sheet px-8">
                          <EmptyState
                            title="Select a setting"
                            detail="Choose a category from the Settings list."
                            variant="plain"
                          />
                        </View>
                      </ScreenContent>
                    </View>
                  ) : (
                    descriptor.render()
                  ),
              },
            }}
          />
        </SettingsPaneContext>
      </View>
    </View>
  );
}
