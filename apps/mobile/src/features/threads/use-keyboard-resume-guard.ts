import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";

export function useKeyboardResumeGuard(isKeyboardVisible: boolean, keyboardHeight: number) {
  const ownedInputFocused = useRef(false);
  const [keyboardStateSuspect, setKeyboardStateSuspect] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = AppState.addEventListener("change", (state) => {
      // A focused input keeps its keyboard across app switches without another
      // focus or height event. Only distrust a resumed keyboard after blur:
      // Android can lose the hide event if backgrounded during dismissal.
      if (state === "active") setKeyboardStateSuspect(!ownedInputFocused.current);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    setKeyboardStateSuspect(false);
  }, [isKeyboardVisible, keyboardHeight]);

  const onInputFocusChange = useCallback((focused: boolean) => {
    ownedInputFocused.current = focused;
    if (focused) setKeyboardStateSuspect(false);
  }, []);

  return { keyboardStateSuspect, onInputFocusChange };
}
