import { View } from "react-native";

import type { PresentationSourceProps } from "./NativePresentation";

export function PresentationSource({
  identifier: _identifier,
  fallbackIdentifier: _fallbackIdentifier,
  ...props
}: PresentationSourceProps) {
  return <View {...props} />;
}
