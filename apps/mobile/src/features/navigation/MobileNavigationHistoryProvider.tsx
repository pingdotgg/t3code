import { StackActions, useLinkBuilder, useNavigation } from "@react-navigation/native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import {
  createMobileNavigationHistory,
  type MobileNavigationLocation,
  type MobileNavigationHistorySnapshot,
} from "./mobile-navigation-history";
interface MobileNavigationHistoryValue extends MobileNavigationHistorySnapshot {
  readonly back: () => void;
  readonly forward: () => void;
  readonly replace: (pathname: string) => void;
}
const MobileNavigationHistoryContext = createContext<MobileNavigationHistoryValue | null>(null);
export function MobileNavigationHistoryProvider({
  children,
  location,
}: PropsWithChildren<{ readonly location: MobileNavigationLocation }>) {
  const [history] = useState(() => createMobileNavigationHistory(location));
  const snapshot = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    history.getSnapshot,
  );
  const { back, forward, replace } = useMobileNavigationHistoryCoordinator(history, location);
  const value = useMemo(
    () => ({ ...snapshot, back, forward, replace }),
    [back, forward, replace, snapshot],
  );
  return (
    <MobileNavigationHistoryContext.Provider value={value}>
      {children}
    </MobileNavigationHistoryContext.Provider>
  );
}
function useMobileNavigationHistoryCoordinator(
  history: ReturnType<typeof createMobileNavigationHistory>,
  location: MobileNavigationLocation,
) {
  const navigation = useNavigation();
  const { buildAction } = useLinkBuilder();
  useCancelBlockedTraversal(history);
  useEffect(() => {
    history.visit(location);
  }, [history, location]);
  const requestTraversal = useCallback(
    (target: ReturnType<typeof history.requestBack>) => {
      if (!target) {
        return;
      }
      const action = buildAction(target.location.pathname);
      if (action.type !== "NAVIGATE") return history.cancelPendingTraversal();
      const state = navigation.getState()!;
      const targetRootKey = target.location.transitionKey.split("/")[0]!;
      const targetRouteExists = state.routes.some((route) => route.key === targetRootKey);
      const currentRootKey = state.routes[state.index]?.key;
      if (target.direction === "back" && targetRouteExists && targetRootKey !== currentRootKey) {
        navigation.dispatch({
          ...StackActions.popTo(action.payload.name, action.payload.params),
          source: currentRootKey,
          target: state.key,
        });
      } else if (target.direction === "forward" && !targetRouteExists) {
        navigation.dispatch(StackActions.push(action.payload.name, action.payload.params));
      } else {
        navigation.dispatch({ ...action, payload: { ...action.payload, pop: true } });
      }
    },
    [buildAction, history, navigation],
  );
  const back = useCallback(
    () => requestTraversal(history.requestBack()),
    [history, requestTraversal],
  );
  const forward = useCallback(
    () => requestTraversal(history.requestForward()),
    [history, requestTraversal],
  );
  const replace = useCallback(
    (pathname: string) => {
      if (!history.requestReplacement(pathname)) return;
      const action = buildAction(pathname);
      if (action.type !== "NAVIGATE") {
        history.cancelPendingTraversal();
        return;
      }
      navigation.dispatch(StackActions.replace(action.payload.name, action.payload.params));
    },
    [buildAction, history, navigation],
  );
  return { back, forward, replace };
}
function useCancelBlockedTraversal(history: ReturnType<typeof createMobileNavigationHistory>) {
  const navigation = useNavigation();
  useEffect(() => {
    // React Navigation emits this pinned core event after routing an action.
    // `noop` is true when a beforeRemove guard blocks it or no navigator handles it.
    const actionEvents = navigation as typeof navigation & {
      addListener: (
        type: "__unsafe_action__",
        listener: (event: { readonly data: { readonly noop: boolean } }) => void,
      ) => () => void;
    };
    return actionEvents.addListener("__unsafe_action__", (event) => {
      if (event.data.noop) {
        history.cancelPendingTraversal();
      }
    });
  }, [history, navigation]);
}
export function useMobileNavigationHistory(): MobileNavigationHistoryValue {
  const value = useContext(MobileNavigationHistoryContext);
  if (!value) {
    throw new Error("useMobileNavigationHistory must be used within its provider");
  }
  return value;
}
