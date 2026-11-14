interface PickScope<E> {
  elementsFromPoint(x: number, y: number): ReadonlyArray<E>;
  contains(node: NoInfer<E>): boolean;
}

// Document hit-testing retargets shadow content to its host, so descend into open roots.
// ShadowRoot.elementsFromPoint still lists the host and the rest of the page (the overlay
// too), so only the root's own elements count. Closed roots expose no shadowRoot.
export function pickElementAtPoint<E extends { readonly shadowRoot: PickScope<E> | null }>(
  scope: PickScope<E>,
  x: number,
  y: number,
  isExcluded: (element: E) => boolean,
): E | null {
  for (const candidate of scope.elementsFromPoint(x, y)) {
    if (!scope.contains(candidate) || isExcluded(candidate)) continue;
    const inner =
      candidate.shadowRoot && pickElementAtPoint(candidate.shadowRoot, x, y, isExcluded);
    return inner ?? candidate;
  }
  return null;
}
