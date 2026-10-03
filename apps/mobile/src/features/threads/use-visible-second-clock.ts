import { useIsFocused } from "@react-navigation/native";
import { useEffect, useLayoutEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * Wall clock for elapsed-time labels, advanced once a second only while
 * `enabled`, the screen is focused, and the app is active. Retained routes stay
 * mounted when hidden, so an ungated interval would keep re-rendering them.
 * The clock re-reads the time before paint when ticking resumes, so a label
 * never shows the moment it paused.
 */
export function useVisibleSecondClock(enabled: boolean): number {
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    // A change between the first render and this subscription has no event to replay.
    // oxlint-disable-next-line react/set-state-in-effect -- Syncs state the listener missed.
    setAppActive(AppState.currentState === "active");
    return () => subscription.remove();
  }, []);
  const ticking = enabled && focused && appActive;
  useLayoutEffect(() => {
    if (!ticking) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Resuming reads the clock that stood still.
    setNowMs(Date.now());
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(intervalId);
  }, [ticking]);
  return nowMs;
}
