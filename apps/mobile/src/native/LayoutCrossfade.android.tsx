import { requireNativeView } from "expo";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

import type { LayoutCrossfadeProps } from "./LayoutCrossfade";

interface NativeLayoutCrossfadeProps extends ViewProps {
  readonly snapshotRequest: number;
  readonly fadeRequest: number;
  readonly fadeDuration: number;
  readonly onSnapshot: (event: NativeSyntheticEvent<{ readonly request: number }>) => void;
}

const NativeLayoutCrossfade = requireNativeView<NativeLayoutCrossfadeProps>("T3LayoutCrossfade");

export function LayoutCrossfade({ onSnapshot, ...props }: LayoutCrossfadeProps) {
  return (
    <NativeLayoutCrossfade
      {...props}
      collapsable={false}
      onSnapshot={({ nativeEvent }) => onSnapshot(nativeEvent.request)}
    />
  );
}
