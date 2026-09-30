export function fitDeviceFrame(aspect: number, width: number, height: number, rightInset = 0) {
  const availableWidth = Math.max(0, width - rightInset);
  if (availableWidth === 0 || height === 0) return { width: 0, height: 0 };
  const byHeight = { width: height * aspect, height };
  return byHeight.width <= availableWidth
    ? byHeight
    : { width: availableWidth, height: availableWidth / aspect };
}
