import { useLinkTo } from "@react-navigation/native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import {
  createMobileNavigationHistory,
  type MobileNavigationHistorySnapshot,
} from "./mobile-navigation-history";

interface MobileNavigationHistoryValue extends MobileNavigationHistorySnapshot {
  readonly back: () => void;
  readonly forward: () => void;
}

const MobileNavigationHistoryContext = createContext<MobileNavigationHistoryValue | null>(null);

export function MobileNavigationHistoryProvider({
  children,
  pathname,
  transitionKey,
}: PropsWithChildren<{ readonly pathname: string; readonly transitionKey: string }>) {
  const [history] = useState(() => createMobileNavigationHistory({ pathname, transitionKey }));
  const snapshot = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    history.getSnapshot,
  );
  const { back, forward } = useMobileNavigationHistoryCoordinator(history, pathname, transitionKey);
  const value = useMemo(() => ({ ...snapshot, back, forward }), [back, forward, snapshot]);

  return (
    <MobileNavigationHistoryContext.Provider value={value}>
      {children}
    </MobileNavigationHistoryContext.Provider>
  );
}

function useMobileNavigationHistoryCoordinator(
  history: ReturnType<typeof createMobileNavigationHistory>,
  pathname: string,
  transitionKey: string,
) {
  const linkTo = useLinkTo();
  const pendingTraversalPathRef = useRef<string | null>(null);
  const pendingTraversalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const traversal = pendingTraversalPathRef.current === pathname;
    if (traversal) {
      pendingTraversalPathRef.current = null;
      if (pendingTraversalTimeoutRef.current !== null) {
        clearTimeout(pendingTraversalTimeoutRef.current);
        pendingTraversalTimeoutRef.current = null;
      }
    }
    history.visit({ pathname, transitionKey }, { traversal });
  }, [history, pathname, transitionKey]);

  useEffect(
    () => () => {
      if (pendingTraversalTimeoutRef.current !== null) {
        clearTimeout(pendingTraversalTimeoutRef.current);
      }
    },
    [],
  );

  const requestTraversal = useCallback(
    (target: string | null) => {
      if (!target) {
        return;
      }
      pendingTraversalPathRef.current = target;
      if (pendingTraversalTimeoutRef.current !== null) {
        clearTimeout(pendingTraversalTimeoutRef.current);
      }
      pendingTraversalTimeoutRef.current = setTimeout(() => {
        if (pendingTraversalPathRef.current === target) {
          pendingTraversalPathRef.current = null;
        }
        pendingTraversalTimeoutRef.current = null;
      }, 1_000);
      linkTo(target);
    },
    [linkTo],
  );

  const back = useCallback(() => {
    requestTraversal(history.backTarget());
  }, [history, requestTraversal]);
  const forward = useCallback(() => {
    requestTraversal(history.forwardTarget());
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
