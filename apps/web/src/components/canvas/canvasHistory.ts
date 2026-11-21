import type { CanvasDocument, CanvasNode, CanvasOp } from "@t3tools/contracts";

/**
 * Ops that undo `ops` when applied to the document `ops` produced from `doc`.
 * Simulates the batch on one shallow copy of the node map so a node touched
 * twice in a batch inverts to its state before the batch. Asset puts have no
 * inverse: assets are content-addressed and harmless to keep.
 */
export function invertCanvasOps(doc: CanvasDocument, ops: ReadonlyArray<CanvasOp>): CanvasOp[] {
  const nodes: Record<string, CanvasNode> = { ...doc.nodes };
  let rootIds = doc.rootIds;
  let name = doc.name;
  const inverse: CanvasOp[][] = [];

  const siblingsOf = (parentId: string | null) =>
    parentId === null ? rootIds : (nodes[parentId]?.childIds ?? []);
  const setSiblings = (parentId: string | null, ids: ReadonlyArray<string>) => {
    if (parentId === null) rootIds = ids;
    else if (nodes[parentId]) nodes[parentId] = { ...nodes[parentId], childIds: ids };
  };
  const reinsertSubtree = (id: string, index: number | undefined, out: CanvasOp[]) => {
    const node = nodes[id];
    if (!node) return;
    const { childIds, ...rest } = node;
    out.push(
      index === undefined
        ? { op: "insert", node: { ...rest, childIds: [] } }
        : { op: "insert", node: { ...rest, childIds: [] }, index },
    );
    for (const childId of childIds ?? []) reinsertSubtree(childId, undefined, out);
  };
  const removeSubtree = (id: string) => {
    for (const childId of nodes[id]?.childIds ?? []) removeSubtree(childId);
    delete nodes[id];
  };

  for (const op of ops) {
    switch (op.op) {
      case "insert": {
        inverse.push([{ op: "delete", id: op.node.id }]);
        const siblings = siblingsOf(op.node.parentId).slice();
        siblings.splice(op.index ?? siblings.length, 0, op.node.id);
        nodes[op.node.id] = op.node;
        setSiblings(op.node.parentId, siblings);
        break;
      }
      case "update": {
        const current = nodes[op.id];
        if (!current) break;
        const previous: Record<string, unknown> = {};
        const next: Record<string, unknown> = { ...current };
        for (const [key, value] of Object.entries(op.patch)) {
          if (key === "id" || key === "parentId" || key === "childIds") continue;
          previous[key] = (current as Record<string, unknown>)[key] ?? null;
          if (value === null) delete next[key];
          else next[key] = value;
        }
        inverse.push([{ op: "update", id: op.id, patch: previous }]);
        nodes[op.id] = next as CanvasNode;
        break;
      }
      case "delete": {
        const current = nodes[op.id];
        if (!current) break;
        const siblings = siblingsOf(current.parentId);
        const restore: CanvasOp[] = [];
        reinsertSubtree(op.id, siblings.indexOf(op.id), restore);
        inverse.push(restore);
        setSiblings(
          current.parentId,
          siblings.filter((id) => id !== op.id),
        );
        removeSubtree(op.id);
        break;
      }
      case "move": {
        const current = nodes[op.id];
        if (!current) break;
        const siblings = siblingsOf(current.parentId);
        inverse.push([
          {
            op: "move",
            id: op.id,
            parentId: current.parentId,
            index: Math.max(0, siblings.indexOf(op.id)),
          },
        ]);
        setSiblings(
          current.parentId,
          siblings.filter((id) => id !== op.id),
        );
        nodes[op.id] = { ...current, parentId: op.parentId };
        const target = siblingsOf(op.parentId).slice();
        target.splice(op.index ?? target.length, 0, op.id);
        setSiblings(op.parentId, target);
        break;
      }
      case "rename":
        inverse.push([{ op: "rename", name }]);
        name = op.name;
        break;
      case "put-asset":
        break;
    }
  }

  return inverse.toReversed().flat();
}
