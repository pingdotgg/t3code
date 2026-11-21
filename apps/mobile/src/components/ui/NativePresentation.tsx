import { requireNativeView } from "expo";
import type { ComponentType, ReactElement } from "react";
import type { ViewProps } from "react-native";
import { defineNativePluginFeature } from "../../plugins/features";

export const PresentationSource = defineNativePluginFeature(
  "native.components.ui.native-presentation.presentation-source",
  BuiltinPresentationSource,
);

export interface PresentationSourceProps extends ViewProps {
  readonly children: ReactElement;
  readonly identifier: string;
}

const NativeSource: ComponentType<PresentationSourceProps> = requireNativeView(
  "T3NativeControls",
  "PresentationSource",
);

function BuiltinPresentationSource(props: PresentationSourceProps) {
  return <NativeSource {...props} collapsableChildren={false} />;
}
