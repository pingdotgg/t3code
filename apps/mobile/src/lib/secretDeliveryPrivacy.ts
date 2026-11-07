import { Platform } from "react-native";

const CAPTURE_KEY = "secret-delivery";
let owners = 0;
let transition = Promise.resolve();

// Expo's iOS app-switcher protection is global, so serialize first acquisition and last release.
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = transition.then(operation);
  transition = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Resolves only once native snapshot protection is active; each revealed card owns one lease. */
export function acquireSecretDeliveryPrivacy(): Promise<() => Promise<void>> {
  return serialize(async () => {
    // Older dev clients must fail closed on Reveal without breaking masked thread screens.
    const capture = await import("expo-screen-capture");
    if (owners === 0) {
      await capture.preventScreenCaptureAsync(CAPTURE_KEY);
      if (Platform.OS === "ios") {
        try {
          await capture.enableAppSwitcherProtectionAsync(1);
        } catch (error) {
          await capture.allowScreenCaptureAsync(CAPTURE_KEY);
          throw error;
        }
      }
    }
    owners += 1;
    let released = false;
    return () =>
      serialize(async () => {
        if (released) return;
        released = true;
        owners -= 1;
        if (owners !== 0) return;
        if (Platform.OS === "ios") {
          await capture.disableAppSwitcherProtectionAsync();
        }
        await capture.allowScreenCaptureAsync(CAPTURE_KEY);
      });
  });
}
