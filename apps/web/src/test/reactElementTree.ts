import { isValidElement, type ReactElement } from "react";

export function visitElements(
  node: unknown,
  visitor: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = visitElements(child, visitor);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (visitor(node)) return node;
  for (const value of Object.values(node.props)) {
    const found = visitElements(value, visitor);
    if (found) return found;
  }
  return null;
}
