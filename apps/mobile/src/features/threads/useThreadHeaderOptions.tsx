import { StackActions, useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { isDuoDevice } from "../../lib/device-type";
import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
import { useDeviceType } from "../../native/native-layout-metrics";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import {
  ThreadGitControls,
  useThreadGitCenterHeaderItems,
  useThreadGitRightHeaderItems,
} from "./ThreadGitControls";

type NativeHeaderItems = ReadonlyArray<Record<string, unknown>>;

export function useThreadHeaderOptions(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly headerColor: string;
  readonly usesNativeHeaderGlass: boolean;
  readonly gitControls: Parameters<typeof ThreadGitControls>[0];
  readonly onReturnToThread?: () => void;
}) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const deviceType = useDeviceType();
  const usesDuoHeader = usesNativeWorkspaceColumns && isDuoDevice(deviceType);
  const navigation = useNavigation();
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const threadCenterHeaderItems = useThreadGitCenterHeaderItems(props.gitControls);
  const compactRightHeaderItems = useThreadGitRightHeaderItems(props.gitControls);
  const splitLeftHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      ...(!usesDuoHeader
        ? [
            {
              spacing: 18,
              type: "spacing" as const,
            },
          ]
        : []),
      ...(props.onReturnToThread
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Return to chat",
              icon: { name: "chevron.left", type: "sfSymbol" as const },
              identifier: "thread-left-return",
              onPress: props.onReturnToThread,
              type: "button" as const,
            }),
          ]
        : []),
      withNativeGlassHeaderItem({
        axisBehavior: usesNativeWorkspaceColumns ? "horizontalOnly" : undefined,
        accessibilityLabel: panes.primarySidebarVisible
          ? "Maximize content"
          : "Show thread sidebar",
        icon: {
          name: panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left",
          type: "sfSymbol" as const,
        },
        identifier: "thread-left-sidebar",
        label: panes.primarySidebarVisible ? "Maximize content" : "Show thread sidebar",
        onPress: togglePrimarySidebar,
        type: "button" as const,
      }),
      ...(!usesDuoHeader
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "New task",
              icon: { name: "square.and.pencil", type: "sfSymbol" as const },
              identifier: "thread-left-new-task",
              label: "New task",
              onPress: () => navigation.navigate("NewTaskSheet", { screen: "NewTask" }),
              type: "button" as const,
            }),
          ]
        : []),
    ],
    [
      panes.primarySidebarVisible,
      props.onReturnToThread,
      navigation,
      togglePrimarySidebar,
      usesDuoHeader,
      usesNativeWorkspaceColumns,
    ],
  );
  const canGoBack = navigation.canGoBack();
  const compactHomeHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      withNativeGlassHeaderItem({
        accessibilityLabel: "Go to threads list",
        icon: { name: "list.bullet", type: "sfSymbol" as const },
        identifier: "thread-left-home",
        onPress: () => navigation.dispatch(StackActions.replace("Home")),
        type: "button" as const,
      }),
    ],
    [navigation],
  );

  const duoRightHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      ...threadCenterHeaderItems,
      { type: "spacing", spacing: 8 },
      withNativeGlassHeaderItem({
        type: "button" as const,
        axisBehavior: "verticalPreferred",
        identifier: "thread-right-new-task",
        label: "New task",
        accessibilityLabel: "New task",
        icon: { name: "square.and.pencil", type: "sfSymbol" as const },
        onPress: () => navigation.navigate("NewTaskSheet", { screen: "NewTask" }),
      }),
    ],
    [navigation, threadCenterHeaderItems],
  );

  const options: AppNativeStackNavigationOptions = {
    headerShown: true,
    headerTitle: props.title,
    headerTitleStyle: props.usesNativeHeaderGlass
      ? {
          fontSize: 17,
          fontWeight: "800",
        }
      : undefined,
    title: props.title,
    headerBackVisible: !layout.usesSplitView,
    unstable_headerLeftItems: layout.usesSplitView
      ? () => splitLeftHeaderItems
      : canGoBack
        ? undefined
        : () => compactHomeHeaderItems,
    unstable_headerRightItems: () =>
      usesDuoHeader
        ? duoRightHeaderItems
        : layout.usesSplitView
          ? threadCenterHeaderItems
          : compactRightHeaderItems,
    unstable_headerToolbarItems: () => [],
    unstable_headerSubtitle: props.usesNativeHeaderGlass ? props.subtitle : undefined,
    contentStyle: undefined,
  };
  const { environmentId, threadId, gitStatus } = props.gitControls;
  return {
    options,
    // Header item factories are stabilized, so the native header only re-reads them when
    // this version changes. Keying on the items keeps the Git menu status live; the menu
    // callbacks also read state the items do not display (a "Push" item runs `push` or
    // `commit_push` depending on the default ref), so that state is keyed too.
    optionsVersion: [
      splitLeftHeaderItems,
      threadCenterHeaderItems,
      compactRightHeaderItems,
      duoRightHeaderItems,
      usesDuoHeader,
      environmentId,
      threadId,
      gitStatus?.isDefaultRef,
      gitStatus?.refName,
      gitStatus?.pr?.url,
    ],
    sidebar: false,
    fallback:
      !layout.usesSplitView && !props.usesNativeHeaderGlass ? (
        <ThreadGitControls {...props.gitControls} showActionControls />
      ) : null,
  };
}
