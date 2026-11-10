import type { SnapShotAccessibilityNode, SnapShotSource } from "@t3tools/contracts";

export function resizeSnapShotSource(
  source: SnapShotSource,
  imageSize?: { readonly width: number; readonly height: number },
): SnapShotSource {
  const accessibility = source.accessibility;
  if (
    !imageSize ||
    accessibility?.format !== "element-tree" ||
    (imageSize.width === accessibility.imageSize.width &&
      imageSize.height === accessibility.imageSize.height)
  )
    return source;

  const scaleX = imageSize.width / accessibility.imageSize.width;
  const scaleY = imageSize.height / accessibility.imageSize.height;
  const resizeNode = (node: SnapShotAccessibilityNode): SnapShotAccessibilityNode => {
    let bounds = null;
    if (node.bounds) {
      const x = Math.min(imageSize.width, Math.round(node.bounds.x * scaleX));
      const y = Math.min(imageSize.height, Math.round(node.bounds.y * scaleY));
      const right = Math.min(
        imageSize.width,
        Math.round((node.bounds.x + node.bounds.width) * scaleX),
      );
      const bottom = Math.min(
        imageSize.height,
        Math.round((node.bounds.y + node.bounds.height) * scaleY),
      );
      if (right > x && bottom > y) bounds = { x, y, width: right - x, height: bottom - y };
    }
    return { ...node, bounds, children: node.children.map(resizeNode) };
  };
  return {
    ...source,
    accessibility: { ...accessibility, imageSize, root: resizeNode(accessibility.root) },
  };
}

/** Re-anchors element bounds to a crop of the captured image, dropping nodes outside it. */
export function cropSnapShotSource(
  source: SnapShotSource,
  crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): SnapShotSource {
  const accessibility = source.accessibility;
  if (accessibility?.format !== "element-tree") return source;
  const cropNode = (node: SnapShotAccessibilityNode): SnapShotAccessibilityNode => {
    let bounds = null;
    if (node.bounds) {
      const x = Math.max(0, node.bounds.x - crop.x);
      const y = Math.max(0, node.bounds.y - crop.y);
      const right = Math.min(crop.width, node.bounds.x + node.bounds.width - crop.x);
      const bottom = Math.min(crop.height, node.bounds.y + node.bounds.height - crop.y);
      if (right > x && bottom > y) bounds = { x, y, width: right - x, height: bottom - y };
    }
    return { ...node, bounds, children: node.children.map(cropNode) };
  };
  return {
    ...source,
    accessibility: {
      ...accessibility,
      imageSize: { width: crop.width, height: crop.height },
      root: cropNode(accessibility.root),
    },
  };
}
