/**
 * Structural and custom equality for Effect values.
 *
 * The `Equal` module provides deep structural comparison for primitives, plain
 * objects, arrays, Maps, Sets, Dates, and RegExps. Types that implement the
 * {@link Equal} interface can supply their own comparison logic while staying
 * compatible with the rest of the ecosystem (HashMap, HashSet, etc.).
 *
 * ## Mental model
 *
 * - **Structural equality** — two values are equal when their contents match,
 *   not when they share the same reference.
 * - **Hash-first shortcut** — before comparing fields, the module checks
 *   {@link Hash.hash}. If the hashes differ the objects are unequal without
 *   further traversal.
 * - **Equal interface** — any object that implements both {@link symbol} (the
 *   equality method) and `Hash.symbol` (the hash method) can define custom
 *   comparison logic.
 * - **Caching** — comparison results for object pairs are cached in a WeakMap.
 *   This makes repeated checks fast but **requires immutability** after the
 *   first comparison.
 * - **By-reference opt-out** — {@link byReference} and {@link byReferenceUnsafe}
 *   let you switch individual objects back to reference equality when you need
 *   mutable identity semantics.
 *
 * ## Common tasks
 *
 * - Compare two values → {@link equals}
 * - Check if a value implements `Equal` → {@link isEqual}
 * - Use `equals` where an `Equivalence` is expected → {@link asEquivalence}
 * - Implement custom equality on a class → implement {@link Equal} (see
 *   example on the interface)
 * - Opt an object out of structural equality → {@link byReference} /
 *   {@link byReferenceUnsafe}
 *
 * ## Gotchas
 *
 * - Objects **must be treated as immutable** after their first equality check.
 *   Results are cached; mutating an object afterwards yields stale results.
 * - `NaN` is considered equal to `NaN` (unlike `===`).
 * - Functions without an `Equal` implementation are compared by reference.
 * - Map and Set comparisons are order-independent but O(n²) in size.
 * - If only one of two objects implements `Equal`, they are never equal.
 *
 * ## Quickstart
 *
 * **Example** (basic structural comparison)
 *
 * ```ts
 * import { Equal } from "effect"
 *
 * // Primitives
 * console.log(Equal.equals(1, 1))       // true
 * console.log(Equal.equals("a", "b"))   // false
 *
 * // Objects and arrays
 * console.log(Equal.equals({ x: 1 }, { x: 1 })) // true
 * console.log(Equal.equals([1, 2], [1, 2]))       // true
 *
 * // Curried form
 * const is42 = Equal.equals(42)
 * console.log(is42(42)) // true
 * console.log(is42(0))  // false
 * ```
 *
 * @see {@link equals} — the main comparison function
 * @see {@link Equal} — the interface for custom equality
 * @see {@link Hash} — the companion hashing module
 *
 * @since 2.0.0
 */
import type { Equivalence } from "./Equivalence.ts"
import * as Hash from "./Hash.ts"
import { byReferenceInstances, getAllObjectKeys } from "./internal/equal.ts"
import { hasProperty } from "./Predicate.ts"

/**
 * Defines the unique string identifier for the `Equal` interface.
 *
 * **When to use**
 *
 * Use when you use it as the computed property key when implementing custom equality on a
 *   class or object literal.
 * - Use it to check manually whether an object carries an equality method (prefer
 *   {@link isEqual} instead).
 *
 * **Details**
 *
 * This is a pure constant with no allocation or side effects.
 *
 * **Example** (Implementing Equal on a Class)
 *
 * ```ts
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
 * ```
 *
 * @see {@link Equal} — the interface that uses this symbol
 * @see {@link isEqual} — type guard for `Equal` implementors
 * @category symbols
 * @since 2.0.0
 */
export const symbol = "~effect/interfaces/Equal"

/**
 * The interface for types that define their own equality logic.
 *
 * **When to use**
 *
 * Use when when you need value-based equality for a class (e.g. domain IDs,
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
 * **Example** (Coordinate with Value Equality)
 *
 * ```ts
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
 * console.log(Equal.equals(new Coordinate(1, 2), new Coordinate(1, 2))) // true
 * console.log(Equal.equals(new Coordinate(1, 2), new Coordinate(3, 4))) // false
 * ```
 *
 * @see {@link symbol} — the property key used by the equality method
 * @see {@link equals} — the main comparison function
 * @see {@link isEqual} — type guard for `Equal` implementors
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
 * Use when as the default equality check throughout Effect code.
 * - In data-level assertions or conditional logic where structural comparison
 *   is needed.
 * - In its curried (single-argument) form to build reusable predicates.
 *
 * **Details**
 *
 * - Returns a `boolean`; never throws.
 * - Primitives: compared by value. `NaN` equals `NaN`.
 * - Objects implementing {@link Equal}: delegates to their
 *   `[Equal.symbol]` method. If only one operand implements `Equal`, the
 *   result is `false`.
 * - Dates: compared by ISO string representation.
 * - RegExps: compared by string representation.
 * - Arrays: element-by-element recursive comparison (order matters).
 * - Maps / Sets: structural comparison of entries (order-independent).
 * - Plain objects: all own and inherited enumerable keys are compared
 *   recursively.
 * - Functions without an `Equal` implementation are compared by reference.
 * - Circular references are handled; two structures that are circular at the
 *   same depth are considered equal.
 * - Hash values are checked first as a fast-path rejection.
 * - Supports dual (data-last) usage: call with one argument to get a curried
 *   predicate.
 *
 * **Gotchas**
 *
 * - Results are cached per object pair in a WeakMap. **Objects must not be
 *   mutated after their first comparison.**
 * - Map and Set comparisons are O(n²) in size.
 *
 * **Example** (Comparing Values)
 *
 * ```ts
 * import { Equal } from "effect"
 *
 * // Primitives
 * console.log(Equal.equals(1, 1))         // true
 * console.log(Equal.equals(NaN, NaN))     // true
 * console.log(Equal.equals("a", "b"))     // false
 *
 * // Objects and arrays
 * console.log(Equal.equals({ a: 1, b: 2 }, { a: 1, b: 2 })) // true
 * console.log(Equal.equals([1, [2, 3]], [1, [2, 3]]))         // true
 *
 * // Dates
 * console.log(Equal.equals(new Date("2024-01-01"), new Date("2024-01-01"))) // true
 *
 * // Maps (order-independent)
 * const m1 = new Map([["a", 1], ["b", 2]])
 * const m2 = new Map([["b", 2], ["a", 1]])
 * console.log(Equal.equals(m1, m2)) // true
 *
 * // Curried form
 * const is5 = Equal.equals(5)
 * console.log(is5(5)) // true
 * console.log(is5(3)) // false
 * ```
 *
 * @see {@link Equal} — the interface for custom equality
 * @see {@link isEqual} — check whether a value implements `Equal`
 * @see {@link asEquivalence} — wrap `equals` as an `Equivalence`
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
  if (self === that) return true
  if (self == null || that == null) return false
  const selfType = typeof self
  if (selfType !== typeof that) {
    return false
  }
  // Special case for NaN: NaN should be considered equal to NaN
  if (selfType === "number" && self !== self && that !== that) {
    return true
  }
  if (selfType !== "object" && selfType !== "function") {
    return false
  }

  if (byReferenceInstances.has(self) || byReferenceInstances.has(that)) {
    return false
  }

  // For objects and functions, use cached comparison
  return withCache(self, that, compareObjects)
}

/** Helper to run comparison with proper visited tracking */
function withVisitedTracking(
  self: object,
  that: object,
  fn: () => boolean
): boolean {
  const hasLeft = visitedLeft.has(self)
  const hasRight = visitedRight.has(that)
  // Check for circular references before adding
  if (hasLeft && hasRight) {
    return true // Both are circular at the same level
  }
  if (hasLeft || hasRight) {
    return false // Only one is circular
  }
  visitedLeft.add(self)
  visitedRight.add(that)
  const result = fn()
  visitedLeft.delete(self)
  visitedRight.delete(that)
  return result
}

const visitedLeft = new WeakSet<object>()
const visitedRight = new WeakSet<object>()

/** Helper to perform cached object comparison */
function compareObjects(self: object, that: object): boolean {
  if (Hash.hash(self) !== Hash.hash(that)) {
    return false
  } else if (self instanceof Date) {
    if (!(that instanceof Date)) return false
    return self.toISOString() === that.toISOString()
  } else if (self instanceof RegExp) {
    if (!(that instanceof RegExp)) return false
    return self.toString() === that.toString()
  }
  const selfIsEqual = isEqual(self)
  const thatIsEqual = isEqual(that)
  if (selfIsEqual !== thatIsEqual) return false
  const bothEquals = selfIsEqual && thatIsEqual
  if (typeof self === "function" && !bothEquals) {
    return false
  }
  return withVisitedTracking(self, that, () => {
    if (bothEquals) {
      return (self as any)[symbol](that)
    } else if (Array.isArray(self)) {
      if (!Array.isArray(that) || self.length !== that.length) {
        return false
      }
      return compareArrays(self, that)
    } else if (ArrayBuffer.isView(self)) {
      if (!ArrayBuffer.isView(that) || self.byteLength !== that.byteLength) {
        return false
      }
      return compareTypedArrays(self as Uint8Array, that as Uint8Array)
    } else if (self instanceof Map) {
      if (!(that instanceof Map) || self.size !== that.size) {
        return false
      }
      return compareMaps(self, that)
    } else if (self instanceof Set) {
      if (!(that instanceof Set) || self.size !== that.size) {
        return false
      }
      return compareSets(self, that)
    }
    return compareRecords(self as any, that as any)
  })
}

function withCache(self: object, that: object, f: (a: any, b: any) => boolean): boolean {
  // Check cache first
  let selfMap = equalityCache.get(self)
  if (!selfMap) {
    selfMap = new WeakMap()
    equalityCache.set(self, selfMap)
  } else if (selfMap.has(that)) {
    return selfMap.get(that)!
  }

  // Perform the comparison
  const result = f(self, that)

  // Cache the result bidirectionally
  selfMap.set(that, result)

  let thatMap = equalityCache.get(that)
  if (!thatMap) {
    thatMap = new WeakMap()
    equalityCache.set(that, thatMap)
  }
  thatMap.set(self, result)

  return result
}

const equalityCache = new WeakMap<object, WeakMap<object, boolean>>()

function compareArrays(self: Array<unknown>, that: Array<unknown>): boolean {
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

  if (selfKeys.size !== thatKeys.size) {
    return false
  }

  for (const key of selfKeys) {
    if (!(thatKeys.has(key)) || !compareBoth(self[key], that[key])) {
      return false
    }
  }

  return true
}

/** @internal */
export function makeCompareMap<K, V>(keyEquivalence: Equivalence<K>, valueEquivalence: Equivalence<V>) {
  return function compareMaps(self: Iterable<[K, V]>, that: Iterable<[K, V]>): boolean {
    for (const [selfKey, selfValue] of self) {
      let found = false
      for (const [thatKey, thatValue] of that) {
        if (keyEquivalence(selfKey, thatKey) && valueEquivalence(selfValue, thatValue)) {
          found = true
          break
        }
      }
      if (!found) {
        return false
      }
    }

    return true
  }
}

const compareMaps = makeCompareMap(compareBoth, compareBoth)

/** @internal */
export function makeCompareSet<A>(equivalence: Equivalence<A>) {
  return function compareSets(self: Iterable<A>, that: Iterable<A>): boolean {
    for (const selfValue of self) {
      let found = false
      for (const thatValue of that) {
        if (equivalence(selfValue, thatValue)) {
          found = true
          break
        }
      }
      if (!found) {
        return false
      }
    }

    return true
  }
}

const compareSets = makeCompareSet(compareBoth)

/**
 * Checks whether a value implements the {@link Equal} interface.
 *
 * **When to use**
 *
 * Use when to branch on whether a value supports custom equality before calling
 *   its `[Equal.symbol]` method directly.
 * - In generic utility code that needs to distinguish `Equal` implementors
 *   from plain values.
 *
 * **Details**
 *
 * - Pure function, no side effects.
 * - Returns `true` if and only if `u` has a property keyed by
 *   {@link symbol}.
 * - Acts as a TypeScript type guard, narrowing the input to {@link Equal}.
 *
 * **Example** (Type Guard)
 *
 * ```ts
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
 * console.log(Equal.isEqual(new Token("abc"))) // true
 * console.log(Equal.isEqual({ x: 1 }))         // false
 * console.log(Equal.isEqual(42))                // false
 * ```
 *
 * @see {@link Equal} — the interface being checked
 * @see {@link symbol} — the property key that signals `Equal` support
 * @category guards
 * @since 2.0.0
 */
export const isEqual = (u: unknown): u is Equal => hasProperty(u, symbol)

/**
 * Wraps {@link equals} as an `Equivalence<A>`.
 *
 * **When to use**
 *
 * Use when when an API (e.g. `Array.dedupeWith`, `Equivalence.mapInput`) requires an
 *   `Equivalence` and you want to reuse `Equal.equals`.
 *
 * **Details**
 *
 * - Returns a function `(a: A, b: A) => boolean` that delegates to
 *   {@link equals}.
 * - Pure; allocates a thin wrapper on each call.
 *
 * **Example** (Deduplicating with Equal Semantics)
 *
 * ```ts
 * import { Array, Equal } from "effect"
 *
 * const eq = Equal.asEquivalence<number>()
 * const result = Array.dedupeWith([1, 2, 2, 3, 1], eq)
 * console.log(result) // [1, 2, 3]
 * ```
 *
 * @see {@link equals} — the underlying comparison function
 * @category instances
 * @since 4.0.0
 */
export const asEquivalence: <A>() => Equivalence<A> = () => equals

/**
 * Creates a proxy that uses reference equality instead of structural equality.
 *
 * **When to use**
 *
 * Use when when you have a plain object or array that should be compared by identity
 *   (reference), not by contents.
 * - When you want to preserve the original object unchanged and get a new
 *   reference-equal handle.
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
 * **Example** (Opting Out of Structural Equality)
 *
 * ```ts
 * import { Equal } from "effect"
 *
 * const a = { x: 1 }
 * const b = { x: 1 }
 *
 * console.log(Equal.equals(a, b)) // true  (structural)
 *
 * const aRef = Equal.byReference(a)
 * console.log(Equal.equals(aRef, b))    // false (reference)
 * console.log(Equal.equals(aRef, aRef)) // true  (same reference)
 * console.log(aRef.x)                   // 1     (proxy reads through)
 * ```
 *
 * @see {@link byReferenceUnsafe} — same effect without a proxy (mutates the
 *   original)
 * @see {@link equals} — the comparison function affected by this opt-out
 * @category utility
 * @since 4.0.0
 */
export const byReference = <T extends object>(obj: T): T => byReferenceUnsafe(new Proxy(obj, {}))

/**
 * Marks an object permanently to use reference equality, without creating a proxy.
 *
 * **When to use**
 *
 * Use when when you want reference equality semantics and can accept that the
 *   original object is **permanently** modified.
 * - When proxy overhead is unacceptable (hot paths, large collections).
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
 * **Example** (Marking an Object for Reference Equality)
 *
 * ```ts
 * import { Equal } from "effect"
 *
 * const obj1 = { a: 1, b: 2 }
 * const obj2 = { a: 1, b: 2 }
 *
 * Equal.byReferenceUnsafe(obj1)
 *
 * console.log(Equal.equals(obj1, obj2))   // false (reference)
 * console.log(Equal.equals(obj1, obj1))   // true  (same reference)
 * console.log(obj1 === Equal.byReferenceUnsafe(obj1)) // true (same object)
 * ```
 *
 * @see {@link byReference} — safer alternative that creates a proxy
 * @see {@link equals} — the comparison function affected by this opt-out
 * @category utility
 * @since 4.0.0
 */
export const byReferenceUnsafe = <T extends object>(obj: T): T => {
  byReferenceInstances.add(obj)
  return obj
}
