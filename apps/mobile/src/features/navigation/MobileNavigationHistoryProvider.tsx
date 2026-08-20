import { useLinkTo } from "@react-navigation/native";
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
  const linkTo = useLinkTo();

  useEffect(() => {
    history.visit(location);
  }, [history, location]);

  const requestTraversal = useCallback(
    (target: ReturnType<typeof history.requestBack>) => {
      if (!target) {
        return;
      }
      linkTo(target.location.pathname);
    },
    [linkTo],
  );

  const back = useCallback(() => {
    requestTraversal(history.requestBack());
  }, [history, requestTraversal]);
  const forward = useCallback(() => {
    requestTraversal(history.requestForward());
  }, [history, requestTraversal]);

  return { back, forward };
}

export function useMobileNavigationHistory(): MobileNavigationHistoryValue {
  const value = useContext(MobileNavigationHistoryContext);
  if (!value) {
    throw new Error("useMobileNavigationHistory must be used within its provider");
  }
  return value;
}
