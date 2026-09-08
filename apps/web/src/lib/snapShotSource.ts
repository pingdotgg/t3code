import type { SnapShotAccessibilityNode, SnapShotSource } from "@t3tools/contracts";

/** Keep image-relative accessibility coordinates aligned with a recompressed attachment. */
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
