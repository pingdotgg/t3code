import type { NavigationState } from "@react-navigation/native";
import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import { androidWorkspaceSettingsOpen } from "./android-workspace-tabs";
import { WorkspaceTabsProvider } from "./WorkspaceTabsContext";

interface AndroidWorkspaceRoot {
  /**
   * The rail's `useNavigation()` dispatches to the focused navigator, which may be nested Settings.
   * Use the root stack's state and key so a tab press resets the root.
   */
  readonly key: string;
  readonly getState: () => NavigationState;
  /** Settings is derived from navigation rather than kept in the tab reducer. */
  readonly settingsOpen: boolean;
}

const AndroidWorkspaceRootContext = createContext<AndroidWorkspaceRoot | null>(null);

export function useAndroidWorkspaceRoot() {
  return use(AndroidWorkspaceRootContext);
}

/** Android keeps one tab controller above the root navigator and split sidebar. */
export function AndroidWorkspaceTabsProvider(props: {
  readonly state: NavigationState;
  readonly children: ReactNode;
}) {
  const stateRef = useRef(props.state);
  useLayoutEffect(() => {
    stateRef.current = props.state;
  }, [props.state]);
  const getState = useCallback(() => stateRef.current, []);
  const key = props.state.key;
  const settingsOpen = Platform.OS === "android" && androidWorkspaceSettingsOpen(props.state);
  const root = useMemo(() => ({ key, getState, settingsOpen }), [key, getState, settingsOpen]);
  return Platform.OS === "android" ? (
    <WorkspaceTabsProvider>
      <AndroidWorkspaceRootContext value={root}>{props.children}</AndroidWorkspaceRootContext>
    </WorkspaceTabsProvider>
  ) : (
    props.children
  );
}
