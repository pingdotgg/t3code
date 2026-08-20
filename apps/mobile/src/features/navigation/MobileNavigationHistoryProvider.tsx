import { useLinkTo, useNavigation } from "@react-navigation/native";
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
  type MobileNavigationHistory,
  type MobileNavigationHistorySnapshot,
} from "./mobile-navigation-history";

interface MobileNavigationHistoryValue extends MobileNavigationHistorySnapshot {
  readonly back: () => void;
  readonly forward: () => void;
}

const MobileNavigationHistoryContext = createContext<MobileNavigationHistoryValue | null>(null);

function useSyncVisitedPath(history: MobileNavigationHistory, pathname: string): void {
  useEffect(() => {
    history.visit(pathname);
  }, [history, pathname]);
}

export function MobileNavigationHistoryProvider({
  children,
  pathname,
}: PropsWithChildren<{ readonly pathname: string }>) {
  const navigation = useNavigation();
  const linkTo = useLinkTo();
  const [history] = useState(() => createMobileNavigationHistory(pathname));
  const snapshot = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    history.getSnapshot,
  );
  useSyncVisitedPath(history, pathname);

  const back = useCallback(() => {
    const target = history.back();
    if (!target) {
      return;
    }
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      linkTo(target);
    }
  }, [history, linkTo, navigation]);
  const forward = useCallback(() => {
    const target = history.forward();
    if (target) {
      linkTo(target);
    }
  }, [history, linkTo]);
  const value = useMemo(() => ({ ...snapshot, back, forward }), [back, forward, snapshot]);

  return (
    <MobileNavigationHistoryContext.Provider value={value}>
      {children}
    </MobileNavigationHistoryContext.Provider>
  );
}

export function useMobileNavigationHistory(): MobileNavigationHistoryValue {
  const value = useContext(MobileNavigationHistoryContext);
  if (!value) {
    throw new Error("useMobileNavigationHistory must be used within its provider");
  }
  return value;
}
