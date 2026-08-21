import { useLinkBuilder, useNavigation } from "@react-navigation/native";
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
  const { back, forward } = useMobileNavigationHistoryCoordinator(history, location);
  const value = useMemo(() => ({ ...snapshot, back, forward }), [back, forward, snapshot]);

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
      if (!("payload" in action)) return;
      navigation.dispatch({ ...action, payload: { ...action.payload, pop: true } });
    },
    [buildAction, history, navigation],
  );

  const back = useCallback(() => {
    requestTraversal(history.requestBack());
  }, [history, requestTraversal]);
  const forward = useCallback(() => {
    requestTraversal(history.requestForward());
  }, [history, requestTraversal]);

  return { back, forward };
}

function useCancelBlockedTraversal(
  history: ReturnType<typeof createMobileNavigationHistory>,
): void {
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
