import {
  WorkspaceColumnsRendererContext,
  WorkspacePresentationHostContext,
} from "./workspace-presentation-context";
import { useAndroidFloatingTabs } from "../settings/appearance/AppearancePreferencesProvider";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { AdaptiveWorkspaceContext, useAdaptiveWorkspaceLayout } from "./adaptive-workspace-context";
import { threadSelectionDeferral } from "./deferred-navigation";
import { uuidv4 } from "../../lib/uuid";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId, type SidebarProjectGroupingMode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { NavigationContext, NavigationRouteContext, useNavigation } from "@react-navigation/native";
import {
  use,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Keyboard, Platform, useWindowDimensions, View } from "react-native";
import { KeyboardController, useKeyboardState } from "react-native-keyboard-controller";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { AsyncResult } from "effect/reactivity";

import {
  deriveFileInspectorPaneLayout,
  alignListPaneToHinge,
  deriveLayout,
  type VerticalHinge,
  deriveWorkspacePaneLayout,
  isPrimarySidebarPinned,
  isWorkspaceListPath,
  type WorkspaceAuxiliaryPaneRole,
} from "../../lib/layout";
import { scopedThreadKey } from "../../lib/scopedEntities";
import type { ThreadListFilters } from "../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects } from "../../state/entities";
import { useThreadCwd } from "../../state/use-selected-thread-worktree";
import { environmentThreadShells } from "../../state/threads";
import { mobilePreferencesAtom } from "../../state/preferences";
import {
  DEFAULT_MOBILE_PROJECT_GROUPING_SETTINGS,
  resolveMobileProjectGroupingSettings,
} from "../../state/project-grouping";
import {
  parseActiveThreadPath,
  useHardwareKeyboardCommand,
} from "../keyboard/hardwareKeyboardCommands";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { useEnabledNavigationTabs } from "../workspace/navigation-tabs";
import { FLOATING_TABS, floatingTabsMetrics } from "../workspace/floating-workspace-tabs";
import { AndroidHomeFabLayout } from "../home/AndroidHomeFab";
import {
  AndroidWorkspaceNavigation,
  FloatingWorkspaceTabs,
  ANDROID_WORKSPACE_RAIL_WIDTH,
} from "../workspace/AndroidWorkspaceNavigation";
import { AndroidWorkspaceSidebar } from "../workspace/AndroidWorkspaceSidebar";
import {
  selectWorkspaceDetail,
  type WorkspaceDetail,
  type WorkspaceDetailSheet,
} from "../workspace/workspace-detail-selection";
import { startOpeningDetail } from "../workspace/useSelectWorkspaceDetail";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { HomeListOptionsProvider } from "../home/home-list-options";
import { newTaskDestination } from "../threads/new-task-project-selection";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { ThreadNavigationSidebar } from "../threads/ThreadNavigationSidebar";
import { useOpenThreadPullRequests } from "../threads/use-open-thread-pull-requests";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { WORKSPACE_PANE_TIMING } from "./workspace-pane-animation";
import { WorkspaceInspectorPane } from "./workspace-inspector-pane";
import {
  WorkspaceContentWidthContext,
  WorkspaceSettledContentWidthContext,
} from "./workspace-content-width";
import {
  NativeWorkspaceModeContext,
  NativeWorkspaceInspectorContext,
} from "../../native/v5-workspace-context";

import { useNativeLayoutMetrics } from "../../native/native-layout-metrics";
import { AndroidHingeObserver } from "../../native/AndroidHingeObserver";
import { WindowHingeContext } from "../../native/window-hinge-context";
import { useAndroidWorkspaceRoot } from "../workspace/AndroidWorkspaceTabsProvider";
import { openSettings } from "../settings/settings-navigation";
import { dispatchRootStackReset, rootStackState } from "../../lib/root-stack-reset";
import {
  currentWorkspaceSelections,
  workspaceSelectionCheck,
} from "../workspace/workspace-selection-store";
import {
  workspaceTabColumns,
  workspaceTabNavigationState,
} from "../workspace/workspace-tab-navigation";
import type { WorkspaceTab } from "../workspace/workspace-tabs-state";
import { workspaceRoutesOf } from "./workspace-overlay-routes";
import { SettingsWorkspaceLayout } from "../settings/SettingsWorkspaceLayout";

export function useRegisterWorkspaceInspector(render: (() => ReactNode) | undefined) {
  const { registerWorkspaceInspector } = useAdaptiveWorkspaceLayout();
  const navigation = use(NavigationContext);
  const route = use(NavigationRouteContext);

  const wrappedRender = (() => {
    if (render === undefined) {
      return undefined;
    }
    return () => (
      <NavigationContext.Provider value={navigation}>
        <NavigationRouteContext.Provider value={route}>{render()}</NavigationRouteContext.Provider>
      </NavigationContext.Provider>
    );
  })();

  const focusedRef = useRef(false);
  const deactivateRef = useRef<(() => void) | null>(null);

  const syncRegistration = useEffectEvent(() => {
    if (!focusedRef.current || wrappedRender === undefined) {
      deactivateRef.current?.();
      return;
    }
    deactivateRef.current = registerWorkspaceInspector(wrappedRender);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Navigation focus events own the inspector registration lifetime.
  useEffect(() => {
    if (navigation === undefined) return;
    const focus = () => {
      if (focusedRef.current) return;
      focusedRef.current = true;
      syncRegistration();
    };
    const blur = () => {
      focusedRef.current = false;
      syncRegistration();
    };
    if (navigation.isFocused()) focus();
    const unsubscribeFocus = navigation.addListener("focus", focus);
    const unsubscribeBlur = navigation.addListener("blur", blur);
    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
      focusedRef.current = false;
      deactivateRef.current?.();
      deactivateRef.current = null;
    };
  }, [navigation]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Changed pane content replaces the focused inspector registration.
  useEffect(() => {
    if (focusedRef.current) {
      syncRegistration();
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Changed pane content replaces its existing native workspace registration.
  }, [wrappedRender]);
}

