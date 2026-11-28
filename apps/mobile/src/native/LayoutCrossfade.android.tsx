import { requireNativeView } from "expo";
import { processColor, type NativeSyntheticEvent, type ViewProps } from "react-native";

import { themeColorToNativeColor } from "../lib/mobileTheme";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import type { LayoutCrossfadeProps } from "./LayoutCrossfade";

interface NativeLayoutCrossfadeProps extends ViewProps {
  readonly snapshotRequest: number;
  readonly fadeRequest: number;
  readonly fadeDuration: number;
  readonly backdropColor: number;
  readonly onSnapshot: (event: NativeSyntheticEvent<{ readonly request: number }>) => void;
}

const NativeLayoutCrossfade = requireNativeView<NativeLayoutCrossfadeProps>("T3LayoutCrossfade");

export function LayoutCrossfade({ onSnapshot, ...props }: LayoutCrossfadeProps) {
  // The snapshot covers the whole column, wider than the pane; the pane's own color keeps the area
  // it didn't draw from showing as a different surface while the column slides.
  const backdrop = processColor(themeColorToNativeColor(useUniwindTheme()["--color-screen"]));
  return (
    <NativeLayoutCrossfade
      {...props}
      backdropColor={typeof backdrop === "number" ? backdrop : 0}
      collapsable={false}
      onSnapshot={({ nativeEvent }) => onSnapshot(nativeEvent.request)}
    />
  );
}
