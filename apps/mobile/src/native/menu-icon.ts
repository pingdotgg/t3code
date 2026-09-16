import { PixelRatio, type ImageSourcePropType } from "react-native";

/** Point size UIKit draws menu row images at; matches the SF Symbol rows beside it. */
export const MENU_ICON_SIZE = 20;

/**
 * Image source for a bitmap icon (a project favicon) in a native iOS menu.
 * The size and scale let React Native's image loader decode straight to the
 * row's point size instead of handing UIMenu a full-size favicon.
 */
export function menuIconImageSource(uri: string): ImageSourcePropType {
  return { uri, width: MENU_ICON_SIZE, height: MENU_ICON_SIZE, scale: PixelRatio.get() };
}
