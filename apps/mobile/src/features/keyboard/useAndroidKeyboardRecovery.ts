import { useCallback, useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { KeyboardEvents } from "react-native-keyboard-controller";

import {
  getInitialAndroidKeyboardRecoveryState,
  reduceAndroidKeyboardRecovery,
  type AndroidKeyboardRecoveryState,
} from "./androidKeyboardRecovery";

export function useAndroidKeyboardRecovery(): {
  readonly isQuarantined: boolean;
  readonly markInputFocused: () => void;
} {
  // A surface mounted while the app is already active has no future resume
  // transition to observe, so it starts quarantined. Re-applying "resume" in
  // the mount effect would clobber an autoFocus release that landed first.
  const [recoveryState, setRecoveryState] = useState<AndroidKeyboardRecoveryState>(() =>
    getInitialAndroidKeyboardRecoveryState({
      isAndroid: Platform.OS === "android",
      isAppActive: AppState.currentState === "active",
    }),
  );

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }

    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setRecoveryState((current) => reduceAndroidKeyboardRecovery(current, "resume"));
      }
    });
    const keyboardShowSubscription = KeyboardEvents.addListener("keyboardWillShow", () => {
      setRecoveryState((current) => reduceAndroidKeyboardRecovery(current, "keyboard-show"));
    });

    return () => {
      appStateSubscription.remove();
      keyboardShowSubscription.remove();
    };
  }, []);

  const markInputFocused = useCallback(() => {
    setRecoveryState((current) => reduceAndroidKeyboardRecovery(current, "input-focus"));
  }, []);

  return {
    isQuarantined: recoveryState === "quarantined",
    markInputFocused,
  };
}
