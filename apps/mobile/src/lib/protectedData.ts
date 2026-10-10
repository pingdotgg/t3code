import { requireOptionalNativeModule } from "expo";
import { AppState } from "react-native";

const NativeControls = requireOptionalNativeModule<{
  readonly isProtectedDataAvailable?: () => Promise<boolean>;
}>("T3NativeControls");

let protectedDataAvailable: Promise<void> | undefined;

/**
 * Waits until the keychain and the app's database files can be read. iOS can
 * launch the app in the background while the device is locked, for example for
 * a Live Activity after a restart, and those reads fail until it is unlocked.
 * A launch like that waits until the app comes to the foreground.
 *
 * Only the launch is checked: once this resolves it stays resolved, even if the
 * device locks again, so it does not protect reads made later.
 */
export function whenProtectedDataAvailable(): Promise<void> {
  protectedDataAvailable ??= new Promise((resolve) => {
    const isAvailable = NativeControls?.isProtectedDataAvailable;
    // Only an unlocked device can bring the app to the foreground, so only a
    // background launch needs to ask.
    if (isAvailable === undefined || AppState.currentState !== "background") {
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
    isAvailable().then((available) => {
      if (available) done();
    }, done);
  });
  return protectedDataAvailable;
}
