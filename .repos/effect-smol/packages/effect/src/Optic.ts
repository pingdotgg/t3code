/**
 * Composable, immutable accessors for reading and updating nested data
 * structures without mutation.
 *
 * **Mental model**
 *
 * - **Optic** — a first-class reference to a piece inside a larger structure.
 *   Compose optics to reach deeply nested values.
 * - **Iso** — lossless two-way conversion (`get`/`set`) between `S` and `A`.
 *   Extends both {@link Lens} and {@link Prism}.
 * - **Lens** — focuses on exactly one part of `S`. `get` always succeeds;
 *   `replace` needs the original `S` to produce the updated whole.
 * - **Prism** — focuses on a part that may not be present (e.g. a union
 *   variant). `getResult` can fail; `set` builds a new `S` from `A` alone.
 * - **Optional** — the most general optic: both reading and writing can fail.
 * - **Traversal** — focuses on zero or more elements of an array-like
 *   structure. Technically `Optional<S, ReadonlyArray<A>>`.
 * - **Hierarchy** (strongest → weakest):
 *   `Iso > Lens | Prism > Optional`. Composing a weaker optic with any other
 *   produces the weaker kind.
 *
 * **Common tasks**
 *
 * - Start a chain → {@link id} (identity iso)
 * - Drill into a struct key → `.key("name")` / `.optionalKey("name")`
 * - Drill into a key that may not exist → `.at("name")`
 * - Narrow a tagged union → `.tag("MyVariant")`
 * - Narrow by type guard → `.refine(guard)`
 * - Add validation → `.check(Schema.isGreaterThan(0))`
 * - Filter out `undefined` → `.notUndefined()`
 * - Pick/omit struct keys → `.pick(["a","b"])` / `.omit(["c"])`
 * - Traverse array elements → `.forEach(el => el.key("field"))`
 * - Build an iso → {@link makeIso}
 * - Build a lens → {@link makeLens}
 * - Build a prism → {@link makePrism}, {@link fromChecks}
 * - Build an optional → {@link makeOptional}
 * - Focus into `Option.Some` → {@link some}
 * - Focus into `Result.Success`/`Failure` → {@link success}, {@link failure}
 * - Convert record ↔ entries → {@link entries}
 * - Extract all traversal elements → {@link getAll}
 *
 * **Gotchas**
 *
 * - Updates are structurally persistent: only nodes on the path are cloned.
 *   Unrelated branches keep referential identity. However, **no-op updates
 *   may still allocate** a new root — do not rely on reference identity to
 *   detect no-ops.
 * - `replace` silently returns the original `S` when the optic cannot focus
 *   (e.g. wrong tag). Use `replaceResult` for explicit failure.
 * - `modify` also returns the original `S` on focus failure — it never throws.
 * - `.key()` and `.optionalKey()` do not work on union types (compile error).
 * - Only plain objects (`Object.prototype` or `null` prototype) and arrays can
 *   be cloned. Class instances cause a runtime error on `replace`/`modify`.
 *
 * **Quickstart**
 *
 * **Example** (reading and updating nested state)
 *
 * ```ts
 * import { Optic } from "effect"
 *
 * type State = { user: { name: string; age: number } }
 *
 * const _age = Optic.id<State>().key("user").key("age")
 *
 * const s1: State = { user: { name: "Alice", age: 30 } }
 *
 * // Read
 * console.log(_age.get(s1))
 * // Output: 30
 *
 * // Update immutably
 * const s2 = _age.replace(31, s1)
 * console.log(s2)
 * // Output: { user: { name: "Alice", age: 31 } }
 *
 * // Modify with a function
 * const s3 = _age.modify((n) => n + 1)(s1)
 * console.log(s3)
 * // Output: { user: { name: "Alice", age: 31 } }
 *
 * // Referential identity is preserved for unrelated branches
 * console.log(s2.user !== s1.user)
 * // Output: true (on the path)
 * ```
 *
 * **See also**
 *
 * - {@link id} — entry point for optic chains
 * - {@link Lens} / {@link Prism} / {@link Optional} — core optic types
 * - {@link Traversal} / {@link getAll} — multi-focus optics
 * - {@link some} / {@link success} / {@link failure} — built-in prisms
 *
 * @since 4.0.0
 */

import { format } from "./Formatter.ts"
import { identity, memoize } from "./Function.ts"
import * as Option from "./Option.ts"
import * as Predicate from "./Predicate.ts"
import * as Result from "./Result.ts"
import type * as Schema from "./Schema.ts"
import * as AST from "./SchemaAST.ts"
import type * as Issue from "./SchemaIssue.ts"
import * as Struct from "./Struct.ts"
import type { IsUnion } from "./Types.ts"

/**
 * A lossless, reversible conversion between types `S` and `A`.
 *
 * **When to use**
 *
 * Use when you have a pair of functions that convert back and forth without losing
 *   information (e.g. `Record ↔ entries`, `Celsius ↔ Fahrenheit`).
 * - You want the strongest optic that can be composed with any other.
 *
 * **Details**
 *
 * - `get(s)` always succeeds and returns an `A`.
 * - `set(a)` always succeeds and returns an `S`.
 * - `get(set(a)) === a` and `set(get(s))` equals `s` (round-trip laws).
 * - Extends both {@link Lens} and {@link Prism}.
 *
 * **Example** (Celsius ↔ Fahrenheit)
 *
 * ```ts
 * import { Optic } from "effect"
 *
 * const fahrenheit = Optic.makeIso<number, number>(
 *   (c) => c * 9 / 5 + 32,
 *   (f) => (f - 32) * 5 / 9
 * )
 *
 * console.log(fahrenheit.get(100))
 * // Output: 212
 *
 * console.log(fahrenheit.set(32))
 * // Output: 0
 * ```
 *
 * @see {@link makeIso} — constructor
 * @see {@link Lens} — when you only need a one-directional focus into a whole
 * @see {@link Prism} — when the focus may not be present
 *
 * @category Iso
 * @since 4.0.0
 */
export interface Iso<in out S, in out A> extends Lens<S, A>, Prism<S, A> {}

/**
 * Creates an {@link Iso} from a pair of conversion functions.
 *
 * **When to use**
 *
 * Use when you have two pure functions that form a lossless round-trip between `S`
 *   and `A`.
 *
 * **Details**
 *
 * - The returned optic can be composed with any other optic.
 *
 * **Example** (wrapping/unwrapping a branded type)
 *
 * ```ts
 * import { Optic } from "effect"
 *
 * type Meters = { readonly value: number }
 * const meters = Optic.makeIso<Meters, number>(
 *   (m) => m.value,
 *   (n) => ({ value: n })
 * )
 *
 * console.log(meters.get({ value: 100 }))
 * // Output: 100
 *
 * console.log(meters.set(42))
 * // Output: { value: 42 }
 * ```
 *
 * @see {@link Iso} — the type this function returns
 * @see {@link id} — identity iso (no conversion)
 *
 * @category constructors
 * @since 4.0.0
 */
export function makeIso<S, A>(get: (s: S) => A, set: (a: A) => S): Iso<S, A> {
  return make(new IsoNode(get, set))
}

/**
 * Focuses on exactly one part `A` inside a whole `S`.
 *
 * **When to use**
 *
 * Use when you always have a value to read (the part exists unconditionally).
 * - You need the original `S` to produce the updated whole (unlike
 *   {@link Iso}).
 *
 * **Details**
 *
 * - `get(s)` always succeeds and returns `A`.
 * - `replace(a, s)` returns a new `S` with the focused part replaced.
 * - Extends {@link Optional}.
 * - Composing a Lens with a {@link Prism} or {@link Optional} produces an
 *   {@link Optional}.
 *
 * **Example** (focusing on a struct field)
 *
 * ```ts
 * import { Optic } from "effect"
 *
 * type Person = { readonly name: string; readonly age: number }
 *
 * const _name = Optic.id<Person>().key("name")
 *
 * console.log(_name.get({ name: "Alice", age: 30 }))
 * // Output: "Alice"
 * ```
 *
 * @see {@link makeLens} — constructor
 * @see {@link Iso} — when conversion is lossless in both directions
 * @see {@link Optional} — when reading can also fail
 *
 * @category Lens
 * @since 4.0.0
 */
export interface Lens<in out S, in out A> extends Optional<S, A> {
  readonly get: (s: S) => A
}

/**
 * Creates a {@link Lens} from a getter and a replacer.
 *
 * **When to use**
 *
 * Use when you can always extract `A` from `S` and produce a new `S` by
 *   substituting a new `A`.
 *
 * **Details**
 *
 * - `replace(a, s)` should return a structurally new `S` with `a` in place
 *   of the old focus.
 *
 * **Example** (lens into the first element of a pair)
 *
 * ```ts
 * import { Optic } from "effect"
 *
 * const _first = Optic.makeLens<readonly [string, number], string>(
 *   (pair) => pair[0],
 *   (s, pair) => [s, pair[1]]
 * )
 *
 * console.log(_first.get(["hello", 42]))
 * // Output: "hello"
 *
 * console.log(_first.replace("world", ["hello", 42]))
 * // Output: ["world", 42]
 * ```
 *
 * @see {@link Lens} — the type this function returns
 * @see {@link makeIso} — when no original `S` is needed for `set`
 *
 * @category constructors
 * @since 4.0.0
 */
export function makeLens<S, A>(get: (s: S) => A, replace: (a: A, s: S) => S): Lens<S, A> {
  return make(new LensNode(get, replace))
}

/**
 * Focuses on a part `A` of `S` that may not be present (e.g. a union
 * variant or a validated subset).
 *
 * **When to use**
 *
 * Use when the focus is conditional — reading can fail (wrong variant, failed
 *   validation).
 * - Building a new `S` from `A` does **not** require the original `S`.
 *
 * **Details**
 *
 * - `getResult(s)` returns `Result.Success<A>` when the focus matches, or
 *   `Result.Failure<string>` with an error message.
 * - `set(a)` always succeeds and returns a new `S`.
 * - Extends {@link Optional}.
 * - Composing two Prisms produces a Prism; composing a Prism with a
 *   {@link Lens} produces an {@link Optional}.
 *
 * **Example** (narrowing a tagged union)
 *
 * ```ts
 * import { Optic, Result } from "effect"
 *
 * type Shape =
 *   | { readonly _tag: "Circle"; readonly radius: number }
 *   | { readonly _tag: "Rect"; readonly width: number }
 *
 * const _circle = Optic.id<Shape>().tag("Circle")
 *
 * console.log(Result.isSuccess(_circle.getResult({ _tag: "Circle", radius: 5 })))
 * // Output: true
 *
 * console.log(Result.isFailure(_circle.getResult({ _tag: "Rect", width: 10 })))
 * // Output: true
 * ```
 *
 * @see {@link makePrism} — constructor
 * @see {@link fromChecks} — build a Prism from schema checks
 * @see {@link Lens} — when reading always succeeds
 *
 * @category Prism
 * @since 4.0.0
 */
export interface Prism<in out S, in out A> extends Optional<S, A> {
  readonly set: (a: A) => S
}

/**
 * Creates a {@link Prism} from a fallible getter and an infallible setter.
 *
 * **When to use**
 *
 * Use when reading can fail (the part may not exist in `S`), but building `S`
 *   from `A` always succeeds.
 *
 * **Details**
 *
 * - `getResult` should return `Result.fail(message)` on mismatch.
 *
 * **Example** (parsing a string to a number)
 *
 * ```ts
 * import { Optic, Result } from "effect"
 *
 * const numeric = Optic.makePrism<string, number>(
 *   (s) => {
 *     const n = Number(s)
 *     return Number.isNaN(n) ? Result.fail("not a number") : Result.succeed(n)
 *   },
 *   String
 * )
 *
 * console.log(Result.isSuccess(numeric.getResult("42")))
 * // Output: true
 *
 * console.log(numeric.set(42))
 * // Output: "42"
 * ```
 *
 * @see {@link Prism} — the type this function returns
 * @see {@link fromChecks} — build from `Schema` checks instead
 *
 * @category constructors
 * @since 4.0.0
 */
export function makePrism<S, A>(getResult: (s: S) => Result.Result<A, string>, set: (a: A) => S): Prism<S, A> {
  return make(new PrismNode(getResult, set))
}

/**
 * Creates a {@link Prism} from one or more `Schema` validation checks.
 *
 * **When to use**
 *
 * Use when you want to narrow `T` to the subset that passes certain validation
 *   rules (e.g. positive integer).
 * - You already have `Schema.isGreaterThan`, `Schema.isInt`, etc.
 *
 * **Details**
 *
 * - `getResult` runs all checks; fails with a combined error message when
 *   any check fails.
 * - `set` is identity — the value passes through unchanged.
 *
 * **Example** (positive integer prism)
 *
 * ```ts
 * import { Optic, Result, Schema } from "effect"
 *
 * const posInt = Optic.fromChecks<number>(
 *   Schema.isGreaterThan(0),
 *   Schema.isInt()
 * )
 *
 * console.log(Result.isSuccess(posInt.getResult(3)))
 * // Output: true
 *
 * console.log(Result.isFailure(posInt.getResult(-1)))
 * // Output: true
 * ```
 *
 * @see {@link makePrism} — constructor with custom getter/setter
 * @see {@link Prism} — the type this function returns
 *
 * @category constructors
 * @since 4.0.0
 */
export function fromChecks<T>(...checks: readonly [AST.Check<T>, ...Array<AST.Check<T>>]): Prism<T, T> {
  return make(new CheckNode(checks))
}

type Node =
  | IdentityNode
  | IsoNode<any, any>
  | LensNode<any, any>
  | PrismNode<any, any>
  | OptionalNode<any, any>
  | PathNode
  | CheckNode<any>
  | CompositionNode

class IdentityNode {
  readonly _tag = "IdentityNode"
}

const identityNode = new IdentityNode()

class CompositionNode {
  readonly _tag = "CompositionNode"
  readonly nodes: readonly [Node, ...Array<Node>]

  constructor(nodes: readonly [Node, ...Array<Node>]) {
    this.nodes = nodes
  }
}

class IsoNode<S, A> {
  readonly _tag = "IsoNode"
  readonly get: (s: S) => A
  readonly set: (a: A) => S

  constructor(get: (s: S) => A, set: (a: A) => S) {
    this.get = get
    this.set = set
  }
}

class LensNode<S, A> {
  readonly _tag = "LensNode"
  readonly get: (s: S) => A
  readonly set: (a: A, s: S) => S

  constructor(get: (s: S) => A, set: (a: A, s: S) => S) {
    this.get = get
    this.set = set
  }
}

class PrismNode<S, A> {
  readonly _tag = "PrismNode"
  readonly get: (s: S) => Result.Result<A, string>
  readonly set: (a: A) => S

  constructor(get: (s: S) => Result.Result<A, string>, set: (a: A) => S) {
    this.get = get
    this.set = set
  }
}

class OptionalNode<S, A> {
  readonly _tag = "OptionalNode"
  readonly get: (s: S) => Result.Result<A, string>
  readonly set: (a: A, s: S) => Result.Result<S, string>

  constructor(get: (s: S) => Result.Result<A, string>, set: (a: A, s: S) => Result.Result<S, string>) {
    this.get = get
    this.set = set
  }
}

class PathNode {
  readonly _tag = "PathNode"
  readonly path: ReadonlyArray<PropertyKey>

  constructor(path: ReadonlyArray<PropertyKey>) {
    this.path = path
  }
}

class CheckNode<T> {
  readonly _tag = "CheckNode"
  readonly checks: readonly [AST.Check<T>, ...Array<AST.Check<T>>]

  constructor(checks: readonly [AST.Check<T>, ...Array<AST.Check<T>>]) {
    this.checks = checks
  }
}

// Nodes that can appear in a normalized chain (no Identity/Composition)
type NormalizedNode = Exclude<Node, IdentityNode | CompositionNode>

// Fuse with tail when possible, else push.
function pushNormalized(acc: Array<NormalizedNode>, node: NormalizedNode): void {
  const last = acc[acc.length - 1]
  if (last) {
    if (last._tag === "PathNode" && node._tag === "PathNode") {
      // fuse Path
      acc[acc.length - 1] = new PathNode([...last.path, ...node.path])
      return
    }
    if (last._tag === "CheckNode" && node._tag === "CheckNode") {
      // fuse Checks
      acc[acc.length - 1] = new CheckNode<any>([...last.checks, ...node.checks])
      return
    }
  }
  acc.push(node)
}

// Collect nodes from a node into `acc`, flattening & normalizing on the fly.
function collect(node: Node, acc: Array<NormalizedNode>): void {
  if (node._tag === "IdentityNode") return
  if (node._tag === "CompositionNode") {
    // flatten without extra arrays
    for (let i = 0; i < node.nodes.length; i++) collect(node.nodes[i], acc)
    return
  }
  // primitive node
  pushNormalized(acc, node)
}

function compose(a: Node, b: Node): Node {
  const nodes: Array<NormalizedNode> = []
  collect(a, nodes)
  collect(b, nodes)

  switch (nodes.length) {
    case 0:
      return identityNode
    case 1:
      return nodes[0]
    default:
      return new CompositionNode(nodes as [Node, ...Array<Node>])
  }
}

type ForbidUnion<A, Message extends string> = IsUnion<A> extends true ? [Message] : []

/**
 * The most general optic — both reading and writing can fail.
 *
 * **When to use**
 *
 * Use when the focus may not exist in `S` and writing a new `A` back may also
 * fail, for example when the source no longer matches the expected shape. This
 * is the base type extended by {@link Iso}, {@link Lens}, {@link Prism}, and
 * {@link Traversal}.
 *
 * **Details**
 *
 * - `getResult(s)` returns `Result.Success<A>` or `Result.Failure<string>`.
 * - `replaceResult(a, s)` returns `Result.Success<S>` or
 *   `Result.Failure<string>`.
 * - `replace(a, s)` returns the original `s` on failure (never throws).
 * - `modify(f)` returns the original `s` on failure (never throws).
 * - All operations are pure; inputs are never mutated.
 *
 * **Example** (record key that may be absent)
 *
 * ```ts
 * import { Optic, Result } from "effect"
 *
 * type Env = { [key: string]: string }
 * const _home = Optic.id<Env>().at("HOME")
 *
 * console.log(Result.isSuccess(_home.getResult({ HOME: "/root" })))
 * // Output: true
 *
 * console.log(Result.isFailure(_home.getResult({ PATH: "/bin" })))
 * // Output: true
 *
 * // replace returns original on failure
 * console.log(_home.replace("/new", { PATH: "/bin" }))
 * // Output: { PATH: "/bin" }
 * ```
 *
 * @see {@link makeOptional} — constructor
 * @see {@link Lens} — when reading always succeeds
 * @see {@link Prism} — when writing always succeeds
 *
 * @category Optional
 * @since 4.0.0
 */
export interface Optional<in out S, in out A> {
  readonly node: Node
  /**
   * Attempts to read the focus `A` from the whole `S`. Returns
   * `Result.Success<A>` when the focus exists, or
   * `Result.Failure<string>` with a descriptive error otherwise.
   */
  readonly getResult: (s: S) => Result.Result<A, string>
  /**
   * Replaces the focus in `S` with a new `A`. Returns the original `s`
   * unchanged when the optic cannot focus (never throws).
   */
  readonly replace: (a: A, s: S) => S
  /**
   * Like {@link replace}, but returns an explicit `Result` so callers can
   * detect and handle failure.
   */
  readonly replaceResult: (a: A, s: S) => Result.Result<S, string>
  /**
   * Composes this optic with another. The result type is the weakest of
   * the two: Iso + Iso = Iso, Lens + Prism = Optional, etc.
   *
   * **Example** (composing a lens with a prism)
   *
   * ```ts
   * import { Optic, Option } from "effect"
   *
   * type State = { value: Option.Option<number> }
   *
   * const _inner = Optic.id<State>().key("value").compose(Optic.some())
   * // _inner is Optional<State, number>
   * ```
   *
   * @see {@link id} — start a composition chain
   */
  compose<B>(this: Iso<S, A>, that: Iso<A, B>): Iso<S, B>
  compose<B>(this: Lens<S, A>, that: Lens<A, B>): Lens<S, B>
  compose<B>(this: Prism<S, A>, that: Prism<A, B>): Prism<S, B>
  compose<B>(this: Optional<S, A>, that: Optional<A, B>): Optional<S, B>

  /**
   * Returns a function `(s: S) => S` that applies `f` to the focused value.
   * If the optic cannot focus, the original `s` is returned unchanged.
   *
   * **Example** (incrementing a nested field)
   *
   * ```ts
   * import { Optic } from "effect"
   *
   * type S = { readonly a: { readonly b: number } }
   * const _b = Optic.id<S>().key("a").key("b")
   *
   * const inc = _b.modify((n) => n + 1)
   * console.log(inc({ a: { b: 1 } }))
   * // Output: { a: { b: 2 } }
   * ```
   */
  modify(f: (a: A) => A): (s: S) => S

  /**
   * Focuses on a property of the current struct/tuple focus.
   *
   * **Details**
   *
   * - On a {@link Lens}, returns a Lens.
   * - On an {@link Optional}, returns an Optional.
   * - Does **not** work on union types (compile error).
   *
   * **Example** (drilling into nested structs)
   *
   * ```ts
   * import { Optic } from "effect"
   *
   * type S = { readonly a: { readonly b: number } }
   * const _b = Optic.id<S>().key("a").key("b")
   *
   * console.log(_b.get({ a: { b: 42 } }))
   * // Output: 42
   * ```
   */
  key<S, A extends object, Key extends keyof A>(
    this: Lens<S, A>,
    key: Key,
    ..._err: ForbidUnion<A, "cannot use `key` on a union type">
  ): Lens<S, A[Key]>
  key<S, A extends object, Key extends keyof A>(
    this: Optional<S, A>,
    key: Key,
    ..._err: ForbidUnion<A, "cannot use `key` on a union type">
  ): Optional<S, A[Key]>

  /**
   * Focuses on a key where setting `undefined` **removes** the key from the
   * struct (or splices the element from an array/tuple).
   *
   * **Details**
   *
   * - The focus type becomes `A[Key] | undefined`.
   * - Does **not** work on union types (compile error).
   *
   * **Example** (deleting an optional key)
   *
   * ```ts
   * import { Optic } from "effect"
   *
   * type S = { readonly a?: number }
   * const _a = Optic.id<S>().optionalKey("a")
   *
   * console.log(_a.replace(undefined, { a: 1 }))
   * // Output: {}
   *
   * console.log(_a.replace(2, {}))
   * // Output: { a: 2 }
   * ```
   */
  optionalKey<S, A extends object, Key extends keyof A>(
    this: Lens<S, A>,
    key: Key,
    ..._err: ForbidUnion<A, "cannot use `optionalKey` on a union type">
  ): Lens<S, A[Key] | undefined>
  optionalKey<S, A extends object, Key extends keyof A>(
    this: Optional<S, A>,
    key: Key,
    ..._err: ForbidUnion<A, "cannot use `optionalKey` on a union type">
  ): Optional<S, A[Key] | undefined>

  /**
   * Adds one or more `Schema` validation checks to the optic chain.
   * `getResult` fails when any check fails; `set` passes through unchanged.
   *
   * **Details**
   *
   * - On a {@link Prism}, returns a Prism.
   * - On an {@link Optional}, returns an Optional.
   *
   * **Example** (only focus positive numbers)
   *
   * ```ts
   * import { Optic, Result, Schema } from "effect"
   *
   * const _pos = Optic.id<number>().check(Schema.isGreaterThan(0))
   *
   * console.log(Result.isSuccess(_pos.getResult(5)))
   * // Output: true
   *
   * console.log(Result.isFailure(_pos.getResult(-1)))
   * // Output: true
   * ```
   *
   * @see {@link fromChecks} — standalone prism from checks
   */
  check<S, A>(this: Prism<S, A>, ...checks: readonly [AST.Check<A>, ...Array<AST.Check<A>>]): Prism<S, A>
  check<S, A>(this: Optional<S, A>, ...checks: readonly [AST.Check<A>, ...Array<AST.Check<A>>]): Optional<S, A>

  /**
   * Narrows the focus to a subtype `B` using a type guard.
   *
   * **Details**
   *
   * - On a {@link Prism}, returns a Prism.
   * - On an {@link Optional}, returns an Optional.
   * - Pass optional `annotations` to customize the error message.
   *
   * **Example** (narrowing a union)
   *
   * ```ts
   * import { Optic, Result } from "effect"
   *
   * type B = { readonly _tag: "b"; readonly b: number }
   * type S = { readonly _tag: "a"; readonly a: string } | B
   *
   * const _b = Optic.id<S>().refine(
   *   (s: S): s is B => s._tag === "b",
   *   { expected: `"b" tag` }
   * )
   *
   * console.log(Result.isSuccess(_b.getResult({ _tag: "b", b: 1 })))
   * // Output: true
   * ```
   *
   * @see `.tag()` — shorthand for narrowing by `_tag`
   */
  refine<S, A, B extends A>(
    this: Prism<S, A>,
    refinement: (a: A) => a is B,
    annotations?: Schema.Annotations.Filter
  ): Prism<S, B>
  refine<S, A, B extends A>(
    this: Optional<S, A>,
    refinement: (a: A) => a is B,
    annotations?: Schema.Annotations.Filter
  ): Optional<S, B>

  /**
   * Narrows the focus to the variant of a tagged union with the given
   * `_tag` value.
   *
   * **Details**
   *
   * - On a {@link Prism}, returns a Prism.
   * - On an {@link Optional}, returns an Optional.
   * - Shorthand for `.refine(s => s._tag === tag)`.
   *
   * **Example** (focusing a tagged variant)
   *
   * ```ts
   * import { Optic, Result } from "effect"
   *
   * type Shape =
   *   | { readonly _tag: "Circle"; readonly radius: number }
   *   | { readonly _tag: "Rect"; readonly width: number }
   *
   * const _radius = Optic.id<Shape>().tag("Circle").key("radius")
   *
   * console.log(Result.isSuccess(_radius.getResult({ _tag: "Circle", radius: 5 })))
   * // Output: true
   *
   * console.log(Result.isFailure(_radius.getResult({ _tag: "Rect", width: 10 })))
   * // Output: true
   * ```
   *
   * @see `.refine()` — for arbitrary type guards
   */
  tag<S, A extends { readonly _tag: AST.LiteralValue }, Tag extends A["_tag"]>(
    this: Prism<S, A>,
    tag: Tag
  ): Prism<S, Extract<A, { readonly _tag: Tag }>>
  tag<S, A extends { readonly _tag: AST.LiteralValue }, Tag extends A["_tag"]>(
    this: Optional<S, A>,
    tag: Tag
  ): Optional<S, Extract<A, { readonly _tag: Tag }>>

  /**
   * Focuses on a key only if it exists (`Object.hasOwn`). Both
   * `getResult` and `replaceResult` fail when the key is absent.
   *
   * **Details**
   *
   * Unlike `.key()`, which always succeeds on the read side, `.at()` is
   * useful for Records or arrays where the key/index may not be present.
   *
   * - Always returns an {@link Optional}.
   * - Does **not** work on union types (compile error).
   *
   * **Example** (safe record access)
   *
   * ```ts
   * import { Optic, Result } from "effect"
   *
   * type Env = { [key: string]: number }
   * const _x = Optic.id<Env>().at("x")
   *
   * console.log(Result.isSuccess(_x.getResult({ x: 1 })))
   * // Output: true
   *
   * console.log(Result.isFailure(_x.getResult({ y: 2 })))
   * // Output: true
   * ```
   *
   * @see `.key()` — when the key is always present
   */
  at<S, A extends object, Key extends keyof A>(
    this: Optional<S, A>,
    key: Key,
    ..._err: ForbidUnion<A, "cannot use `at` on a union type">
  ): Optional<S, A[Key]>

  /**
   * Focuses on a subset of keys of the current struct focus.
   *
   * **Details**
   *
   * - On a {@link Lens}, returns a Lens.
   * - On an {@link Optional}, returns an Optional.
   * - Does **not** work on union types (compile error).
   *
   * **Example** (picking keys)
   *
   * ```ts
   * import { Optic } from "effect"
   *
   * type S = { readonly a: string; readonly b: number; readonly c: boolean }
   *
   * const _ac = Optic.id<S>().pick(["a", "c"])
   *
   * console.log(_ac.get({ a: "hi", b: 1, c: true }))
   * // Output: { a: "hi", c: true }
   * ```
   *
   * @see `.omit()` — the inverse operation
   */
  pick<S, A, Keys extends ReadonlyArray<keyof A>>(
    this: Lens<S, A>,
    keys: Keys,
    ..._err: ForbidUnion<A, "cannot use `pick` on a union type">
  ): Lens<S, Pick<A, Keys[number]>>
  pick<S, A, Keys extends ReadonlyArray<keyof A>>(
    this: Optional<S, A>,
    keys: Keys,
    ..._err: ForbidUnion<A, "cannot use `pick` on a union type">
  ): Optional<S, Pick<A, Keys[number]>>

  /**
   * Focuses on all keys **except** the specified ones.
   *
   * **Details**
   *
   * - On a {@link Lens}, returns a Lens.
   * - On an {@link Optional}, returns an Optional.
   * - Does **not** work on union types (compile error).
   *
   * **Example** (omitting keys)
   *
   * ```ts
   * import { Optic } from "effect"
   *
   * type S = { readonly a: string; readonly b: number; readonly c: boolean }
   *
   * const _ac = Optic.id<S>().omit(["b"])
   *
   * console.log(_ac.get({ a: "hi", b: 1, c: true }))
   * // Output: { a: "hi", c: true }
   * ```
   *
   * @see `.pick()` — the inverse operation
   *
   * @since 4.0.0
   */
  omit<S, A, Keys extends ReadonlyArray<keyof A>>(
    this: Lens<S, A>,
    keys: Keys,
    ..._err: ForbidUnion<A, "cannot use `omit` on a union type">
  ): Lens<S, Omit<A, Keys[number]>>
  omit<S, A, Keys extends ReadonlyArray<keyof A>>(
    this: Optional<S, A>,
    keys: Keys,
    ..._err: ForbidUnion<A, "cannot use `omit` on a union type">
  ): Optional<S, Omit<A, Keys[number]>>

  /**
   * Filters out `undefined` from the focus, producing a {@link Prism}.
   * `getResult` fails when the focus is `undefined`.
   *
   * **Example** (filtering undefined)
   *
   * ```ts
   * import { Optic, Result } from "effect"
   *
   * const _defined = Optic.id<number | undefined>().notUndefined()
   *
   * console.log(Result.isSuccess(_defined.getResult(42)))
   * // Output: true
   *
   * console.log(Result.isFailure(_defined.getResult(undefined)))
   * // Output: true
   * ```
   *
   * @since 4.0.0
   */
  notUndefined(): Prism<S, Exclude<A, undefined>>
  notUndefined(): Optional<S, Exclude<A, undefined>>

  /**
   * Focuses **all elements** of an array-like focus and optionally narrows
   * to a subset using an element-level optic.
   * Available only on {@link Traversal} (i.e. when `A` is
   * `ReadonlyArray<Element>`). Returns a new Traversal focused on the
   * selected elements.
   *
   * **Details**
   *
   * - **getResult** collects the values focused by `f(id<A>())` for each
   *   element. Non-focusable elements are skipped.
   * - **replaceResult** expects exactly as many values as were collected by
   *   `getResult` and writes them back in order. Fails with a
   *   length-mismatch error if counts differ.
   *
   * **Example** (incrementing liked posts)
   *
   * ```ts
   * import { Optic, Schema } from "effect"
   *
   * type Post = { title: string; likes: number }
   * type S = { user: { posts: ReadonlyArray<Post> } }
   *
   * const _likes = Optic.id<S>()
   *   .key("user")
   *   .key("posts")
   *   .forEach((post) => post.key("likes").check(Schema.isGreaterThan(0)))
   *
   * const addLike = _likes.modifyAll((n) => n + 1)
   *
   * console.log(
   *   addLike({
   *     user: { posts: [{ title: "a", likes: 0 }, { title: "b", likes: 1 }] }
   *   })
   * )
   * // Output: { user: { posts: [{ title: "a", likes: 0 }, { title: "b", likes: 2 }] } }
   * ```
   *
   * @see {@link getAll} — extract all focused elements as an array
   * @see `.modifyAll()` — apply a function to every focused element
   */
  forEach<S, A, B>(this: Traversal<S, A>, f: (iso: Iso<A, A>) => Optional<A, B>): Traversal<S, B>

  /**
   * Applies a function to **every** element focused by the traversal.
   *
   * **Details**
   *
   * Available only on {@link Traversal}. Returns a function `(s: S) => S`.
   * If the traversal cannot focus, the original `s` is returned unchanged.
   *
   * Unlike `.modify()`, which operates on the whole array, `modifyAll`
   * maps `f` over each individual element.
   *
   * **Example** (doubling all focused values)
   *
   * ```ts
   * import { Optic, Schema } from "effect"
   *
   * type S = { readonly items: ReadonlyArray<number> }
   *
   * const _positive = Optic.id<S>()
   *   .key("items")
   *   .forEach((n) => n.check(Schema.isGreaterThan(0)))
   *
   * const doubled = _positive.modifyAll((n) => n * 2)
   *
   * console.log(doubled({ items: [1, -2, 3] }))
   * // Output: { items: [2, -2, 6] }
   * ```
   *
   * @see `.forEach()` — create a sub-traversal
   * @see {@link getAll} — extract focused elements
   */
  modifyAll<S, A>(this: Traversal<S, A>, f: (a: A) => A): (s: S) => S
}

/**
 * Creates an {@link Optional} from a fallible getter and a fallible setter.
 *
 * **When to use**
 *
 * Use when both reading and writing can fail.
 *
 * **Details**
 *
 * - `getResult` should return `Result.fail(message)` on mismatch.
 * - `set` should return `Result.fail(message)` when the update cannot be
 *   applied.
 *
 * **Example** (safe record key access)
 *
 * ```ts
 * import { Optic, Result } from "effect"
 *
 * const atKey = (key: string) =>
 *   Optic.makeOptional<Record<string, number>, number>(
 *     (s) =>
 *       Object.hasOwn(s, key)
 *         ? Result.succeed(s[key])
 *         : Result.fail(`Key "${key}" not found`),
 *     (a, s) =>
 *       Object.hasOwn(s, key)
 *         ? Result.succeed({ ...s, [key]: a })
 *         : Result.fail(`Key "${key}" not found`)
 *   )
 *
 * console.log(Result.isSuccess(atKey("x").getResult({ x: 1 })))
 * // Output: true
 * ```
 *
 * @see {@link Optional} — the type this function returns
 * @see {@link makeLens} — when reading always succeeds
 * @see {@link makePrism} — when writing always succeeds
 *
 * @category constructors
 * @since 4.0.0
 */
export function makeOptional<S, A>(
  getResult: (s: S) => Result.Result<A, string>,
  set: (a: A, s: S) => Result.Result<S, string>
): Optional<S, A> {
  return make(new OptionalNode(getResult, set))
}

/**
 * An optic that focuses on **zero or more** elements of type `A` inside `S`.
 *
 * **When to use**
 *
 * Use when you want to read/update multiple elements at once (e.g. all items in
 *   an array, or a filtered subset).
 *
 * **Details**
 *
 * - Technically `Optional<S, ReadonlyArray<A>>` — the focused value is an
 *   array of all matched elements.
 * - Use `.forEach()` to add per-element sub-optics (filtering, drilling
 *   deeper).
 * - Use `.modifyAll(f)` to map a function over every focused element.
 * - Use {@link getAll} to extract all focused elements as a plain array.
 *
 * **Example** (traversing array elements with a filter)
 *
 * ```ts
 * import { Optic, Schema } from "effect"
 *
 * type S = { readonly items: ReadonlyArray<number> }
 *
 * const _positive = Optic.id<S>()
 *   .key("items")
 *   .forEach((n) => n.check(Schema.isGreaterThan(0)))
 *
 * const getPositive = Optic.getAll(_positive)
 *
 * console.log(getPositive({ items: [1, -2, 3] }))
 * // Output: [1, 3]
 * ```
 *
 * @see {@link getAll} — extract focused elements
 * @see {@link Optional} — the base type
 *
 * @category Traversal
 * @since 4.0.0
 */
export interface Traversal<in out S, in out A> extends Optional<S, ReadonlyArray<A>> {}

class OptionalImpl<S, A> implements Optional<S, A> {
  readonly node: Node
  readonly getResult: (s: S) => Result.Result<A, string>
  readonly replaceResult: (a: A, s: S) => Result.Result<S, string>
  constructor(
    node: Node,
    getResult: (s: S) => Result.Result<A, string>,
    replaceResult: (a: A, s: S) => Result.Result<S, string>
  ) {
    this.node = node
    this.getResult = getResult
    this.replaceResult = replaceResult
  }
  replace(a: A, s: S): S {
    return Result.getOrElse(this.replaceResult(a, s), () => s)
  }
  modify(f: (a: A) => A): (s: S) => S {
    return (s) => Result.getOrElse(Result.flatMap(this.getResult(s), (a) => this.replaceResult(f(a), s)), () => s)
  }
  compose(that: any): any {
    return make(compose(this.node, that.node))
  }
  key(key: PropertyKey): any {
    return make(compose(this.node, new PathNode([key])))
  }
  optionalKey(key: PropertyKey): any {
    return make(
      compose(
        this.node,
        new LensNode(
          (s) => s[key],
          (a, s) => {
            const copy = cloneShallow(s)
            if (a === undefined) {
              if (Array.isArray(copy) && typeof key === "number") {
                copy.splice(key, 1)
              } else {
                delete copy[key]
              }
            } else {
              copy[key] = a
            }
            return copy
          }
        )
      )
    )
  }
  check(...checks: readonly [AST.Check<any>, ...Array<AST.Check<any>>]): any {
    return make(compose(this.node, new CheckNode(checks)))
  }
  refine<B extends A>(refinement: (a: A) => a is B, annotations?: Schema.Annotations.Filter): any {
    return make(compose(this.node, new CheckNode([AST.makeFilterByGuard(refinement, annotations)])))
  }
  tag(tag: string): any {
    return make(
      compose(
        this.node,
        new PrismNode(
          (s) =>
            s._tag === tag
              ? Result.succeed(s)
              : Result.fail(`Expected ${format(tag)} tag, got ${format(s._tag)}`),
          identity
        )
      )
    )
  }
  at(key: PropertyKey, ..._rest: Array<any>): any {
    const err = Result.fail(`Key ${format(key)} not found`)
    return make(
      compose(
        this.node,
        new OptionalNode(
          (s) => Object.hasOwn(s, key) ? Result.succeed(s[key]) : err,
          (a, s) => {
            if (Object.hasOwn(s, key)) {
              const copy = cloneShallow(s)
              copy[key] = a
              return Result.succeed(copy)
            } else {
              return err
            }
          }
        )
      )
    )
  }
  pick(keys: any) {
    return this.compose(makeLens(Struct.pick(keys), (p, a) => ({ ...a, ...p })))
  }
  omit(keys: any) {
    return this.compose(makeLens(Struct.omit(keys), (o, a) => ({ ...a, ...o })))
  }
  notUndefined(): Prism<S, Exclude<A, undefined>> {
    return this.refine(Predicate.isNotUndefined, { expected: "a value other than `undefined`" })
  }
  forEach<S, A, B>(this: Traversal<S, A>, f: (iso: Iso<A, A>) => Optional<A, B>): Traversal<S, B> {
    const inner = f(id<A>())
    return makeOptional<S, ReadonlyArray<B>>(
      // GET: collect focused Bs
      (s) =>
        Result.map(this.getResult(s), (as) => {
          const bs: Array<B> = []
          for (let i = 0; i < as.length; i++) {
            const r = inner.getResult(as[i])
            if (Result.isSuccess(r)) bs.push(r.success)
          }
          return bs
        }),
      // SET: bs must match the number of focusable elements
      (bs, s) =>
        Result.flatMap(this.getResult(s), (as) => {
          // 1) collect focusable indices
          const idxs: Array<number> = []
          for (let i = 0; i < as.length; i++) {
            if (Result.isSuccess(inner.getResult(as[i]))) idxs.push(i)
          }

          // 2) arity check
          if (bs.length !== idxs.length) {
            return Result.fail(
              `each: replacement length mismatch: ${bs.length} !== ${idxs.length}`
            )
          }

          // 3) update those indices
          const out: Array<A> = as.slice()
          for (let k = 0; k < idxs.length; k++) {
            const i = idxs[k]
            const r = inner.replaceResult(bs[k], as[i])
            if (Result.isFailure(r)) {
              return Result.fail(`each: could not set element ${i}`)
            }
            out[i] = r.success
          }
          return this.replaceResult(out, s)
        })
    )
  }
  modifyAll<S, A>(this: Traversal<S, A>, f: (a: A) => A): (s: S) => S {
    return (s) =>
      Result.getOrElse(
        Result.flatMap(this.getResult(s), (as) => this.replaceResult(as.map(f), s)),
        () => s
      )
  }
}

class IsoImpl<S, A> extends OptionalImpl<S, A> implements Iso<S, A> {
  readonly get: (s: S) => A
  readonly set: (a: A) => S
  constructor(node: Node, get: (s: S) => A, set: (a: A) => S) {
    super(node, (s) => Result.succeed(get(s)), (a) => Result.succeed(set(a)))
    this.get = get
    this.set = set
  }
  override replace(a: A, _: S): S {
    return this.set(a)
  }
  override modify(f: (a: A) => A): (s: S) => S {
    return (s) => this.set(f(this.get(s)))
  }
}

class LensImpl<S, A> extends OptionalImpl<S, A> implements Lens<S, A> {
  readonly get: (s: S) => A
  constructor(node: Node, get: (s: S) => A, replace: (a: A, s: S) => S) {
    super(node, (s) => Result.succeed(get(s)), (a, s) => Result.succeed(replace(a, s)))
    this.get = get
    this.replace = replace
  }
  override modify(f: (a: A) => A): (s: S) => S {
    return (s) => this.replace(f(this.get(s)), s)
  }
}

class PrismImpl<S, A> extends OptionalImpl<S, A> implements Prism<S, A> {
  readonly set: (a: A) => S
  constructor(node: Node, getResult: (s: S) => Result.Result<A, string>, set: (a: A) => S) {
    super(node, getResult, (a, _) => Result.succeed(set(a)))
    this.set = set
  }
  override replace(a: A, _: S): S {
    return this.set(a)
  }
  override modify(f: (a: A) => A): (s: S) => S {
    return (s) => Result.getOrElse(Result.map(this.getResult(s), (a) => this.set(f(a))), () => s)
  }
}

function make(node: Node): any {
  const op = recur(node)
  switch (op._tag) {
    case "IsoNode":
      return new IsoImpl(node, op.get, op.set)
    case "LensNode":
      return new LensImpl(node, op.get, op.set)
    case "PrismNode":
      return new PrismImpl(node, op.get, op.set)
    case "OptionalNode":
      return new OptionalImpl(node, op.get, op.set)
  }
}

function cloneShallow<T>(pojo: T): T {
  if (Array.isArray(pojo)) return pojo.slice() as T
  if (typeof pojo === "object" && pojo !== null) {
    const proto = Object.getPrototypeOf(pojo)
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("Cannot clone object with non-Object constructor or null prototype")
    }
    return { ...pojo } as T
  }
  return pojo
}

type Op = {
  readonly _tag: "IsoNode" | "LensNode" | "PrismNode" | "OptionalNode"
  readonly get: (s: unknown) => any
  readonly set: (a: unknown, s?: unknown) => any
}

const recur = memoize((node: Node): Op => {
  switch (node._tag) {
    case "IdentityNode":
      return { _tag: "IsoNode", get: identity, set: identity }
    case "IsoNode":
    case "LensNode":
    case "PrismNode":
    case "OptionalNode":
      return { _tag: node._tag, get: node.get, set: node.set }
    case "PathNode": {
      return {
        _tag: "LensNode",
        get: (s: any) => {
          const path = node.path
          let out: any = s
          for (let i = 0, n = path.length; i < n; i++) {
            out = out[path[i]]
          }
          return out
        },
        set: (a: any, s: any) => {
          const path = node.path
          const out = cloneShallow(s)

          let current = out
          let i = 0
          for (; i < path.length - 1; i++) {
            const key = path[i]
            current[key] = cloneShallow(current[key])
            current = current[key]
          }

          const finalKey = path[i]
          current[finalKey] = a

          return out
        }
      }
    }
    case "CheckNode":
      return {
        _tag: "PrismNode",
        get: (s: any) => Result.mapError(AST.runChecks(node.checks, s), String),
        set: identity
      }
    case "CompositionNode": {
      const ops = node.nodes.map(recur)
      const _tag = ops.reduce<Op["_tag"]>((tag, op) => getCompositionTag(tag, op._tag), "IsoNode")
      return {
        _tag,
        get: (s: any) => {
          for (let i = 0; i < ops.length; i++) {
            const op = ops[i]
            const result = op.get(s)
            if (hasFailingGet(op._tag)) {
              if (Result.isFailure(result)) {
                return result
              }
              s = result.success
            } else {
              s = result
            }
          }
          return hasFailingGet(_tag) ? Result.succeed(s) : s
        },
        set: (a: any, s: any) => {
          const source = s
          const len = ops.length
          const ss = new Array(len + 1)
          ss[0] = s
          for (let i = 0; i < len; i++) {
            const op = ops[i]
            if (hasFailingGet(op._tag)) {
              const result = op.get(s)
              if (Result.isFailure(result)) {
                return _tag === "OptionalNode" ? result : source
              }
              s = result.success
            } else {
              s = op.get(s)
            }
            ss[i + 1] = s
          }
          for (let i = len - 1; i >= 0; i--) {
            const op = ops[i]
            if (hasSet(op._tag)) {
              a = op.set(a)
            } else if (op._tag === "LensNode") {
              a = op.set(a, ss[i])
            } else {
              const result = op.set(a, ss[i])
              if (Result.isFailure(result)) {
                return result
              }
              a = result.success
            }
          }
          return _tag === "OptionalNode" ? Result.succeed(a) : a
        }
      }
    }
  }
})

function hasFailingGet(tag: Op["_tag"]): boolean {
  return tag === "PrismNode" || tag === "OptionalNode"
}

function hasSet(tag: Op["_tag"]): boolean {
  return tag === "IsoNode" || tag === "PrismNode"
}

function getCompositionTag(a: Op["_tag"], b: Op["_tag"]): Op["_tag"] {
  switch (a) {
    case "IsoNode":
      return b
    case "LensNode":
      return hasFailingGet(b) ? "OptionalNode" : "LensNode"
    case "PrismNode":
      return hasSet(b) ? "PrismNode" : "OptionalNode"
    case "OptionalNode":
      return "OptionalNode"
  }
}
// ---------------------------------------------
// Derived APIs
// ---------------------------------------------

/**
 * Returns a function that extracts all elements focused by a
 * {@link Traversal} as a plain mutable array.
 *
 * **When to use**
 *
 * Use when you need the focused values as a simple `Array<A>` for further
 *   processing.
 *
 * **Details**
 *
 * - Returns an empty array when the traversal cannot focus.
 * - Always returns a fresh array (safe to mutate).
 *
 * **Example** (collecting positive numbers)
 *
 * ```ts
 * import { Optic, Schema } from "effect"
 *
 * type S = { readonly values: ReadonlyArray<number> }
 *
 * const _pos = Optic.id<S>()
 *   .key("values")
 *   .forEach((n) => n.check(Schema.isGreaterThan(0)))
 *
 * const getPositive = Optic.getAll(_pos)
 *
 * console.log(getPositive({ values: [3, -1, 5] }))
 * // Output: [3, 5]
 *
 * console.log(getPositive({ values: [-1, -2] }))
 * // Output: []
 * ```
 *
 * @see {@link Traversal} — the optic type this operates on
 *
 * @category Traversal
 * @since 4.0.0
 */
export function getAll<S, A>(traversal: Traversal<S, A>): (s: S) => Array<A> {
  return (s) =>
    Result.match(traversal.getResult(s), {
      onFailure: () => [],
      onSuccess: (as) => [...as]
    })
}

// ---------------------------------------------
// Built-in Optics
// ---------------------------------------------

const identityIso = make(identityNode)

/**
 * Iso that focuses on the whole value unchanged.
 *
 * **When to use**
 *
 * Use when starting an optic chain with a focus on the whole value.
 *
 * **Details**
 *
 * - `get(s)` returns `s`.
 * - `set(a)` returns `a`.
 * - Singleton — every call returns the same instance.
 *
 * **Example** (starting an optic chain)
 *
 * ```ts
 * import { Optic } from "effect"
 *
 * type S = { readonly x: number }
 *
 * const _x = Optic.id<S>().key("x")
 *
 * console.log(_x.get({ x: 42 }))
 * // Output: 42
 * ```
 *
 * @see {@link Iso} — the type this function returns
 *
 * @category Iso
 * @since 4.0.0
 */
export function id<S>(): Iso<S, S> {
  return identityIso
}

/**
 * Iso that converts a `Record<string, A>` to an array of
 * `[key, value]` entries and back.
 *
 * **When to use**
 *
 * Use when you want to traverse or manipulate record entries as an array (e.g.
 *   with `.forEach()`).
 *
 * **Details**
 *
 * - `get` uses `Object.entries`.
 * - `set` uses `Object.fromEntries`.
 * - Round-trip is lossless for `Record<string, A>`.
 *
 * **Example** (traversing record values)
 *
 * ```ts
 * import { Optic, Schema } from "effect"
 *
 * const _positiveValues = Optic.entries<number>()
 *   .forEach((entry) => entry.key(1).check(Schema.isGreaterThan(0)))
 *
 * const inc = _positiveValues.modifyAll((n) => n + 1)
 *
 * console.log(inc({ a: 0, b: 3, c: -1 }))
 * // Output: { a: 0, b: 4, c: -1 }
 * ```
 *
 * @see {@link Iso} — the type this function returns
 * @see {@link id} — identity iso
 *
 * @category Iso
 * @since 4.0.0
 */
export function entries<A>(): Iso<Record<string, A>, ReadonlyArray<readonly [string, A]>> {
  return make(new IsoNode(Object.entries, Object.fromEntries))
}

/**
 * Prism that focuses on the value inside `Option.Some`.
 *
 * **When to use**
 *
 * Use when you have an `Option<A>` and want to read/update the inner value only
 *   when it is `Some`.
 *
 * **Details**
 *
 * - `getResult` fails with an error message when the option is `None`.
 * - `set(a)` wraps `a` in `Option.some(a)`.
 *
 * **Example** (accessing Some value)
 *
 * ```ts
 * import { Optic, Option, Result } from "effect"
 *
 * const _some = Optic.id<Option.Option<number>>().compose(Optic.some())
 *
 * console.log(Result.isSuccess(_some.getResult(Option.some(42))))
 * // Output: true
 *
 * console.log(Result.isFailure(_some.getResult(Option.none())))
 * // Output: true
 *
 * console.log(_some.set(10))
 * // Output: { _tag: "Some", value: 10 }
 * ```
 *
 * @see {@link none} — focuses on `None` instead
 * @see {@link Prism} — the type this function returns
 *
 * @category Prism
 * @since 4.0.0
 */
export function some<A>(): Prism<Option.Option<A>, A> {
  const run = runRefinement(Option.isSome, { expected: "a Some value" })
  return makePrism(
    (s) =>
      Result.mapBoth(run(s), {
        onFailure: String,
        onSuccess: (s) => s.value
      }),
    Option.some
  )
}

/**
 * Prism that focuses on `Option.None`, exposing `undefined`.
 *
 * **When to use**
 *
 * Use when you want to match or construct `None` values within an optic chain.
 *
 * **Details**
 *
 * - `getResult` succeeds with `undefined` when the option is `None`.
 * - `getResult` fails when the option is `Some`.
 * - `set(undefined)` produces `Option.none()`.
 *
 * **Example** (matching None)
 *
 * ```ts
 * import { Optic, Option, Result } from "effect"
 *
 * const _none = Optic.id<Option.Option<number>>().compose(Optic.none())
 *
 * console.log(Result.isSuccess(_none.getResult(Option.none())))
 * // Output: true
 *
 * console.log(Result.isFailure(_none.getResult(Option.some(1))))
 * // Output: true
 * ```
 *
 * @see {@link some} — focuses on `Some` instead
 * @see {@link Prism} — the type this function returns
 *
 * @category Prism
 * @since 4.0.0
 */
export function none<A>(): Prism<Option.Option<A>, undefined> {
  const run = runRefinement(Option.isNone, { expected: "a None value" })
  return makePrism(
    (s) =>
      Result.mapBoth(run(s), {
        onFailure: String,
        onSuccess: () => undefined
      }),
    () => Option.none()
  )
}

/**
 * Prism that focuses on the success value of a `Result`.
 *
 * **When to use**
 *
 * Use when you have a `Result<A, E>` and want to read/update `A` only when it
 *   is a `Success`.
 *
 * **Details**
 *
 * - `getResult` fails when the result is a `Failure`.
 * - `set(a)` produces `Result.succeed(a)`.
 *
 * **Example** (accessing success)
 *
 * ```ts
 * import { Optic, Result } from "effect"
 *
 * const _ok = Optic.id<Result.Result<number, string>>().compose(Optic.success())
 *
 * console.log(Result.isSuccess(_ok.getResult(Result.succeed(42))))
 * // Output: true
 *
 * console.log(Result.isFailure(_ok.getResult(Result.fail("err"))))
 * // Output: true
 * ```
 *
 * @see {@link failure} — focuses on the failure side
 * @see {@link Prism} — the type this function returns
 *
 * @category Prism
 * @since 4.0.0
 */
export function success<A, E>(): Prism<Result.Result<A, E>, A> {
  const run = runRefinement(Result.isSuccess, { expected: "a Result.Success value" })
  return makePrism(
    (s) =>
      Result.mapBoth(run(s), {
        onFailure: String,
        onSuccess: (s) => s.success
      }),
    Result.succeed
  )
}

/**
 * Prism that focuses on the failure value of a `Result`.
 *
 * **When to use**
 *
 * Use when you have a `Result<A, E>` and want to read/update `E` only when it
 *   is a `Failure`.
 *
 * **Details**
 *
 * - `getResult` fails when the result is a `Success`.
 * - `set(e)` produces `Result.fail(e)`.
 *
 * **Example** (accessing failure)
 *
 * ```ts
 * import { Optic, Result } from "effect"
 *
 * const _err = Optic.id<Result.Result<number, string>>().compose(Optic.failure())
 *
 * console.log(Result.isSuccess(_err.getResult(Result.fail("oops"))))
 * // Output: true
 *
 * console.log(Result.isFailure(_err.getResult(Result.succeed(42))))
 * // Output: true
 * ```
 *
 * @see {@link success} — focuses on the success side
 * @see {@link Prism} — the type this function returns
 *
 * @category Prism
 * @since 4.0.0
 */
export function failure<A, E>(): Prism<Result.Result<A, E>, E> {
  const run = runRefinement(Result.isFailure, { expected: "a Result.Failure value" })
  return makePrism(
    (s) =>
      Result.mapBoth(run(s), {
        onFailure: String,
        onSuccess: (s) => s.failure
      }),
    Result.fail
  )
}

function runRefinement<T extends E, E>(
  refinement: (e: E) => e is T,
  annotations?: Schema.Annotations.Filter
): (e: E) => Result.Result<T, Issue.Issue> {
  return (e) => AST.runChecks([AST.makeFilterByGuard(refinement, annotations)], e) as any
}
