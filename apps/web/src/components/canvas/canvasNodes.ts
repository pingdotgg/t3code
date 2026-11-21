import type { CanvasDocument, CanvasNode, CanvasOp, CanvasText } from "@t3tools/contracts";
import { makeCanvasNodeId } from "@t3tools/shared/canvasOps";

export type CanvasShapeTool = "frame" | "rect" | "ellipse" | "text";

const LABELS: Record<CanvasShapeTool, string> = {
  frame: "Frame",
  rect: "Rectangle",
  ellipse: "Ellipse",
  // oxlint-disable-next-line t3code/no-untranslated-copy -- default layer name stored in the canvas document
  text: "Text",
};

export function makeShapeNode(
  doc: CanvasDocument,
  tool: CanvasShapeTool,
  parentId: string | null,
  rect: { x: number; y: number; width: number; height: number },
): CanvasNode {
  const id = makeCanvasNodeId();
  const count = Object.values(doc.nodes).filter((node) => node.type === tool).length + 1;
  const base = {
    id,
    type: tool,
    name: `${LABELS[tool]} ${count}`,
    parentId,
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  } satisfies Partial<CanvasNode>;
  switch (tool) {
    case "frame":
      return {
        ...base,
        childIds: [],
        clipContent: true,
        fills: [{ type: "solid", color: "#ffffff" }],
      };
    case "rect":
      return { ...base, fills: [{ type: "solid", color: "#d9d9d9" }] };
    case "ellipse":
      return { ...base, fills: [{ type: "solid", color: "#d9d9d9" }] };
    case "text": {
      const text: CanvasText = {
        content: "Text",
        fontSize: 16,
        fontWeight: 400,
        color: "#000000",
        sizing: "auto-width",
      };
      const size = measureCanvasText(text);
      return { ...base, ...size, text };
    }
  }
}

let measureContext: CanvasRenderingContext2D | null = null;

/** Size of an auto-sized text node's content; wrapping is the engine's job. */
export function measureCanvasText(text: CanvasText): { width: number; height: number } {
  measureContext ??= document.createElement("canvas").getContext("2d");
  const lines = text.content.split("\n");
  const lineHeight = resolveLineHeight(text);
  if (!measureContext) {
    return { width: text.content.length * text.fontSize * 0.6, height: lines.length * lineHeight };
  }
  measureContext.font = canvasFont(text);
  let width = 0;
  for (const line of lines) width = Math.max(width, measureContext.measureText(line).width);
  return { width: Math.ceil(width) + 1, height: Math.ceil(lines.length * lineHeight) };
}

/** Values up to 4 are multipliers, larger values are pixels. */
export function resolveLineHeight(text: CanvasText): number {
  const lineHeight = text.lineHeight ?? 1.2;
  return lineHeight <= 4 ? lineHeight * text.fontSize : lineHeight;
}

const FONT_FALLBACKS = "Inter, system-ui, sans-serif";

export function canvasFont(text: CanvasText, scale = 1): string {
  return `${text.fontStyle === "italic" ? "italic " : ""}${text.fontWeight ?? 400} ${
    text.fontSize * scale
  }px ${text.fontFamily ? `"${text.fontFamily}", ` : ""}${FONT_FALLBACKS}`;
}

/** Drops ids whose ancestor is also selected, so moves and deletes act once. */
export function topLevelSelection(doc: CanvasDocument, ids: ReadonlyArray<string>): string[] {
  const selected = new Set(ids.filter((id) => doc.nodes[id]));
  return [...selected].filter((id) => {
    for (let parent = doc.nodes[id]?.parentId ?? null; parent !== null;) {
      if (selected.has(parent)) return false;
      parent = doc.nodes[parent]?.parentId ?? null;
    }
    return true;
  });
}

function siblingIndex(doc: CanvasDocument, node: CanvasNode): number {
  const siblings =
    node.parentId === null ? doc.rootIds : (doc.nodes[node.parentId]?.childIds ?? []);
  return siblings.indexOf(node.id);
}

/** Inserts a copy of each subtree right above its original. Returns the ops and the new root ids. */
export function duplicateNodes(
  doc: CanvasDocument,
  ids: ReadonlyArray<string>,
  offset: number,
): { ops: CanvasOp[]; ids: string[] } {
  const ops: CanvasOp[] = [];
  const created: string[] = [];
  const cloneSubtree = (
    id: string,
    parentId: string | null,
    index: number | undefined,
    shift: number,
  ) => {
    const node = doc.nodes[id];
    if (!node) return;
    const copyId = makeCanvasNodeId();
    const { childIds, ...rest } = node;
    const copy: CanvasNode = {
      ...rest,
      id: copyId,
      parentId,
      x: node.x + shift,
      y: node.y + shift,
      ...(childIds ? { childIds: [] } : {}),
    };
    ops.push(
      index === undefined ? { op: "insert", node: copy } : { op: "insert", node: copy, index },
    );
    for (const childId of childIds ?? []) cloneSubtree(childId, copyId, undefined, 0);
    return copyId;
  };
  // Highest index first so earlier insert positions stay valid.
  const ordered = topLevelSelection(doc, ids).toSorted((left, right) => {
    const a = doc.nodes[left]!;
    const b = doc.nodes[right]!;
    return siblingIndex(doc, b) - siblingIndex(doc, a);
  });
  for (const id of ordered) {
    const node = doc.nodes[id]!;
    const copyId = cloneSubtree(id, node.parentId, siblingIndex(doc, node) + 1, offset);
    if (copyId) created.push(copyId);
  }
  return { ops, ids: created };
}

export function firstSolidColor(node: CanvasNode | undefined): string | null {
  const fill = node?.fills?.find((paint) => paint.type === "solid");
  return fill && fill.type === "solid" ? fill.color : null;
}
