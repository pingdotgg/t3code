/**
 * Compares values with Effect's structural equality rules.
 *
 * `equals` compares primitives, arrays, plain objects, maps, sets, dates,
 * regular expressions, and values that implement the `Equal` interface. This
 * module also defines the equality symbol, guards, adapters, map and set
 * comparison builders, and helpers for marking objects that should compare only
 * by reference.
 *
 * @stability stable
 * @since 2.0.0
 */
import type { Equivalence } from "./Equivalence.ts"
import * as Hash from "./Hash.ts"
import { byReferenceInstances, getAllObjectKeys, objectKind, toBytes } from "./internal/equal.ts"
import { addBackEdge, backEdges, hashCache } from "./internal/hash.ts"
import { hasProperty } from "./Predicate.ts"

/**
 * Defines the unique string identifier for the `Equal` interface.
 *
 * **When to use**
 *
 * Use when you implement custom equality and need the computed property key for
 * the equality method.
 *
 * **Details**
 *
 * This is a pure constant with no allocation or side effects.
 *
 * **Example** (Implementing Equal on a class)
 *
 * ```ts import.meta.vitest
 * import { Equal, Hash } from "effect"
 *
 * class UserId implements Equal.Equal {
 *   constructor(readonly id: string) {}
 *
 *   [Equal.symbol](that: Equal.Equal): boolean {
 *     return that instanceof UserId && this.id === that.id
 *   }
 *
 *   [Hash.symbol](): number {
 *     return Hash.string(this.id)
 *   }
 * }
 *
 * Equal.equals(new UserId("1"), new UserId("1")) // => true
 * Equal.equals(new UserId("1"), new UserId("2")) // => false
 * ```
 *
 * @see {@link Equal} — the interface that uses this symbol
 * @see {@link isEqual} — type guard for `Equal` implementors
 * @stability stable
 * @category symbols
 * @since 2.0.0
 */
export const symbol = "~effect/Equal"

/**
 * The interface for types that define their own equality logic.
 *
 * **When to use**
 *
 * Use when you need value-based equality for a class (e.g. domain IDs,
 *   coordinates, money values).
 * - When your type will be stored in `HashMap` or `HashSet`.
 * - When the default structural comparison is too broad or too narrow for
 *   your type.
 *
 * **Details**
 *
 * Any object that implements both `[Equal.symbol]` (equality) and
 * `[Hash.symbol]` (hashing) is recognized by {@link equals} and by hash-based
 * collections such as `HashMap` and `HashSet`.
 *
 * - Extends `Hash.Hash`, so implementors **must** also provide `[Hash.symbol]`.
 * - The hash contract: if `a[Equal.symbol](b)` returns `true`, then
 *   `Hash.hash(a)` must equal `Hash.hash(b)`.
 * - {@link equals} delegates to this method when both operands implement it.
 *   If only one operand implements `Equal`, they are considered unequal.
 *
 * **Example** (Comparing coordinates by value)
 *
 * ```ts import.meta.vitest
 * import { Equal, Hash } from "effect"
 *
 * class Coordinate implements Equal.Equal {
 *   constructor(readonly x: number, readonly y: number) {}
 *
 *   [Equal.symbol](that: Equal.Equal): boolean {
 *     return that instanceof Coordinate &&
 *       this.x === that.x &&
 *       this.y === that.y
 *   }
 *
 *   [Hash.symbol](): number {
 *     return Hash.string(`${this.x},${this.y}`)
 *   }
 * }
 *
 * Equal.equals(new Coordinate(1, 2), new Coordinate(1, 2)) // => true
 * Equal.equals(new Coordinate(1, 2), new Coordinate(3, 4)) // => false
 * ```
 *
 * @see {@link symbol} — the property key used by the equality method
 * @see {@link equals} — the main comparison function
 * @see {@link isEqual} — type guard for `Equal` implementors
 * @stability stable
 * @category models
 * @since 2.0.0
 */
export interface Equal extends Hash.Hash {
  [symbol](that: Equal): boolean
}

/**
 * Checks whether two values are deeply structurally equal.
 *
 * **When to use**
 *
 * Use when you need Effect's default structural equality check.
 *
 * **Details**
 *
 * Returns a `boolean` and never throws. Primitives are compared by value, and
 * `NaN` equals `NaN`. Objects implementing `Equal` delegate to their
 * `[Equal.symbol]` method; if only one operand implements `Equal`, the result
 * is `false`.
 *
 * Dates compare by ISO string, RegExps compare by string representation,
 * arrays compare element-by-element, Maps and Sets compare entries
 * order-independently, and plain objects compare enumerable keys recursively.
 * Functions without an `Equal` implementation compare by reference. Circular
 * structures use coinductive equality.
 *
 * Custom `Hash` implementations and already-cached structural hashes are
 * checked first as a fast-path rejection. The function also supports dual
 * data-last usage: call it with one argument to get a curried predicate.
 *
 * **Gotchas**
 *
 * - Object-pair results are cached in a WeakMap. **Objects must not be
 *   mutated after their first comparison.**
 * - Map and Set entries are matched within groups of equal hashes, so they
 *   are O(n) for well-distributed hashes and O(n²) when every hash collides.
 *
 * **Example** (Comparing values)
 *
 * ```ts import.meta.vitest
 * import { Equal } from "effect"
 *
 * Equal.equals(1, 1) // => true
 * Equal.equals(NaN, NaN) // => true
 * Equal.equals("a", "b") // => false
 *
 * Equal.equals({ a: 1, b: 2 }, { a: 1, b: 2 }) // => true
 * Equal.equals([1, [2, 3]], [1, [2, 3]]) // => true
 *
 * Equal.equals(new Date("2024-01-01"), new Date("2024-01-01")) // => true
 *
 * const m1 = new Map([["a", 1], ["b", 2]])
 * const m2 = new Map([["b", 2], ["a", 1]])
 * Equal.equals(m1, m2) // => true
 *
 * const is5 = Equal.equals(5)
 * is5(5) // => true
 * is5(3) // => false
 * ```
 *
 * @see {@link Equal} — the interface for custom equality
 * @see {@link isEqual} — check whether a value implements `Equal`
 * @see {@link asEquivalence} — wrap `equals` as an `Equivalence`
 * @stability stable
 * @category equality
 * @since 2.0.0
 */
export function equals<B>(that: B): <A>(self: A) => boolean
export function equals<A, B>(self: A, that: B): boolean
export function equals(): any {
  if (arguments.length === 1) {
    return (self: unknown) => compareBoth(self, arguments[0])
  }
  return compareBoth(arguments[0], arguments[1])
}

function compareBoth(self: unknown, that: unknown): boolean {
  if (self == null || that == null) return self === that
  const selfType = typeof self
  if (selfType !== "object" && selfType !== "function") {
    return self === that || (self !== self && that !== that)
  }
  if (self === that) {
    // A shared reference can close a cycle on one side; hashing records any back-edge.
    if (pathLeft.length > 0 && !hashCache.has(self)) Hash.hash(self)
    return true
  }
  if (selfType !== typeof that || byReferenceInstances.has(self) || byReferenceInstances.has(that)) {
    return false
  }
  return compareObjects(self, that)
}

function compareObjects(self: object, that: object): boolean {
  const depth = pathLeft.length
  const prev = seen.get(self)
  if (prev === that) return true
  let known: WeakMap<object, boolean> | undefined
  if (!depth || prev !== undefined) {
    known = results.get(self)
    const cached = known?.get(that)
    if (cached !== undefined) return cached
  }
  let revisited = false
  for (let i = depth; i-- > 0;) {
    const sameLeft = pathLeft[i] === self
    if (sameLeft || pathRight[i] === that) {
      addBackEdge()
      // A repeated pair closes a cycle under coinductive equality.
      if (sameLeft && pathRight[i] === that) return true
      revisited = true
    }
  }
  // Reject mismatched cycle lengths instead of unrolling both loops.
  if (revisited && Hash.hash(self) !== Hash.hash(that)) return false
  const seenBack = backEdges
  pathLeft.push(self)
  pathRight.push(that)
  let result: boolean
  try {
    result = compareStructure(self, that)
  } finally {
    pathLeft.pop()
    pathRight.pop()
    if (!depth) seen.clear()
  }
  // Cyclic hashes depend on entry point; verify hash agreement.
  if (seenBack !== backEdges) return result && Hash.hash(self) === Hash.hash(that)
  // Only cache acyclic results so nested lookups never skip a back-edge.
  if (depth && prev === undefined) {
    if (result) seen.set(self, that)
  } else {
    if (!known) results.set(self, known = new WeakMap())
    known.set(that, result)
  }
  return result
}

// The pairs on the current comparison's path (the coinductive assumptions).
const pathLeft: Array<object> = []
const pathRight: Array<object> = []
const seen = new Map<object, object>()
const results = new WeakMap<object, WeakMap<object, boolean>>()

function compareStructure(self: object, that: object): boolean {
  const selfHash = hashCache.get(self)
  if (selfHash !== undefined && selfHash !== (hashCache.get(that) ?? selfHash)) return false
  const kind = objectKind(self)
  if (kind === 1 || kind === 2) {
    if (objectKind(that) !== kind) return false
    if (kind === 2) return self.toString() === that.toString()
    if (Hash.hash(self) !== Hash.hash(that)) return false
    const a = (self as Date).getTime()
    const b = (that as Date).getTime()
    return a === b || (a !== a && b !== b)
  }
  const bothEquals = isEqual(self)
  if (bothEquals !== isEqual(that) || (typeof self === "function" && !bothEquals)) {
    return false
  }
  if ((bothEquals || Hash.isHash(self) || Hash.isHash(that)) && Hash.hash(self) !== Hash.hash(that)) {
    return false
  }
  if (bothEquals) {
    return (self as Equal)[symbol](that as Equal)
  }
  if (kind !== objectKind(that)) {
    return false
  }
  if (kind >= 7) {
    const selfBytes = toBytes(self as ArrayBufferLike | DataView, kind)
    const thatBytes = toBytes(that as ArrayBufferLike | DataView, kind)
    return selfBytes !== undefined && thatBytes !== undefined && compareTypedArrays(selfBytes, thatBytes)
  } else if (kind === 5) {
    return compareArrays(self as Array<unknown>, that as Array<unknown>)
  } else if (kind === 6) {
    return (self as ArrayBufferView).byteLength === (that as ArrayBufferView).byteLength &&
      compareTypedArrays(self as Uint8Array, that as Uint8Array)
  } else if (kind === 3) {
    return (self as Map<unknown, unknown>).size === (that as Map<unknown, unknown>).size &&
      compareHashed(self as Map<unknown, unknown>, that as Map<unknown, unknown>, entryHash, equalEntries)
  } else if (kind === 4) {
    return (self as Set<unknown>).size === (that as Set<unknown>).size &&
      compareHashed(self as Set<unknown>, that as Set<unknown>, Hash.hash, compareBoth)
  }
  return compareRecords(self as any, that as any)
}

function compareArrays(self: Array<unknown>, that: Array<unknown>): boolean {
  if (self.length !== that.length) {
    return false
  }
  for (let i = 0; i < self.length; i++) {
    if (!compareBoth(self[i], that[i])) {
      return false
    }
  }

  return true
}

function compareTypedArrays(self: Uint8Array, that: Uint8Array): boolean {
  if (self.length !== that.length) {
    return false
  }
  for (let i = 0; i < self.length; i++) {
    if (self[i] !== that[i]) {
      return false
    }
  }
  return true
}

function compareRecords(
  self: Record<PropertyKey, unknown>,
  that: Record<PropertyKey, unknown>
): boolean {
  const selfKeys = getAllObjectKeys(self)
  const thatKeys = getAllObjectKeys(that)
  const thatIsSet = thatKeys instanceof Set
  if ((selfKeys instanceof Set ? selfKeys.size : selfKeys.length) !== (thatIsSet ? thatKeys.size : thatKeys.length)) {
    return false
  }
  for (const key of selfKeys) {
    if (!(thatIsSet ? thatKeys.has(key) : Object.hasOwn(that, key)) || !compareBoth(self[key], that[key])) {
      return false
    }
  }
  return true
}

// Match items one-to-one within equal-hash groups.
function compareHashed<A>(
  self: Iterable<A>,
  that: Iterable<A>,
  hashOf: (item: A) => number,
  equivalent: (self: A, that: A) => boolean
): boolean {
  const groups = new Map<number, Array<A>>()
  let remaining = 0
  for (const item of that) {
    const h = hashOf(item)
    const group = groups.get(h)
    if (group) group.push(item)
    else groups.set(h, [item])
    remaining++
  }
  outer: for (const item of self) {
    const group = groups.get(hashOf(item))
    if (group) {
      for (let i = 0; i < group.length; i++) {
        if (equivalent(item, group[i])) {
          group[i] = group[group.length - 1]
          group.pop()
          remaining--
          continue outer
        }
      }
    }
    return false
  }
  return remaining === 0
}

const entryHash = (entry: readonly [unknown, unknown]): number => Hash.hash(entry[0])

const equalEntries = <K, V>(self: readonly [K, V], that: readonly [K, V]): boolean =>
  compareBoth(self[0], that[0]) && compareBoth(self[1], that[1])

const sameGroup = (): number => 0

/** @internal */
export function makeCompareMap<K, V>(keyEquivalence: Equivalence<K>, valueEquivalence: Equivalence<V>) {
  return makeCompareSet<readonly [K, V]>((self, that) =>
    keyEquivalence(self[0], that[0]) && valueEquivalence(self[1], that[1])
  )
}

/** @internal */
export function makeCompareSet<A>(equivalence: Equivalence<A>) {
  return function compareSets(self: Iterable<A>, that: Iterable<A>): boolean {
    return compareHashed(self, that, sameGroup, equivalence)
  }
}

/**
 * Checks whether a value implements the {@link Equal} interface.
 *
 * **When to use**
 *
 * Use when you need generic utility code to distinguish `Equal` implementors
 * from plain values before calling `[Equal.symbol]` directly.
 *
 * **Details**
 *
 * - Pure function, no side effects.
 * - Returns `true` if and only if `u` has a function keyed by {@link symbol}.
 *   Data that merely carries the key, such as parsed JSON, is not `Equal`.
 * - Acts as a TypeScript type guard, narrowing the input to {@link Equal}.
 *
 * **Example** (Checking Equal values)
 *
 * ```ts import.meta.vitest
 * import { Equal, Hash } from "effect"
 *
 * class Token implements Equal.Equal {
 *   constructor(readonly value: string) {}
 *   [Equal.symbol](that: Equal.Equal): boolean {
 *     return that instanceof Token && this.value === that.value
 *   }
 *   [Hash.symbol](): number {
 *     return Hash.string(this.value)
 *   }
 * }
 *
 * Equal.isEqual(new Token("abc")) // => true
 * Equal.isEqual({ x: 1 }) // => false
 * Equal.isEqual(42) // => false
 * ```
 *
 * @see {@link Equal} — the interface being checked
 * @see {@link symbol} — the property key that signals `Equal` support
 * @stability stable
 * @category guards
 * @since 2.0.0
 */
export const isEqual = (u: unknown): u is Equal => hasProperty(u, symbol) && typeof u[symbol] === "function"

/**
 * Wraps {@link equals} as an `Equivalence<A>`.
 *
 * **When to use**
 *
 * Use when you want to pass `Equal.equals` to APIs that require an
 * `Equivalence`.
 *
 * **Details**
 *
 * - Returns a function `(a: A, b: A) => boolean` that delegates to
 *   {@link equals}.
 * - Pure; allocates a thin wrapper on each call.
 *
 * **Example** (Deduplicating with Equal semantics)
 *
 * ```ts import.meta.vitest
 * import { Array, Equal } from "effect"
 *
 * Array.dedupeWith([1, 2, 2, 3, 1], Equal.asEquivalence<number>()) // => [1, 2, 3]
 * ```
 *
 * @see {@link equals} — the underlying comparison function
 * @stability stable
 * @category instances
 * @since 4.0.0
 */
export const asEquivalence: <A>() => Equivalence<A> = () => equals

/**
 * Creates a proxy that uses reference equality instead of structural equality.
 *
 * **When to use**
 *
 * Use when you need to compare a plain object or array by identity without
 * mutating the original value.
 *
 * **Details**
 *
 * - Returns a `Proxy` wrapping `obj`. The proxy reads through to the
 *   original, so property access is unchanged.
 * - The proxy is registered in an internal WeakSet; {@link equals} returns
 *   `false` for any pair where at least one operand is in that set (unless
 *   they are the same reference).
 * - Each call creates a **new** proxy, so `byReference(x) !== byReference(x)`.
 * - Does **not** mutate the original object (unlike {@link byReferenceUnsafe}).
 *
 * **Example** (Opting out of structural equality)
 *
 * ```ts import.meta.vitest
 * import { Equal } from "effect"
 *
 * const a = { x: 1 }
 * const b = { x: 1 }
 *
 * Equal.equals(a, b) // => true
 *
 * const aRef = Equal.byReference(a)
 * Equal.equals(aRef, b) // => false
 * Equal.equals(aRef, aRef) // => true
 * aRef.x // => 1
 * ```
 *
 * @see {@link byReferenceUnsafe} — same effect without a proxy (mutates the
 *   original)
 * @see {@link equals} — the comparison function affected by this opt-out
 * @stability stable
 * @category equality
 * @since 4.0.0
 */
export const byReference = <T extends object>(obj: T): T => byReferenceUnsafe(new Proxy(obj, {}))

/**
 * Marks an object permanently to use reference equality, without creating a proxy.
 *
 * **When to use**
 *
 * Use when you need reference equality without proxy allocation and accept
 * permanently marking the original object for reference-only equality.
 *
 * **Details**
 *
 * - Adds `obj` to an internal WeakSet. From that point on, {@link equals}
 *   treats it as reference-only.
 * - Returns the **same** object (not a copy or proxy), so
 *   `byReferenceUnsafe(x) === x`.
 * - Does **not** affect the object's prototype, properties, or behavior
 *   beyond equality checks.
 *
 * **Gotchas**
 *
 * The marking is irreversible for the lifetime of the object.
 *
 * **Example** (Marking an object for reference equality)
 *
 * ```ts import.meta.vitest
 * import { Equal } from "effect"
 *
 * const obj1 = { a: 1, b: 2 }
 * const obj2 = { a: 1, b: 2 }
 *
 * const marked = Equal.byReferenceUnsafe(obj1)
 *
 * Equal.equals(obj1, obj2) // => false
 * Equal.equals(obj1, obj1) // => true
 * marked === obj1 // => true
 * ```
 *
 * @see {@link byReference} — safer alternative that creates a proxy
 * @see {@link equals} — the comparison function affected by this opt-out
 * @stability stable
 * @category unsafe
 * @since 4.0.0
 */
export const byReferenceUnsafe = <T extends object>(obj: T): T => {
  byReferenceInstances.add(obj)
  return obj
}
