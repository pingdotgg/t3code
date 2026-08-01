export const MOBILE_PREVIEW_CAPTURE_MAX_WIDTH = 1_280;
export const MOBILE_PREVIEW_CAPTURE_MAX_PIXELS = 2_000_000;
export const MOBILE_PREVIEW_CAPTURE_RETRY_SCALE = 0.72;
export const MOBILE_PREVIEW_CAPTURE_MAX_ATTEMPTS = 4;

export interface MobilePreviewCaptureLayout {
  readonly width: number;
  readonly height: number;
}

export interface MobilePreviewCaptureLogicalSize {
  readonly width: number;
  readonly height: number;
}

export function mobilePreviewCaptureLogicalSize(input: {
  readonly layout: MobilePreviewCaptureLayout;
  readonly pixelRatio: number;
  readonly attempt: number;
  readonly platform: "android" | "ios";
}): MobilePreviewCaptureLogicalSize | null {
  const { height, width } = input.layout;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(input.pixelRatio) ||
    width <= 0 ||
    height <= 0 ||
    input.pixelRatio <= 0 ||
    !Number.isInteger(input.attempt) ||
    input.attempt < 0
  ) {
    return null;
  }
  const physicalWidth = width * input.pixelRatio;
  const physicalHeight = height * input.pixelRatio;
  const capScale = Math.min(
    1,
    MOBILE_PREVIEW_CAPTURE_MAX_WIDTH / physicalWidth,
    Math.sqrt(MOBILE_PREVIEW_CAPTURE_MAX_PIXELS / (physicalWidth * physicalHeight)),
  );
  const retryScale = MOBILE_PREVIEW_CAPTURE_RETRY_SCALE ** input.attempt;
  const scale = Math.min(1, capScale * retryScale);
  if (scale >= 0.999 && input.attempt === 0) return null;
  // view-shot interprets iOS options as points and renders at screen scale.
  // Android interprets the same options as final bitmap pixels.
  const optionUnitScale = input.platform === "android" ? input.pixelRatio : 1;
  return {
    width: Math.max(1, Math.floor(width * scale * optionUnitScale)),
    height: Math.max(1, Math.floor(height * scale * optionUnitScale)),
  };
}

export function mobilePreviewScreenshotScale(input: {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): number | null {
  if (
    !Number.isFinite(input.imageWidth) ||
    !Number.isFinite(input.imageHeight) ||
    !Number.isFinite(input.viewportWidth) ||
    !Number.isFinite(input.viewportHeight) ||
    input.imageWidth <= 0 ||
    input.imageHeight <= 0 ||
    input.viewportWidth <= 0 ||
    input.viewportHeight <= 0
  ) {
    return null;
  }
  const imageAspect = input.imageWidth / input.imageHeight;
  const viewportAspect = input.viewportWidth / input.viewportHeight;
  if (Math.abs(imageAspect / viewportAspect - 1) > 0.05) return null;
  return input.imageWidth / input.viewportWidth;
}
