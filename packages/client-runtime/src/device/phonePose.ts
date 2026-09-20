/** Presentation state survives viewport and screen orientation changes. Zoom is relative to the fitted camera. */
export function createPhonePose() {
  let pitch = 0.035;
  let yaw = -0.12;
  let zoom = 1;
  return {
    get pitch() {
      return pitch;
    },
    get yaw() {
      return yaw;
    },
    get zoom() {
      return zoom;
    },
    orbit(deltaX: number, deltaY: number) {
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
      yaw += deltaX * 4;
      pitch = Math.min(0.7, Math.max(-0.7, pitch + deltaY * 3));
    },
    zoomBy(logDelta: number) {
      if (!Number.isFinite(logDelta)) return;
      zoom = Math.exp(Math.min(Math.log(2.2), Math.max(Math.log(0.6), Math.log(zoom) + logDelta)));
    },
    reset() {
      pitch = 0;
      yaw = 0;
      zoom = 1;
    },
  };
}
