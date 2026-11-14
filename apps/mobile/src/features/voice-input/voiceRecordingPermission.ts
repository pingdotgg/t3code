import { requestRecordingPermissionsAsync } from "expo-audio";
import { AppState, Platform } from "react-native";

export function createVoiceRecordingPermission(onBackground: () => void) {
  let requesting = false;
  let disposed = false;
  let resume: (() => void) | null = null;
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") resume?.();
    if (state === "background" && !requesting) onBackground();
  });
  return {
    requestPermission: async () => {
      if (Platform.OS !== "android") return requestRecordingPermissionsAsync();
      // Android's permission activity backgrounds the app; resume before preparing Google's model.
      requesting = true;
      try {
        const permission = await requestRecordingPermissionsAsync();
        if (!disposed && AppState.currentState !== "active") {
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        }
        return permission;
      } finally {
        requesting = false;
        resume = null;
      }
    },
    dispose: () => {
      disposed = true;
      subscription.remove();
      resume?.();
    },
  };
}
