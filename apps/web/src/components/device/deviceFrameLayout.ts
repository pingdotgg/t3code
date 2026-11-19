const IPHONE_CORNER_SHAPE = "superellipse(1.5)";
const supportsContinuousCorners = globalThis.CSS?.supports("corner-shape", IPHONE_CORNER_SHAPE);

export function iphoneFrameCorners(frame: { width: number; height: number }, ratio: number) {
  const extent = Math.min(frame.width, frame.height) * ratio;
  return {
    borderRadius: supportsContinuousCorners ? extent : extent * 0.73,
    cornerShape: supportsContinuousCorners ? IPHONE_CORNER_SHAPE : undefined,
  };
}

export function fitDeviceFrame(aspect: number, width: number, height: number, rightInset: number) {
  const availableWidth = Math.max(0, width - rightInset);
  if (availableWidth === 0 || height === 0) return { width: 0, height: 0 };
  const byHeight = { width: height * aspect, height };
  return byHeight.width <= availableWidth
    ? byHeight
    : { width: availableWidth, height: availableWidth / aspect };
}
