/**
 * Immutable data constructors with discriminated-union support.
 *
 * The `Data` module provides base classes and factory functions for creating
 * immutable value types with a `_tag` field for discriminated unions.
 * It is the recommended way to define domain models, error types, and
 * lightweight ADTs in Effect applications.
 *
 * ## Mental model
 *
 * - **`Class`** — base class for plain immutable data. Extend it with a type
 *   parameter to declare the fields. Instances are `Pipeable`.
 * - **`TaggedClass`** — like `Class` but automatically adds a `readonly _tag`
 *   string literal field. Useful for single-variant types or ad-hoc tagged
 *   values.
 * - **`TaggedEnum`** (type) + **`taggedEnum`** (value) — define a multi-variant
 *   discriminated union from a simple record. `taggedEnum()` returns per-variant
 *   constructors plus `$is` / `$match` helpers.
 * - **`Error`** — like `Class` but extends `Cause.YieldableError`, so instances
 *   can be yielded inside `Effect.gen` to fail the effect.
 * - **`TaggedError`** — like `TaggedClass` but extends `Cause.YieldableError`.
 *   Works with `Effect.catchTag` for tag-based error recovery.
 *
 * ## Common tasks
 *
 * - Define a simple value class → {@link Class}
 * - Define a value class with a `_tag` → {@link TaggedClass}
 * - Define a discriminated union with constructors → {@link TaggedEnum} + {@link taggedEnum}
 * - Define a yieldable error → {@link Error}
 * - Define a yieldable tagged error → {@link TaggedError}
 * - Type-guard a tagged value → `$is` from {@link taggedEnum}
 * - Pattern-match on a tagged union → `$match` from {@link taggedEnum}
 *
 * ## Gotchas
 *
 * - Variant records passed to `TaggedEnum` must **not** contain a `_tag` key;
 *   the `_tag` is added automatically from the record key.
 * - When a class has no fields, the constructor argument is optional (`void`).
 * - `taggedEnum()` creates **plain objects**, not class instances. If you need
 *   class-based variants, use `TaggedClass` or `TaggedError` instead.
 * - `TaggedEnum.WithGenerics` supports up to 4 generic type parameters.
 * - `$is(tag)` only checks the `_tag` field, not the full structure. It is safe
 *   when the tag value is globally unique across your application and the value
 *   was produced by your constructors. For untrusted input, validate with
 *   the `Schema` module before using `$is`.
 *
 * ## Quickstart
 *
 * **Example** (tagged union with pattern matching)
 *
 * ```ts
 * import { Data } from "effect"
 *
 * type Shape = Data.TaggedEnum<{
 *   Circle: { readonly radius: number }
 *   Rect: { readonly width: number; readonly height: number }
 * }>
 * const { Circle, Rect, $match } = Data.taggedEnum<Shape>()
 *
 * const area = $match({
 *   Circle: ({ radius }) => Math.PI * radius ** 2,
 *   Rect: ({ width, height }) => width * height
 * })
 *
 * console.log(area(Circle({ radius: 5 })))
 * // 78.53981633974483
 * console.log(area(Rect({ width: 3, height: 4 })))
 * // 12
 * ```
 *
 * @see {@link Class} — plain immutable data class
 * @see {@link TaggedEnum} — discriminated union type
 * @see {@link taggedEnum} — discriminated union constructors
 * @see {@link TaggedError} — yieldable tagged error class
 *
 * @since 2.0.0
 */
import type * as Cause from "./Cause.ts"
import * as core from "./internal/core.ts"
import * as Pipeable from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import type * as Types from "./Types.ts"
import type { Unify } from "./Unify.ts"

/**
 * Provides a base class for immutable data types.
 *
 * **When to use**
 *
 * Use when you need a lightweight immutable value type with `.pipe()` support. If you also need a `_tag` discriminator, use {@link TaggedClass}; if you need a yieldable error, use {@link Error} or {@link TaggedError}.
 *
 * **Details**
 *
 * Extend `Class` with a type parameter to declare fields. The constructor
 * accepts those fields as a single object argument. When there are no fields
 * the argument is optional. Instances are `Readonly` and `Pipeable`.
 *
 * **Example** (Defining a value class)
 *
 * ```ts
 * import { Data, Equal } from "effect"
 *
 * class Person extends Data.Class<{ readonly name: string }> {}
 *
 * const mike1 = new Person({ name: "Mike" })
 * const mike2 = new Person({ name: "Mike" })
 *
 * console.log(Equal.equals(mike1, mike2))
 * // true
 * ```
 *
 * @see {@link TaggedClass} — adds a `_tag` field
 * @see {@link Error} — yieldable error variant
 *
 * @category constructors
 * @since 2.0.0
 */
export const Class: new<A extends Record<string, any> = {}>(
  args: Types.VoidIfEmpty<{ readonly [P in keyof A]: A[P] }>
) => Readonly<A> & Pipeable.Pipeable = class extends Pipeable.Class {
  constructor(props: any) {
    super()
    if (props) {
      Object.assign(this, props)
    }
  }
} as any

/**
 * Provides a base class for immutable data types with a `_tag` discriminator.
 *
 * **When to use**
 *
 * Use when you need a single-variant tagged type or an ad-hoc discriminator. For multi-variant unions, prefer {@link TaggedEnum} with {@link taggedEnum}; for yieldable errors, use {@link TaggedError}.
 *
 * **Details**
 *
 * Like {@link Class}, but the resulting instances also carry a
 * `readonly _tag: Tag` property. The `_tag` is excluded from the constructor
 * argument.
 *
 * **Example** (Defining a tagged class)
 *
 * ```ts
 * import { Data } from "effect"
 *
 * class Person extends Data.TaggedClass("Person")<{
 *   readonly name: string
 * }> {}
 *
 * const mike = new Person({ name: "Mike" })
 * console.log(mike._tag)
 * // "Person"
 * ```
 *
 * @see {@link Class} — without a `_tag`
 * @see {@link TaggedError} — tagged error variant
 * @see {@link TaggedEnum} — multi-variant unions
 *
 * @category constructors
 * @since 2.0.0
 */
export const TaggedClass = <Tag extends string>(
  tag: Tag
): new<A extends Record<string, any> = {}>(
  args: Types.VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P] }>
) => Readonly<A> & { readonly _tag: Tag } & Pipeable.Pipeable =>
  class extends Class {
    readonly _tag = tag
  } as any

/**
 * Transforms a record of variant definitions into a discriminated union type.
 *
 * **When to use**
 *
 * Use when you have two or more variants that share a common `_tag` discriminator. For generic tagged enums, see {@link TaggedEnum.WithGenerics}.
 *
 * **Details**
 *
 * Each key in the record becomes a variant with `readonly _tag` set to that
 * key. Use with {@link taggedEnum} to get constructors and matchers.
 *
 * **Gotchas**
 *
 * Variant records must **not** include a `_tag` property; it is added automatically.
 *
 * **Example** (Defining a tagged enum)
 *
 * ```ts
 * import { Data } from "effect"
 *
 * type HttpError = Data.TaggedEnum<{
 *   BadRequest: { readonly status: 400; readonly message: string }
 *   NotFound: { readonly status: 404 }
 * }>
 *
 * // Equivalent to:
 * // | { readonly _tag: "BadRequest"; readonly status: 400; readonly message: string }
 * // | { readonly _tag: "NotFound"; readonly status: 404 }
 *
 * const { BadRequest, NotFound } = Data.taggedEnum<HttpError>()
 *
 * const err = BadRequest({ status: 400, message: "missing id" })
 * console.log(err._tag)
 * // "BadRequest"
 * ```
 *
 * @see {@link taggedEnum} — constructors and matchers for a `TaggedEnum`
 * @see {@link TaggedEnum.WithGenerics} — generic tagged enums
 * @see {@link TaggedEnum.Constructor} — the constructor object type
 *
 * @category models
 * @since 2.0.0
 */
export type TaggedEnum<
  A extends Record<string, Record<string, any>> & UntaggedChildren<A>
> = keyof A extends infer Tag ? Tag extends keyof A ? Types.Simplify<
      { readonly _tag: Tag } & { readonly [K in keyof A[Tag]]: A[Tag][K] }
    >
  : never
  : never

type ChildrenAreTagged<A> = keyof A extends infer K ? K extends keyof A ? "_tag" extends keyof A[K] ? true
    : false
  : never
  : never

type UntaggedChildren<A> = true extends ChildrenAreTagged<A>
  ? "It looks like you're trying to create a tagged enum, but one or more of its members already has a `_tag` property."
  : unknown

/**
 * Namespace for `TaggedEnum` utility types.
 *
 * **When to use**
 *
 * Use to reference utility types for constructing, extracting, and matching
 * `TaggedEnum` variants.
 *
 * **Details**
 *
 * Provides helper types for:
 * - Generic tagged enums ({@link TaggedEnum.WithGenerics}, {@link TaggedEnum.Kind})
 * - Extracting constructor arguments ({@link TaggedEnum.Args}) and variant
 *   values ({@link TaggedEnum.Value})
 * - Full constructor objects ({@link TaggedEnum.Constructor})
 *
 * @since 2.0.0
 */
export declare namespace TaggedEnum {
  /**
   * Defines a tagged enum shape that accepts generic type parameters.
   *
   * **When to use**
   *
   * Use when variant payloads need to be parameterized, such as `Result<E, A>`. Pass the interface, not the type alias, to {@link taggedEnum} to get generic-aware constructors and matchers.
   *
   * **Details**
   *
   * Extend this interface and set `taggedEnum` to your union type, using
   * `this["A"]`, `this["B"]`, etc. as placeholders for the generics. The
   * `Count` parameter declares how many generics are used (up to 4).
   *
   * **Example** (Generic tagged enum)
   *
   * ```ts
   * import { Data } from "effect"
   *
   * type MyResult<E, A> = Data.TaggedEnum<{
   *   Failure: { readonly error: E }
   *   Success: { readonly value: A }
   * }>
   *
   * interface MyResultDef extends Data.TaggedEnum.WithGenerics<2> {
   *   readonly taggedEnum: MyResult<this["A"], this["B"]>
   * }
   *
   * const { Failure, Success } = Data.taggedEnum<MyResultDef>()
   *
   * const ok = Success({ value: 42 })
   * // ok: { readonly _tag: "Success"; readonly value: number }
   * ```
   *
   * @see {@link Kind} — apply concrete types to a `WithGenerics` definition
   * @see {@link taggedEnum} — constructors and matchers
   *
   * @category models
   * @since 2.0.0
   */
  export interface WithGenerics<Count extends number> {
    readonly taggedEnum: { readonly _tag: string }
    readonly numberOfGenerics: Count

    readonly A: unknown
    readonly B: unknown
    readonly C: unknown
    readonly D: unknown
  }

  /**
   * Applies concrete type arguments to a `WithGenerics` definition, producing
   * the resulting tagged union type.
   *
   * **When to use**
   *
   * Use to refer to a specific instantiation of a generic tagged enum in type signatures.
   *
   * **Example** (Applying generics)
   *
   * ```ts
   * import type { Data } from "effect"
   *
   * type Option<A> = Data.TaggedEnum<{
   *   None: {}
   *   Some: { readonly value: A }
   * }>
   * interface OptionDef extends Data.TaggedEnum.WithGenerics<1> {
   *   readonly taggedEnum: Option<this["A"]>
   * }
   *
   * // Resolve to the concrete union for `string`
   * type StringOption = Data.TaggedEnum.Kind<OptionDef, string>
   * // { _tag: "None" } | { _tag: "Some"; value: string }
   * ```
   *
   * @see {@link WithGenerics} — define the generic shape
   *
   * @category utility types
   * @since 2.0.0
   */
  export type Kind<
    Z extends WithGenerics<number>,
    A = unknown,
    B = unknown,
    C = unknown,
    D = unknown
  > = (Z & {
    readonly A: A
    readonly B: B
    readonly C: C
    readonly D: D
  })["taggedEnum"]

  /**
   * Extracts the constructor argument type for a specific variant of a tagged
   * union.
   *
   * **When to use**
   *
   * Use to derive the argument object expected by a constructor for one tagged
   * union variant.
   *
   * **Details**
   *
   * Returns `void` if the variant has no fields beyond `_tag`.
   *
   * **Example** (Extracting variant args)
   *
   * ```ts
   * import type { Data } from "effect"
   *
   * type Result =
   *   | { readonly _tag: "Ok"; readonly value: number }
   *   | { readonly _tag: "Err"; readonly error: string }
   *
   * type OkArgs = Data.TaggedEnum.Args<Result, "Ok">
   * // { readonly value: number }
   *
   * type ErrArgs = Data.TaggedEnum.Args<Result, "Err">
   * // { readonly error: string }
   * ```
   *
   * @see {@link Value} — extracts the full variant type (including `_tag`)
   *
   * @category utility types
   * @since 2.0.0
   */
  export type Args<
    A extends { readonly _tag: string },
    K extends A["_tag"],
    E = Extract<A, { readonly _tag: K }>
  > = {
    readonly [K in keyof E as K extends "_tag" ? never : K]: E[K]
  } extends infer T ? Types.VoidIfEmpty<T>
    : never

  /**
   * Extracts the full variant type (including `_tag`) for a specific tag.
   *
   * **When to use**
   *
   * Use to select one full tagged-union variant by its `_tag` value.
   *
   * **Example** (extracting a variant type)
   *
   * ```ts
   * import type { Data } from "effect"
   *
   * type Result =
   *   | { readonly _tag: "Ok"; readonly value: number }
   *   | { readonly _tag: "Err"; readonly error: string }
   *
   * type OkVariant = Data.TaggedEnum.Value<Result, "Ok">
   * // { readonly _tag: "Ok"; readonly value: number }
   * ```
   *
   * @see {@link Args} — extracts fields without `_tag`
   *
   * @category utility types
   * @since 2.0.0
   */
  export type Value<
    A extends { readonly _tag: string },
    K extends A["_tag"]
  > = Extract<A, { readonly _tag: K }>

  /**
   * The full constructors-and-matchers object type returned by {@link taggedEnum}.
   *
   * **When to use**
   *
   * Use to type the constructors-and-matchers object returned by `taggedEnum`.
   *
   * **Details**
   *
   * Includes:
   * - A constructor function for each variant (keyed by tag name)
   * - `$is(tag)` — returns a type-guard that checks only the `_tag` field;
   *   safe when the tag is globally unique and the value was produced by your
   *   constructors. For untrusted input, validate with the `Schema` module first.
   * - `$match` — exhaustive pattern matching (data-last or data-first)
   *
   * **Example** (Using the constructor object)
   *
   * ```ts
   * import { Data } from "effect"
   *
   * type Shape =
   *   | { readonly _tag: "Circle"; readonly radius: number }
   *   | { readonly _tag: "Rect"; readonly w: number; readonly h: number }
   *
   * const { Circle, Rect, $is, $match } = Data.taggedEnum<Shape>()
   *
   * const shape = Circle({ radius: 10 })
   *
   * // Type guard
   * if ($is("Circle")(shape)) {
   *   console.log(shape.radius)
   * }
   *
   * // Pattern matching
   * const label = $match(shape, {
   *   Circle: (s) => `circle r=${s.radius}`,
   *   Rect: (s) => `rect ${s.w}x${s.h}`
   * })
   * ```
   *
   * @see {@link taggedEnum} — creates constructors and matchers
   *
   * @category types
   * @since 3.1.0
   */
  export type Constructor<A extends { readonly _tag: string }> = Types.Simplify<
    {
      readonly [Tag in A["_tag"]]: ConstructorFrom<
        Extract<A, { readonly _tag: Tag }>,
        "_tag"
      >
    } & {
      readonly $is: <Tag extends A["_tag"]>(
        tag: Tag
      ) => (u: unknown) => u is Extract<A, { readonly _tag: Tag }>
      readonly $match: {
        <
          Cases extends {
            readonly [Tag in A["_tag"]]: (
              args: Extract<A, { readonly _tag: Tag }>
            ) => any
          }
        >(
          cases: Cases
        ): (value: A) => Unify<ReturnType<Cases[A["_tag"]]>>
        <
          Cases extends {
            readonly [Tag in A["_tag"]]: (
              args: Extract<A, { readonly _tag: Tag }>
            ) => any
          }
        >(
          value: A,
          cases: Cases
        ): Unify<ReturnType<Cases[A["_tag"]]>>
      }
    }
  >

  /**
   * Function type that constructs a tagged-union variant from its fields,
   * excluding the keys listed in `Tag`.
   *
   * **When to use**
   *
   * Use to type an individual constructor for one tagged-union variant.
   *
   * **Details**
   *
   * The constructor returns the full variant type `A`. If no fields remain
   * after excluding `Tag` keys, the constructor argument type becomes `void`.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type ConstructorFrom<A, Tag extends keyof A = never> = (
    args: Types.VoidIfEmpty<{ readonly [P in keyof A as P extends Tag ? never : P]: A[P] }>
  ) => A

  /**
   * Type-guard and pattern-matching interface for generic tagged enums.
   *
   * **When to use**
   *
   * Use to type the `$is` and `$match` helpers for generic tagged enums.
   *
   * **Details**
   *
   * This is the `$is` / `$match` portion of the object returned by
   * {@link taggedEnum} when used with a {@link WithGenerics} definition.
   *
   * @see {@link Constructor} — the non-generic equivalent
   *
   * @category models
   * @since 3.2.0
   */
  export interface GenericMatchers<Z extends WithGenerics<number>> {
    readonly $is: <Tag extends Z["taggedEnum"]["_tag"]>(
      tag: Tag
    ) => {
      <T extends TaggedEnum.Kind<Z, any, any, any, any>>(
        u: T
      ): u is T & { readonly _tag: Tag }
      (u: unknown): u is Extract<TaggedEnum.Kind<Z>, { readonly _tag: Tag }>
    }
    readonly $match: {
      <
        A,
        B,
        C,
        D,
        Cases extends {
          readonly [Tag in Z["taggedEnum"]["_tag"]]: (
            args: Extract<
              TaggedEnum.Kind<Z, A, B, C, D>,
              { readonly _tag: Tag }
            >
          ) => any
        }
      >(
        cases: Cases
      ): (
        self: TaggedEnum.Kind<Z, A, B, C, D>
      ) => Unify<ReturnType<Cases[Z["taggedEnum"]["_tag"]]>>
      <
        A,
        B,
        C,
        D,
        Cases extends {
          readonly [Tag in Z["taggedEnum"]["_tag"]]: (
            args: Extract<
              TaggedEnum.Kind<Z, A, B, C, D>,
              { readonly _tag: Tag }
            >
          ) => any
        }
      >(
        self: TaggedEnum.Kind<Z, A, B, C, D>,
        cases: Cases
      ): Unify<ReturnType<Cases[Z["taggedEnum"]["_tag"]]>>
    }
  }
}

/**
 * Creates constructors and matchers for a `TaggedEnum` type.
 *
 * **When to use**
 *
 * Use when you have a `TaggedEnum` type and need constructors and matchers for its values. For generic enums, pass a {@link TaggedEnum.WithGenerics} interface.
 *
 * **Details**
 *
 * Returns an object with:
 * - One constructor per variant (keyed by tag name)
 * - `$is(tag)` — returns a type-guard function that checks only the `_tag` field
 * - `$match` — exhaustive pattern matching (data-first or data-last)
 *
 * **Gotchas**
 *
 * - Constructors produce **plain objects**, not class instances.
 * - `$is(tag)` only checks the `_tag` field, not the full structure. It relies
 *   on the tag being globally unique and the value being produced by your
 *   constructors. For untrusted input, validate with the `Schema` module first.
 *
 * **Example** (Basic usage)
 *
 * ```ts
 * import { Data } from "effect"
 *
 * type HttpError = Data.TaggedEnum<{
 *   BadRequest: { readonly message: string }
 *   NotFound: { readonly url: string }
 * }>
 *
 * const { BadRequest, NotFound, $is, $match } = Data.taggedEnum<HttpError>()
 *
 * const err = NotFound({ url: "/missing" })
 *
 * // Type guard
 * console.log($is("NotFound")(err)) // true
 *
 * // Pattern matching
 * const msg = $match(err, {
 *   BadRequest: (e) => e.message,
 *   NotFound: (e) => `${e.url} not found`
 * })
 * console.log(msg) // "/missing not found"
 * ```
 *
 * **Example** (Generic tagged enum)
 *
 * ```ts
 * import { Data } from "effect"
 *
 * type MyResult<E, A> = Data.TaggedEnum<{
 *   Failure: { readonly error: E }
 *   Success: { readonly value: A }
 * }>
 * interface MyResultDef extends Data.TaggedEnum.WithGenerics<2> {
 *   readonly taggedEnum: MyResult<this["A"], this["B"]>
 * }
 * const { Failure, Success } = Data.taggedEnum<MyResultDef>()
 *
 * const ok = Success({ value: 42 })
 * // ok: { readonly _tag: "Success"; readonly value: number }
 * ```
 *
 * @see {@link TaggedEnum} — the type-level companion
 * @see {@link TaggedEnum.Constructor} — the returned object type
 * @see {@link TaggedEnum.WithGenerics} — generic enum support
 *
 * @category constructors
 * @since 2.0.0
 */
export const taggedEnum: {
  <Z extends TaggedEnum.WithGenerics<1>>(): Types.Simplify<
    {
      readonly [Tag in Z["taggedEnum"]["_tag"]]: <A>(
        args: TaggedEnum.Args<
          TaggedEnum.Kind<Z, A>,
          Tag,
          Extract<TaggedEnum.Kind<Z, A>, { readonly _tag: Tag }>
        >
      ) => TaggedEnum.Value<TaggedEnum.Kind<Z, A>, Tag>
    } & TaggedEnum.GenericMatchers<Z>
  >

  <Z extends TaggedEnum.WithGenerics<2>>(): Types.Simplify<
    {
      readonly [Tag in Z["taggedEnum"]["_tag"]]: <A, B>(
        args: TaggedEnum.Args<
          TaggedEnum.Kind<Z, A, B>,
          Tag,
          Extract<TaggedEnum.Kind<Z, A, B>, { readonly _tag: Tag }>
        >
      ) => TaggedEnum.Value<TaggedEnum.Kind<Z, A, B>, Tag>
    } & TaggedEnum.GenericMatchers<Z>
  >

  <Z extends TaggedEnum.WithGenerics<3>>(): Types.Simplify<
    {
      readonly [Tag in Z["taggedEnum"]["_tag"]]: <A, B, C>(
        args: TaggedEnum.Args<
          TaggedEnum.Kind<Z, A, B, C>,
          Tag,
          Extract<TaggedEnum.Kind<Z, A, B, C>, { readonly _tag: Tag }>
        >
      ) => TaggedEnum.Value<TaggedEnum.Kind<Z, A, B, C>, Tag>
    } & TaggedEnum.GenericMatchers<Z>
  >

  <Z extends TaggedEnum.WithGenerics<4>>(): Types.Simplify<
    {
      readonly [Tag in Z["taggedEnum"]["_tag"]]: <A, B, C, D>(
        args: TaggedEnum.Args<
          TaggedEnum.Kind<Z, A, B, C, D>,
          Tag,
          Extract<TaggedEnum.Kind<Z, A, B, C, D>, { readonly _tag: Tag }>
        >
      ) => TaggedEnum.Value<TaggedEnum.Kind<Z, A, B, C, D>, Tag>
    } & TaggedEnum.GenericMatchers<Z>
  >

  <A extends { readonly _tag: string }>(): TaggedEnum.Constructor<A>
} = () =>
  new Proxy(
    {},
    {
      get(_target, tag, _receiver) {
        if (tag === "$is") {
          return Predicate.isTagged
        } else if (tag === "$match") {
          return taggedMatch
        }
        return (props: any) => ({ ...props, _tag: tag })
      }
    }
  ) as any

function taggedMatch<
  A extends { readonly _tag: string },
  Cases extends {
    readonly [K in A["_tag"]]: (args: Extract<A, { readonly _tag: K }>) => any
  }
>(self: A, cases: Cases): ReturnType<Cases[A["_tag"]]>
function taggedMatch<
  A extends { readonly _tag: string },
  Cases extends {
    readonly [K in A["_tag"]]: (args: Extract<A, { readonly _tag: K }>) => any
  }
>(cases: Cases): (value: A) => ReturnType<Cases[A["_tag"]]>
function taggedMatch<
  A extends { readonly _tag: string },
  Cases extends {
    readonly [K in A["_tag"]]: (args: Extract<A, { readonly _tag: K }>) => any
  }
>(): any {
  if (arguments.length === 1) {
    const cases = arguments[0] as Cases
    return function(value: A): ReturnType<Cases[A["_tag"]]> {
      return cases[value._tag as A["_tag"]](value as any)
    }
  }
  const value = arguments[0] as A
  const cases = arguments[1] as Cases
  return cases[value._tag as A["_tag"]](value as any)
}

/**
 * Provides a base class for yieldable errors.
 *
 * **When to use**
 *
 * Use when defining yieldable errors that do **not** need tag-based
 * discrimination. If you need tag-based recovery, use {@link TaggedError}.
 *
 * **Details**
 *
 * Extends `Cause.YieldableError`, so instances can be yielded inside
 * `Effect.gen` to fail the enclosing effect. Fields are passed as a single
 * object; when there are no fields the argument is optional. If a `message`
 * field is provided, it becomes the error's `.message`.
 *
 * **Example** (Defining a yieldable error)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class NetworkError extends Data.Error<{
 *   readonly code: number
 *   readonly message: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   return yield* new NetworkError({ code: 500, message: "timeout" })
 * })
 *
 * // The effect fails with a NetworkError
 * Effect.runSync(Effect.exit(program))
 * ```
 *
 * @see {@link TaggedError} — adds a `_tag` for `Effect.catchTag`
 * @see {@link Class} — non-error data class
 *
 * @category constructors
 * @since 2.0.0
 */
export const Error: new<A extends Record<string, any> = {}>(
  args: Types.VoidIfEmpty<{ readonly [P in keyof A]: A[P] }>
) => Cause.YieldableError & Readonly<A> = core.Error

/**
 * Creates a tagged error class with a `_tag` discriminator.
 *
 * **When to use**
 *
 * Use when modeling domain errors in Effect applications where you want
 * discriminated-union error handling.
 *
 * **Details**
 *
 * Like {@link Error}, but instances also carry a `readonly _tag` property,
 * enabling `Effect.catchTag` and `Effect.catchTags` for tag-based recovery.
 * The `_tag` is excluded from the constructor argument. Yielding an instance
 * inside `Effect.gen` fails the effect with this error.
 *
 * **Example** (Tag-based error recovery)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class NotFound extends Data.TaggedError("NotFound")<{
 *   readonly resource: string
 * }> {}
 *
 * class Forbidden extends Data.TaggedError("Forbidden")<{
 *   readonly reason: string
 * }> {}
 *
 * const program = Effect.gen(function*() {
 *   return yield* new NotFound({ resource: "/users/42" })
 * })
 *
 * const recovered = program.pipe(
 *   Effect.catchTag("NotFound", (e) =>
 *     Effect.succeed(`missing: ${e.resource}`))
 * )
 * ```
 *
 * @see {@link Error} — without a `_tag`
 * @see {@link TaggedClass} — tagged class that is not an error
 *
 * @category constructors
 * @since 2.0.0
 */
export const TaggedError: <Tag extends string>(
  tag: Tag
) => new<A extends Record<string, any> = {}>(
  args: Types.VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P] }>
) => Cause.YieldableError & { readonly _tag: Tag } & Readonly<A> = core.TaggedError as any
