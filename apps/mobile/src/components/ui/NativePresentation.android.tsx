import { View } from "react-native";

import type { PresentationSourceProps } from "./NativePresentation";
import { defineNativePluginFeature } from "../../plugins/features";

export const PresentationSource = defineNativePluginFeature(
  "native.components.ui.native-presentation.presentation-source",
  BuiltinPresentationSource,
);

function BuiltinPresentationSource({ identifier: _identifier, ...props }: PresentationSourceProps) {
  return <View {...props} />;
}
