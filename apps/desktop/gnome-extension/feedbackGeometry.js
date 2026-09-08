// PID comes from the bus daemon, not from the caller. Never focus a different T3 process.
export function findCaptureDestination(windows, pid, title) {
  const owned = windows.filter((window) => window.get_pid() === pid);
  const matching = owned.filter((window) => window.get_title() === title);
  if (matching.length === 1) return matching[0];
  return owned.length === 1 ? owned[0] : undefined;
}

export function captureDestinationFrame(relative, bounds) {
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
    throw new Error("Invalid capture animation destination.");
  }
  return {
    x: bounds.x + x * bounds.width,
    y: bounds.y + y * bounds.height,
    width: width * bounds.width,
    height: height * bounds.height,
  };
}
