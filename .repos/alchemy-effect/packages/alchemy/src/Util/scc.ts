/**
 * Compute the set of graph nodes that participate in a dependency cycle.
 *
 * A node is considered "in a cycle" iff it sits in a strongly-connected
 * component (SCC) of size > 1, or has a self-edge (size-1 SCC that loops
 * back to itself).
 *
 * Implementation is iterative Tarjan's algorithm to avoid blowing the JS
 * call stack on very wide graphs.
 */
export const findCycleMembers = (
  edges: Record<string, readonly string[]>,
): Set<string> => {
  const cycleMembers = new Set<string>();

  let index = 0;
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  type Frame = { node: string; childIdx: number };
  const callStack: Frame[] = [];

  const startNode = (node: string) => {
    indexOf.set(node, index);
    lowlink.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    callStack.push({ node, childIdx: 0 });
  };

  for (const root of Object.keys(edges)) {
    if (indexOf.has(root)) continue;
    startNode(root);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const children = edges[frame.node] ?? [];
      if (frame.childIdx < children.length) {
        const child = children[frame.childIdx];
        frame.childIdx += 1;
        if (!indexOf.has(child)) {
          startNode(child);
          continue;
        }
        if (onStack.has(child)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node)!, indexOf.get(child)!),
          );
        }
        continue;
      }

      // All children processed: maybe close an SCC.
      if (lowlink.get(frame.node) === indexOf.get(frame.node)) {
        const scc: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
          if (w === frame.node) break;
        }
        if (scc.length > 1) {
          for (const fqn of scc) cycleMembers.add(fqn);
        } else {
          // Size-1 SCC: only counts as a cycle if it has a self-edge.
          const only = scc[0];
          if ((edges[only] ?? []).includes(only)) {
            cycleMembers.add(only);
          }
        }
      }

      // Pop frame and propagate lowlink up to the parent.
      callStack.pop();
      const parent = callStack[callStack.length - 1];
      if (parent) {
        const cur = lowlink.get(parent.node)!;
        const childLow = lowlink.get(frame.node)!;
        if (childLow < cur) lowlink.set(parent.node, childLow);
      }
    }
  }

  return cycleMembers;
};
