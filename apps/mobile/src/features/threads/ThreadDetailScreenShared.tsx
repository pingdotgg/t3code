import { Platform } from "react-native";
import Animated, { Easing } from "react-native-reanimated";
import { Atom } from "effect/reactivity";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { createThreadVisitTracker } from "@t3tools/client-runtime/state/thread-visits";
import type { RunStopPresentation } from "@t3tools/client-runtime/state/thread-execution";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { USER_INPUT_TOGGLE_DURATION_MS } from "./pendingUserInputLayout";

export const ComposerPanels = Platform.OS === "android" ? Animated.ScrollView : Animated.View;
export const USAGE_LIMITS_PANEL_GAP = 12;
export const USAGE_LIMITS_PANEL_MIN_HEIGHT = 44;

export const USER_INPUT_TOGGLE_TIMING = {
  duration: USER_INPUT_TOGGLE_DURATION_MS,
  easing: Easing.out(Easing.cubic),
};

// A scheduled wake can happen without a newer server update, so the tracker
// is told when one takes effect. The shell's updatedAt ticks while a run
// streams; the tracker follows it outside React.
export const wakeAwareVisitShell = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) => {
    const shell = get(environmentThreadShells.threadShellAtom(ref));
    if (shell === null) return null;
    const nowMs = Date.now();
    const wokeAt = threadWokeAt(shell, { now: new Date(nowMs).toISOString() });
    const wakeAtMs = shell.snoozedUntil == null ? NaN : Date.parse(shell.snoozedUntil);
    if (wokeAt === null && wakeAtMs > nowMs) {
      const timer = setTimeout(
        () => get.refreshSelf(),
        Math.min(wakeAtMs - nowMs + 50, 2_147_483_647),
      );
      get.addFinalizer(() => clearTimeout(timer));
    }
    return { ...shell, wokeAt };
  }).pipe(Atom.withLabel(`mobile-thread-visit-shell:${key}`));
});

export const threadVisitTracker = createThreadVisitTracker({
  threadShellAtom: (ref) => wakeAwareVisitShell(threadKey(ref)),
  visit: threadEnvironment.visit,
});

// Past the composer's 180 ms height animation.
export const COMPOSER_HEIGHT_SETTLE_MS = 220;
export const NO_RUN_STOP_ATOM = Atom.make<RunStopPresentation | null>(null).pipe(
  Atom.withLabel("mobile-thread-run-stop:empty"),
);

// Connection failures survive retries and app suspension.
export const RECONNECT_ERROR_DELAY_MS = 5_000;
