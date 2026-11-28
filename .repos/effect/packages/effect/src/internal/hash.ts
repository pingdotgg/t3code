/**
 * Back-edge count used to avoid caching entry-point-dependent hashes and
 * comparisons.
 *
 * @internal
 */
export let backEdges = 0

/** @internal */
export const addBackEdge = (): void => {
  backEdges++
}

/** @internal */
export const hashCache = new WeakMap<object, number>()
