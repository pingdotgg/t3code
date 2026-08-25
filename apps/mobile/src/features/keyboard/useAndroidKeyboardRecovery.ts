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

    // The screen may mount after the app has already resumed. In that case
    // there is no future active transition for this instance to observe.
    if (AppState.currentState === "active") {
      setRecoveryState((current) => reduceAndroidKeyboardRecovery(current, "resume"));
    }

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
