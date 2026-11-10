import { requireNativeView } from "expo";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import type { VerticalHinge } from "../lib/layout";

interface ObserverProps extends ViewProps {
  readonly onHingeChange: (
    event: NativeSyntheticEvent<
      Partial<VerticalHinge & { readonly windowX: number; readonly isFoldable: boolean }>
    >,
  ) => void;
}

const Observer = requireNativeView<ObserverProps>("T3FoldPosture");

/** Reports a vertical hinge in this view's coordinates while the device is bent like a book. */
export function AndroidHingeObserver(props: {
  /** Receives the hinge in this view's coordinates and in window coordinates. */
  readonly onChange: (
    hinge: VerticalHinge | null,
    windowHinge: VerticalHinge | null,
    isFoldable: boolean,
  ) => void;
}) {
  return (
    <Observer
      pointerEvents="none"
      onHingeChange={({ nativeEvent: { x, width, windowX, isFoldable } }) =>
        x === undefined || width === undefined || windowX === undefined
          ? props.onChange(null, null, isFoldable === true)
          : props.onChange({ x, width }, { x: windowX, width }, isFoldable === true)
      }
      style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
    />
  );
}
