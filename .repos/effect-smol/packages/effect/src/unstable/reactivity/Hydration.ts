/**
 * Moves serializable reactivity state between `AtomRegistry` instances.
 *
 * The `Hydration` module snapshots atoms marked with `Atom.serializable` and
 * loads those encoded values into another registry before the atoms are read. It
 * is useful for server rendering, browser bootstrapping, route transitions, and
 * other handoffs where a new registry should start from values computed by a
 * previous one.
 *
 * **Mental model**
 *
 * `dehydrate` walks the source registry and produces `DehydratedAtomValue`
 * records keyed by each atom's serialization key. `hydrate` stores those encoded
 * values in the target registry so the matching atom can decode them with its own
 * serializable codec. Atom identity is not transferred; only the stable key,
 * encoded value, dehydration timestamp, and optional async handoff are.
 *
 * **Common tasks**
 *
 * Use `dehydrate` before rendering or crossing a route boundary, then call
 * `hydrate` on the registry that will serve the next read. Use `toValues` when
 * code accepts generic `DehydratedAtom` entries but needs the concrete record
 * shape, and use `encodeInitialAs` to choose how `AsyncResult.Initial` values
 * should appear in the snapshot.
 *
 * **Gotchas**
 *
 * Only serializable atoms are included, and the target registry must contain
 * atoms with matching stable keys and compatible codecs. The optional
 * `resultPromise` used for `AsyncResult.Initial` is a live JavaScript promise; it
 * can be handed to another registry in the same runtime, but it cannot be sent
 * through JSON or across process boundaries.
 *
 * @since 4.0.0
 */
import * as AsyncResult from "./AsyncResult.ts"
import * as Atom from "./Atom.ts"
import type * as AtomRegistry from "./AtomRegistry.ts"

/**
 * Marker interface for entries in a dehydrated atom registry state.
 *
 * @category models
 * @since 4.0.0
 */
export interface DehydratedAtom {
  readonly "~effect/reactivity/DehydratedAtom": true
}

/**
 * A dehydrated serializable atom value.
 *
 * **Details**
 *
 * It stores the atom serialization key, encoded value, dehydration timestamp, and
 * an optional promise used when an `AsyncResult.Initial` value is encoded as a
 * future non-initial value.
 *
 * @category models
 * @since 4.0.0
 */
export interface DehydratedAtomValue extends DehydratedAtom {
  readonly key: string
  readonly value: unknown
  readonly dehydratedAt: number
  readonly resultPromise?: Promise<unknown> | undefined
}

/**
 * Encodes the serializable atoms currently stored in a registry into dehydrated
 * state.
 *
 * **Details**
 *
 * Only atoms marked with `Atom.serializable` are included. `encodeInitialAs`
 * controls whether `AsyncResult.Initial` values are ignored, encoded as values, or
 * represented by promises that resolve when the atom leaves the initial state.
 *
 * @category dehydration
 * @since 4.0.0
 */
export const dehydrate = (
  registry: AtomRegistry.AtomRegistry,
  options?: {
    /**
     * How to encode `AsyncResult.Initial` values. Default is "ignore".
     */
    readonly encodeInitialAs?: "ignore" | "promise" | "value-only" | undefined
  }
): Array<DehydratedAtom> => {
  const encodeInitialResultMode = options?.encodeInitialAs ?? "ignore"
  const arr: Array<DehydratedAtomValue> = []
  const now = Date.now()
  registry.getNodes().forEach((node, key) => {
    if (!Atom.isSerializable(node.atom)) return
    const atom = node.atom
    const value = node.value()
    const isInitial = AsyncResult.isAsyncResult(value) && AsyncResult.isInitial(value)
    if (encodeInitialResultMode === "ignore" && isInitial) return
    const encodedValue = atom[Atom.SerializableTypeId].encode(value)

    // Create a promise that resolves when the atom moves out of Initial state
    let resultPromise: Promise<unknown> | undefined
    if (encodeInitialResultMode === "promise" && isInitial) {
      resultPromise = new Promise((resolve) => {
        const unsubscribe = registry.subscribe(atom, (newValue) => {
          if (AsyncResult.isAsyncResult(newValue) && !AsyncResult.isInitial(newValue)) {
            resolve(atom[Atom.SerializableTypeId].encode(newValue))
            unsubscribe()
          }
        })
      })
    }

    arr.push({
      "~effect/reactivity/DehydratedAtom": true,
      key: key as string,
      value: encodedValue,
      dehydratedAt: now,
      resultPromise
    })
  })
  return arr as any
}

/**
 * Returns dehydrated state entries as `DehydratedAtomValue` records.
 *
 * @category dehydration
 * @since 4.0.0
 */
export const toValues = (state: ReadonlyArray<DehydratedAtom>): Array<DehydratedAtomValue> => state as any

/**
 * Applies dehydrated atom state to a registry.
 *
 * **When to use**
 *
 * Use to preload serialized atom values into a target registry before those
 * atoms are read.
 *
 * **Details**
 *
 * Encoded values are preloaded by serialization key. Entries with a
 * `resultPromise` update the matching registry node, or preload the resolved value,
 * when the promise resolves.
 *
 * @category hydration
 * @since 4.0.0
 */
export const hydrate = (
  registry: AtomRegistry.AtomRegistry,
  dehydratedState: Iterable<DehydratedAtom>
): void => {
  for (const datom of (dehydratedState as Iterable<DehydratedAtomValue>)) {
    registry.setSerializable(datom.key, datom.value)

    // If there's a resultPromise, it means this was in Initial state when dehydrated
    // and we should wait for it to resolve to a non-Initial state, then update the registry
    if (!datom.resultPromise) continue
    datom.resultPromise.then((resolvedValue) => {
      // Try to update the existing node directly instead of using setSerializable
      const nodes = registry.getNodes()
      const node = nodes.get(datom.key)
      if (node) {
        // Decode the resolved value using the node's atom serializable decoder
        const atom = node.atom as any
        if (atom[Atom.SerializableTypeId]) {
          const decoded = atom[Atom.SerializableTypeId].decode(resolvedValue)
          ;(node as any).setValue(decoded)
        }
      } else {
        // Fallback to setSerializable if node doesn't exist yet
        registry.setSerializable(datom.key, resolvedValue)
      }
    })
  }
}
