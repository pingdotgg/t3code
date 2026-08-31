import type { ReactElement } from "react";
import { View, type ViewProps } from "react-native";

export interface PresentationSourceProps extends ViewProps {
  readonly children: ReactElement;
  /** Stable across remounts so dismissal can find a recycled attachment thumbnail. */
  readonly identifier: string;
}

export interface ZoomTransitionTargetProps extends ViewProps {
  readonly sourceIdentifier?: string;
  readonly colorScheme?: "light" | "dark";
}

/** Registers the view as an iOS zoom or share-sheet origin. */
export function PresentationSource({ identifier: _identifier, ...props }: PresentationSourceProps) {
  return <View {...props} />;
}

/** Place inside a native-stack screen, around the content to align with the source. */
export function ZoomTransitionTarget({
  sourceIdentifier: _sourceIdentifier,
  colorScheme: _colorScheme,
  ...props
}: ZoomTransitionTargetProps) {
  return <View {...props} />;
}
