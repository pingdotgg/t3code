import { requireOptionalNativeModule } from "expo";
import { AppState, Platform } from "react-native";

const NativeControls = requireOptionalNativeModule<{
  readonly isProtectedDataAvailable?: () => Promise<boolean>;
}>("T3NativeControls");

let protectedDataAvailable: Promise<void> | undefined;

// A locked iOS background launch cannot read startup storage. Cache readiness
// for this launch only; later device locks do not pause an initialized runtime.
export function whenProtectedDataAvailable(): Promise<void> {
  protectedDataAvailable ??= new Promise((resolve) => {
    const isAvailable = NativeControls?.isProtectedDataAvailable;
    if (Platform.OS !== "ios" || AppState.currentState === "active") {
      resolve();
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") done();
    });
    function done() {
      subscription.remove();
      resolve();
    }
    isAvailable?.().then(
      (available) => {
        if (available) done();
      },
      () => {
        // A failed check does not establish readiness; activation still can.
      },
    );
  });
  return protectedDataAvailable;
}
