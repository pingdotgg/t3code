export const DEVICE_CONTROLS_RAIL_WIDTH = 56;

/** Leave room on the right beside a height-fitted device. */
export function deviceControlsLayout(options: {
  width: number;
  height: number;
  aspect: number;
  phone: boolean;
  android: boolean;
}): "rail" | "header" {
  // The default 3D camera leaves breathing room around the phone body. Keep
  // placement independent of orbit/zoom so gestures never move the controls.
  const deviceWidth = Math.min(
    options.width,
    options.height * options.aspect * (options.phone ? 0.86 : 1),
  );
  const minimumHeight = (options.phone ? 400 : 368) + (options.android ? 64 : 0);
  return options.width - deviceWidth >= DEVICE_CONTROLS_RAIL_WIDTH &&
    options.height >= minimumHeight
    ? "rail"
    : "header";
}
