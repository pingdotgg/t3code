import type { SnapShotAccessibilityNode, SnapShotSource } from "@t3tools/contracts";
import { resizeSnapShotSource } from "~/lib/snapShotSource";
import type { ImageEditorDocument } from "./imageEditorDocument";

export function editedImageSource(
  source: SnapShotSource | undefined,
  document: ImageEditorDocument,
): SnapShotSource | undefined {
  if (!source) return undefined;
  const frame = document.crop ?? { x: 0, y: 0, width: document.width, height: document.height };
  const imageSize = {
    width: Math.max(1, Math.round(frame.width)),
    height: Math.max(1, Math.round(frame.height)),
  };
  const cropped =
    frame.x !== 0 ||
    frame.y !== 0 ||
    frame.width !== document.width ||
    frame.height !== document.height;
  if (!cropped) return resizeSnapShotSource(source, imageSize);

  const next = { ...source };
  delete next.accessibleText;
  delete next.accessibility;
  const accessibility = source.accessibility;
  if (accessibility?.format !== "element-tree") return next;
  const scaleX = document.width / accessibility.imageSize.width;
  const scaleY = document.height / accessibility.imageSize.height;
  const outputScaleX = imageSize.width / frame.width;
  const outputScaleY = imageSize.height / frame.height;

  const cropNode = (node: SnapShotAccessibilityNode): SnapShotAccessibilityNode | null => {
    const children = node.children.flatMap((child) => {
      const croppedChild = cropNode(child);
      return croppedChild ? [croppedChild] : [];
    });
    let bounds = null;
    let fullyVisible = false;
    if (node.bounds) {
      const sourceLeft = node.bounds.x * scaleX;
      const sourceTop = node.bounds.y * scaleY;
      const sourceRight = (node.bounds.x + node.bounds.width) * scaleX;
      const sourceBottom = (node.bounds.y + node.bounds.height) * scaleY;
      const left = Math.max(frame.x, sourceLeft);
      const top = Math.max(frame.y, sourceTop);
      const right = Math.min(frame.x + frame.width, sourceRight);
      const bottom = Math.min(frame.y + frame.height, sourceBottom);
      const x = Math.round((left - frame.x) * outputScaleX);
      const y = Math.round((top - frame.y) * outputScaleY);
      const endX = Math.round((right - frame.x) * outputScaleX);
      const endY = Math.round((bottom - frame.y) * outputScaleY);
      if (endX > x && endY > y) {
        bounds = { x, y, width: endX - x, height: endY - y };
        fullyVisible =
          left === sourceLeft &&
          top === sourceTop &&
          right === sourceRight &&
          bottom === sourceBottom;
      }
    }
    if (!bounds && children.length === 0) return null;
    const croppedNode = { ...node, bounds, children };
    if (!fullyVisible) {
      // Text on partially clipped or unlocated nodes cannot be attributed to the cropped pixels.
      delete croppedNode.name;
      delete croppedNode.value;
      delete croppedNode.description;
    }
    return croppedNode;
  };
  const root = cropNode(accessibility.root);
  if (root) next.accessibility = { ...accessibility, imageSize, root };
  return next;
}
