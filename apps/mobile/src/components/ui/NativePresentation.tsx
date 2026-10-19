import type { ReactElement } from "react";
import { View, type ViewProps } from "react-native";

export interface PresentationSourceProps extends ViewProps {
  readonly children: ReactElement;
  readonly identifier: string;
}

export function PresentationSource({ identifier: _identifier, ...props }: PresentationSourceProps) {
  return <View {...props} />;
}
