import type { ReactElement } from "react";
import { View, type ViewProps } from "react-native";

export interface PresentationSourceProps extends ViewProps {
  readonly children: ReactElement;
  /** Stable across remounts so dismissal can find a recycled attachment thumbnail. */
  readonly identifier: string;
}

/** Registers the view as an iOS zoom or share-sheet origin. */
export function PresentationSource({ identifier: _identifier, ...props }: PresentationSourceProps) {
  return <View {...props} />;
}
