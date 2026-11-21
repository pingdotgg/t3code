// @effect-diagnostics globalDate:off cryptoRandomUUID:off - pure helpers shared with browser code outside Effect; the server passes `now` from its Clock.
import type { CanvasAsset, CanvasDocument, CanvasNode, CanvasOp } from "@t3tools/contracts";

// @effect-diagnostics-next-line extendsNativeError:off - pure helpers shared with browser code; thrown synchronously and mapped to a tagged error by callers.
export class CanvasOpError extends Error {}

const removeId = (ids: ReadonlyArray<string>, id: string) => ids.filter((value) => value !== id);

const insertId = (ids: ReadonlyArray<string>, id: string, index: number | undefined) => {
  const next = ids.slice();
  next.splice(index === undefined ? next.length : Math.min(index, next.length), 0, id);
  return next;
};

/** Deterministic intrinsic bounds without requiring a browser or installed font. */
function sizeAutoText(node: CanvasNode): CanvasNode {
  const text = node.text;
  if (node.type !== "text" || !text || !["auto-width", "auto-height"].includes(text.sizing ?? "")) {
    return node;
  }
  const measure = (value: string) => {
    let width = 0;
    let count = 0;
    for (const char of value) {
      const em = /\s/.test(char)
        ? 0.33
        : /[iljtf.,:;'|!]/.test(char)
          ? 0.3
          : /[mwMW]/.test(char)
            ? 0.85
            : /[A-Z0-9]/.test(char)
              ? 0.64
              : (char.codePointAt(0) ?? 0) >= 0x2e80
                ? 1
                : 0.54;
      width += em * text.fontSize;
      count++;
    }
    return Math.max(0, width + Math.max(0, count - 1) * (text.letterSpacing ?? 0));
  };
  let width = 0;
  let lines = 0;
  const maxWidth = text.sizing === "auto-width" ? Infinity : Math.max(node.width, 1);
  for (const paragraph of text.content.split("\n")) {
    width = Math.max(width, measure(paragraph));
    lines++;
    let lineWidth = 0;
    let hasContent = false;
    for (const token of paragraph.split(/(\s+)/)) {
      if (!hasContent && !token.trim()) continue;
      const tokenWidth = measure(token);
      const nextWidth = lineWidth + tokenWidth + (hasContent ? (text.letterSpacing ?? 0) : 0);
      if (hasContent && token.trim() && nextWidth > maxWidth + 0.5) {
        lines++;
        lineWidth = tokenWidth;
      } else lineWidth = nextWidth;
      hasContent = true;
    }
  }
  const value = text.lineHeight;
  const lineHeight =
    value === undefined || value <= 0
      ? text.fontSize * 1.2
      : value <= 4
        ? value * text.fontSize
        : value;
  return {
    ...node,
    width: text.sizing === "auto-width" ? Math.max(1, Math.ceil(width)) : node.width,
    height: Math.max(1, Math.ceil(lines * lineHeight)),
  };
}

/**
 * Applies an op batch to a document and returns a new document. Untouched
 * nodes keep their identity so renderers can diff by reference. Throws
 * `CanvasOpError` on an invalid op; callers treat the batch as atomic.
 */
export function applyCanvasOps(
  document: CanvasDocument,
  ops: ReadonlyArray<CanvasOp>,
  now = new Date().toISOString(),
): CanvasDocument {
  const nodes: Record<string, CanvasNode> = { ...document.nodes };
  // Copied on the first put-asset so asset-free batches keep the same record.
  let assets: Record<string, CanvasAsset> | null = null;
  let rootIds = document.rootIds;
  let name = document.name;

  const childIdsOf = (parentId: string | null) => {
    if (parentId === null) return rootIds;
    const parent = nodes[parentId];
    if (!parent) throw new CanvasOpError(`Unknown parent ${parentId}`);
    return parent.childIds ?? [];
  };
  const setChildIds = (parentId: string | null, ids: ReadonlyArray<string>) => {
    if (parentId === null) rootIds = ids;
    else nodes[parentId] = { ...nodes[parentId]!, childIds: ids };
  };
  const isAncestor = (ancestorId: string, nodeId: string | null) => {
    for (let id = nodeId; id !== null; id = nodes[id]?.parentId ?? null) {
      if (id === ancestorId) return true;
    }
    return false;
  };
  const deleteSubtree = (id: string) => {
    const node = nodes[id];
    if (!node) return;
    for (const childId of node.childIds ?? []) deleteSubtree(childId);
    delete nodes[id];
  };

  for (const op of ops) {
    switch (op.op) {
      case "insert": {
        const { node } = op;
        if (nodes[node.id]) throw new CanvasOpError(`Node ${node.id} already exists`);
        const siblings = childIdsOf(node.parentId);
        // Children join through their own inserts; trusting a supplied list could adopt other nodes.
        nodes[node.id] = sizeAutoText(node.childIds?.length ? { ...node, childIds: [] } : node);
        setChildIds(node.parentId, insertId(siblings, node.id, op.index));
        break;
      }
      case "update": {
        const current = nodes[op.id];
        if (!current) throw new CanvasOpError(`Unknown node ${op.id}`);
        const next: Record<string, unknown> = { ...current };
        for (const [key, value] of Object.entries(op.patch)) {
          if (key === "id" || key === "parentId" || key === "childIds") continue;
          if (value === null) delete next[key];
          else next[key] = value;
        }
        nodes[op.id] =
          op.patch.text !== undefined || op.patch.width !== undefined
            ? sizeAutoText(next as CanvasNode)
            : (next as CanvasNode);
        break;
      }
      case "delete": {
        const current = nodes[op.id];
        if (!current) break;
        setChildIds(current.parentId, removeId(childIdsOf(current.parentId), op.id));
        deleteSubtree(op.id);
        break;
      }
      case "move": {
        const current = nodes[op.id];
        if (!current) throw new CanvasOpError(`Unknown node ${op.id}`);
        if (op.parentId !== null && isAncestor(op.id, op.parentId)) {
          throw new CanvasOpError(`Cannot move ${op.id} into its own subtree`);
        }
        setChildIds(current.parentId, removeId(childIdsOf(current.parentId), op.id));
        nodes[op.id] = { ...nodes[op.id]!, parentId: op.parentId };
        setChildIds(op.parentId, insertId(childIdsOf(op.parentId), op.id, op.index));
        break;
      }
      case "put-asset":
        assets ??= { ...document.assets };
        assets[op.asset.id] = op.asset;
        break;
      case "rename":
        name = op.name;
        break;
    }
  }

  return {
    ...document,
    name,
    rootIds,
    nodes,
    assets: assets ?? document.assets,
    revision: document.revision + 1,
    updatedAt: now,
  };
}

/** Short, collision-resistant node id. */
export function makeCanvasNodeId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}
