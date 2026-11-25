import type { FrameRegion } from "./displayViewport.ts";

/**
 * A synchronous, borrowed frame. The producer releases its source after present returns.
 * `width` and `height` are the shown size: all of the source, or `region` of it when given.
 */
export interface DeviceFrameSink {
  readonly present: (
    source: CanvasImageSource,
    width: number,
    height: number,
    region?: FrameRegion,
  ) => boolean;
}

export function createCanvasFrameSink(
  canvas: HTMLCanvasElement,
  onFrame?: (width: number, height: number) => void,
): DeviceFrameSink {
  return {
    present(source, width, height, region) {
      const context = canvas.getContext("2d");
      if (!context) return false;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      if (region)
        context.drawImage(
          source,
          region.x,
          region.y,
          region.width,
          region.height,
          0,
          0,
          width,
          height,
        );
      else context.drawImage(source, 0, 0, width, height);
      onFrame?.(width, height);
      return true;
    },
  };
}
