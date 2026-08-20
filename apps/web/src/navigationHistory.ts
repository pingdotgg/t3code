import { useRouter } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

import {
  navigationHistoryFor,
  type NavigationHistory,
  type NavigationHistorySnapshot,
} from "./navigationHistoryStore";

export function useNavigationHistory(): NavigationHistorySnapshot &
  Pick<NavigationHistory, "back" | "forward"> {
  const router = useRouter();
  const history = navigationHistoryFor(router.history);
  const snapshot = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    history.getSnapshot,
  );
  return {
    ...snapshot,
    back: history.back,
    forward: history.forward,
  };
}
