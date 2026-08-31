import { requireNativeView } from "expo";
import type { ComponentType } from "react";
import type { PresentationSourceProps, ZoomTransitionTargetProps } from "./NativePresentation";

const NativeSource: ComponentType<PresentationSourceProps> = requireNativeView(
  "T3NativeControls",
  "PresentationSource",
);

export function PresentationSource(props: PresentationSourceProps) {
  return <NativeSource {...props} collapsableChildren={false} />;
}

export const ZoomTransitionTarget: ComponentType<ZoomTransitionTargetProps> = requireNativeView(
  "T3NativeControls",
  "ZoomTransitionTarget",
);
