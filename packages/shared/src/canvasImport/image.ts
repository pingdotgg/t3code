import { type ImportBuilder, baseName } from "./common.ts";

/** Preserves an exported design as one image layer, with its source asset bytes. */
export function importImage(builder: ImportBuilder, fileName: string, input: Uint8Array) {
  const asset = builder.addImageAsset(`import:${fileName}`, input, /\.svg$/i.test(fileName));
  if (!asset) throw new Error("Unsupported image data; use PNG, JPEG, WebP, GIF, or SVG");
  const { width, height } = asset;
  if (!width || !height) throw new Error("The image has no readable dimensions");
  if (asset.mimeType === "image/svg+xml")
    builder.warn("SVG was preserved as one image layer; its internal paths are not editable");
  builder.add(
    {
      type: "image",
      name: baseName(fileName),
      x: 0,
      y: 0,
      width,
      height,
      fills: [{ type: "image", assetId: asset.id, fit: "fill" }],
    },
    null,
  );
  if (asset.mimeType === "image/gif") builder.warn("GIF images use their first frame");
}
