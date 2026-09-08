// QML library: keep geometry in compositor logical coordinates, including mixed-DPI outputs.
// eslint-disable-next-line no-unused-vars -- Exported by QML's JavaScript module loader.
function destination(windows, pid, title, relative) {
  const matching = Array.from(windows).filter(
    (window) => window.pid === pid && window.caption === title,
  );
  if (matching.length !== 1) throw new Error("Capture destination is ambiguous or missing");
  const window = matching[0];
  if (window.minimized) throw new Error("Capture destination is hidden");
  const bounds = window.clientGeometry;
  const { x, y, width, height } = relative;
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > 1.01 ||
    y + height > 1.01
  ) {
    throw new Error("Invalid capture destination");
  }
  return {
    window,
    frame: {
      x: bounds.x + x * bounds.width,
      y: bounds.y + y * bounds.height,
      width: width * bounds.width,
      height: height * bounds.height,
    },
  };
}
