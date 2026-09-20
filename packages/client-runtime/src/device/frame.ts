/** A synchronous, borrowed frame. The producer releases its source after present returns. */
export interface DeviceFrameSink {
  readonly present: (source: CanvasImageSource, width: number, height: number) => void;
}

/** Retains the latest frame in a canvas; consumers can invalidate textures after each draw. */
export function createCanvasFrameSink(
  canvas: HTMLCanvasElement,
  onFrame?: (width: number, height: number) => void,
): DeviceFrameSink {
  return {
    present(source, width, height) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      canvas.getContext("2d")?.drawImage(source, 0, 0, width, height);
      onFrame?.(width, height);
    },
  };
}
