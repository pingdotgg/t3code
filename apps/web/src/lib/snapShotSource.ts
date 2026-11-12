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

/** Re-anchors element bounds to a crop of the captured image, dropping text outside it. */
export function cropSnapShotSource(
  source: SnapShotSource,
  crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): SnapShotSource {
  // Window-wide text can't be attributed to the crop, so it is dropped rather than leaked.
  const { accessibleText: _accessibleText, accessibility, ...rest } = source;
  if (accessibility?.format !== "element-tree") return rest;
  const cropBounds = (bounds: SnapShotAccessibilityNode["bounds"]) => {
    if (!bounds) return null;
    const x = Math.max(0, bounds.x - crop.x);
    const y = Math.max(0, bounds.y - crop.y);
    const right = Math.min(crop.width, bounds.x + bounds.width - crop.x);
    const bottom = Math.min(crop.height, bounds.y + bounds.height - crop.y);
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  };
  const cropNode = (node: SnapShotAccessibilityNode): SnapShotAccessibilityNode[] => {
    const children = node.children.flatMap(cropNode);
    if (!node.bounds)
      return children.length > 0 ? [{ role: node.role, bounds: null, children }] : [];
    const bounds = cropBounds(node.bounds);
    return bounds ? [{ ...node, bounds, children }] : children;
  };
  const root = accessibility.root;
  return {
    ...rest,
    accessibility: {
      ...accessibility,
      imageSize: { width: crop.width, height: crop.height },
      root: { ...root, bounds: cropBounds(root.bounds), children: root.children.flatMap(cropNode) },
    },
  };
}
