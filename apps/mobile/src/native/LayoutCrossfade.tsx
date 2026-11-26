import { View, type ViewProps } from "react-native";

export interface LayoutCrossfadeProps extends ViewProps {
  /** A new value snapshots the content on top and calls `onSnapshot` with it. */
  readonly snapshotRequest: number;
  /** A new value fades the snapshot out; commit it with the layout change. */
  readonly fadeRequest: number;
  readonly fadeDuration: number;
  readonly onSnapshot: (request: number) => void;
}

/** Android cross-dissolves a layout change; elsewhere the platform animates its own columns. */
export function LayoutCrossfade({
  snapshotRequest: _snapshotRequest,
  fadeRequest: _fadeRequest,
  fadeDuration: _fadeDuration,
  onSnapshot: _onSnapshot,
  ...props
}: LayoutCrossfadeProps) {
  return <View {...props} />;
}
