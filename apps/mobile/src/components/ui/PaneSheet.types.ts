import type { ComponentProps } from "react";
import type { FormSheet } from "react-native-screens";

export type PaneSheetProps = Omit<
  ComponentProps<typeof FormSheet>,
  "prefersGrabberVisible" | "preferredCornerRadius" | "nativeContainerStyle"
>;
