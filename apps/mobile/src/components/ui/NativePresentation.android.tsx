import { View } from "react-native";

import type { PresentationSourceProps } from "./NativePresentation";

export function PresentationSource({ identifier: _identifier, ...props }: PresentationSourceProps) {
  return <View {...props} />;
}
