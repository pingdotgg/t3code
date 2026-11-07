interface PickScope<E> {
  elementsFromPoint(x: number, y: number): ReadonlyArray<E>;
  contains(node: NoInfer<E>): boolean;
}

/**
 * `Document.elementsFromPoint` retargets shadow content to its outermost host, so the pick
 * descends into each open shadow root. `ShadowRoot.elementsFromPoint` hit-tests the whole page
 * and only retargets, so it also lists the host and everything outside it (including the picker
 * overlay); only the root's own elements count. Closed roots expose no `shadowRoot` and stay
 * opaque.
 */
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
