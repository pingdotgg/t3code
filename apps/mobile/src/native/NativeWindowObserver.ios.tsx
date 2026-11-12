import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

type WindowState = "active" | "closed";

interface ObserverProps extends ViewProps {
  readonly onWindowStateChange: (
    event: NativeSyntheticEvent<{ readonly state: WindowState }>,
  ) => void;
}

function resolveObserver() {
  try {
    const module = requireOptionalNativeModule<{
      readonly ViewPrototypes?: { readonly T3NativeControls_WindowState?: unknown };
    }>("T3NativeControls");
    if (!module?.ViewPrototypes?.T3NativeControls_WindowState) return null;
    return requireNativeView<ObserverProps>("T3NativeControls", "WindowState");
  } catch {
    return null;
  }
}
// Binaries from before multiple windows have no observer and only ever one window.
const Observer = resolveObserver();

/** Reports when the window of the React root it is mounted in becomes the one in use, or closes. */
export function NativeWindowObserver(props: { readonly onChange: (state: WindowState) => void }) {
  return Observer ? (
    <Observer
      pointerEvents="none"
      onWindowStateChange={(event) => props.onChange(event.nativeEvent.state)}
      style={{ position: "absolute", width: 0, height: 0 }}
    />
  ) : null;
}
