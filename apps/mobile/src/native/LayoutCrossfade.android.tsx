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
  // The workspace columns sit on the header color; the snapshot paints it so it hides the new layout.
  const backdrop = processColor(themeColorToNativeColor(useUniwindTheme()["--color-header"]));
  return (
    <NativeLayoutCrossfade
      {...props}
      backdropColor={typeof backdrop === "number" ? backdrop : 0}
      collapsable={false}
      onSnapshot={({ nativeEvent }) => onSnapshot(nativeEvent.request)}
    />
  );
}
