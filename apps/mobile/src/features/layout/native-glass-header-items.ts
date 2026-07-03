type NativeGlassHeaderItem = {
  readonly type: "button" | "menu";
  readonly glassEffect?: boolean;
  readonly hidesSharedBackground?: boolean;
  readonly sharesBackground?: boolean;
  readonly variant?: "plain" | "done" | "prominent";
  readonly width?: number;
};

/**
 * iOS 26/27 Mail-style header controls need the native glass button
 * shared background configuration when they are not part of a larger toolbar.
 * Do not enable `glassEffect` for normal bar-button items: react-native-screens
 * renders that as a custom UIButton, which creates a second skinny capsule.
 */
export function withNativeGlassHeaderItem<T extends NativeGlassHeaderItem>(
  item: T,
  options: {
    readonly hidesSharedBackground?: boolean;
    readonly sharesBackground?: boolean;
    readonly width?: number;
  } = {},
): T {
  const sharesBackground = options.sharesBackground ?? item.sharesBackground ?? true;
  return {
    ...item,
    glassEffect: item.glassEffect ?? false,
    hidesSharedBackground: options.hidesSharedBackground ?? item.hidesSharedBackground ?? false,
    sharesBackground,
    variant: item.variant ?? "plain",
    width: options.width ?? item.width,
  } as T;
}
