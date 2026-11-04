import { StackActions, useNavigation } from "@react-navigation/native";
import { useEffect, useEffectEvent, useRef } from "react";

/**
 * Leaves a terminal screen whose shell exited: to another live terminal of the
 * thread, else back. Screen navigation acts on the top route of the stack, so
 * a shell that exits while another screen is on top waits until its own screen
 * is focused again.
 */
export function useTerminalExitNavigation(target: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly readFallbackTerminalId: () => string | null;
}) {
  const navigation = useNavigation();
  const pendingRef = useRef(false);

  const navigateAway = useEffectEvent(() => {
    const fallbackTerminalId = target.readFallbackTerminalId();
    if (fallbackTerminalId !== null) {
      navigation.dispatch(
        StackActions.replace("ThreadTerminal", {
          environmentId: target.environmentId,
          threadId: target.threadId,
          terminalId: fallbackTerminalId,
        }),
      );
      return;
    }
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: target.environmentId,
        threadId: target.threadId,
      }),
    );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focus subscription for the screen's lifetime; an exit behind another screen navigates when the user returns
  useEffect(
    () =>
      navigation.addListener("focus", () => {
        if (!pendingRef.current) return;
        pendingRef.current = false;
        navigateAway();
      }),
    [navigation],
  );

  return {
    exited: () => {
      if (navigation.isFocused()) {
        navigateAway();
        return;
      }
      pendingRef.current = true;
    },
    /** A shell that runs again before the screen regains focus keeps the screen. */
    restarted: () => {
      pendingRef.current = false;
    },
  };
}
