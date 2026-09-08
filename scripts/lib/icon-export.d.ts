export declare const WINDOWS_ICON_SIZES: readonly [16, 24, 32, 48, 64, 128, 256];
export interface PngIconImage {
  readonly size: number;
  readonly contents: Buffer;
}
export declare function readPngDimensions(contents: Buffer): {
  readonly width: number;
  readonly height: number;
};
/** Encodes PNG renditions directly into a modern, multi-resolution ICO file. */
export declare function encodePngIco(images: ReadonlyArray<PngIconImage>): Buffer;
