/**
 * Structured validation errors produced by the Effect Schema system.
 *
 * When `Schema.decode`, `Schema.encode`, or a filter rejects a value, the
 * result is an {@link Issue} — a recursive tree that describes *what* went
 * wrong and *where*. This module defines every node type in that tree and
 * provides formatters that turn an `Issue` into a human-readable string or a
 * Standard Schema V1 failure result.
 *
 * ## Mental model
 *
 * - **Issue**: A discriminated union (`_tag`) of all possible validation error
 *   nodes. It is recursive — composite nodes wrap inner `Issue` children.
 * - **Leaf**: A terminal issue with no inner children ({@link InvalidType},
 *   {@link InvalidValue}, {@link MissingKey}, {@link UnexpectedKey},
 *   {@link Forbidden}, {@link OneOf}).
 * - **Composite nodes**: Wrap one or more inner issues to add context —
 *   {@link Filter}, {@link Encoding}, {@link Pointer}, {@link Composite},
 *   {@link AnyOf}.
 * - **Pointer**: Adds a property-key path to an inner issue, indicating
 *   *where* in the input the error occurred.
 * - **Formatter**: A function `Issue → Format` that serialises the error tree.
 *   Two built-in factories are provided: {@link makeFormatterDefault} (plain
 *   string) and {@link makeFormatterStandardSchemaV1} (Standard Schema V1).
 *
 * ## Common tasks
 *
 * - Check if a value is an Issue → {@link isIssue}
 * - Extract the actual input from any issue → {@link getActual}
 * - Format an issue as a string → {@link makeFormatterDefault}
 * - Format an issue for Standard Schema V1 → {@link makeFormatterStandardSchemaV1}
 * - Customise leaf formatting → {@link defaultLeafHook}
 * - Customise filter formatting → {@link defaultCheckHook}
 *
 * ## Gotchas
 *
 * - `Pointer` and `MissingKey` carry no actual value — {@link getActual}
 *   returns `Option.none()` for them.
 * - `AnyOf`, `UnexpectedKey`, `OneOf`, and `Filter` store `actual` as a plain
 *   `unknown` (not `Option`), so {@link getActual} wraps them with
 *   `Option.some`.
 * - Calling `toString()` on any `Issue` uses the default formatter. To
 *   customise output, create your own formatter with
 *   {@link makeFormatterDefault} or {@link makeFormatterStandardSchemaV1}.
 * - The `Issue` tree can be deeply nested for complex schemas. Formatters
 *   flatten composite nodes for display.
 *
 * ## Quickstart
 *
 * **Example** (Inspecting a validation error)
 *
 * ```ts
 * import { Schema, SchemaIssue } from "effect"
 *
 * const Person = Schema.Struct({
 *   name: Schema.String,
 *   age: Schema.Number
 * })
 *
 * try {
 *   Schema.decodeUnknownSync(Person)({ name: 42 })
 * } catch (e) {
 *   if (Schema.isSchemaError(e)) {
 *     console.log(SchemaIssue.isIssue(e.issue))
 *     // true
 *     console.log(String(e.issue))
 *     // formatted error message
 *   }
 * }
 * ```
 *
 * ## See also
 *
 * - {@link Issue} — the root union type
 * - {@link Leaf} — terminal issue types
 * - {@link Formatter} — the formatter interface
 * - {@link makeFormatterDefault} — default string formatter
 *
 * @since 4.0.0
 */
import type { StandardSchemaV1 } from "@standard-schema/spec"
import * as Arr from "./Array.ts"
import { format, formatPath, type Formatter as FormatterI } from "./Formatter.ts"
import * as InternalAnnotations from "./internal/schema/annotations.ts"
import * as Option from "./Option.ts"
import { hasProperty } from "./Predicate.ts"
import * as Redacted from "./Redacted.ts"
import type * as Schema from "./Schema.ts"
import type * as AST from "./SchemaAST.ts"

const TypeId = "~effect/SchemaIssue/Issue"

/**
 * Returns `true` if the given value is an {@link Issue}.
 *
 * **When to use**
 *
 * Use when narrowing an `unknown` value to `Issue` in error-handling code.
 * - Distinguishing an `Issue` from other error types in a catch-all handler.
 *
 * **Details**
 *
 * - Checks for the internal `TypeId` brand on the value.
 *
 * **Example** (Type-guarding an unknown error)
 *
 * ```ts
 * import { SchemaIssue } from "effect"
 *
 * const issue = new SchemaIssue.MissingKey(undefined)
 * console.log(SchemaIssue.isIssue(issue))
 * // true
 * console.log(SchemaIssue.isIssue("not an issue"))
 * // false
 * ```
 *
 * @see {@link Issue}
 *
 * @category guards
 * @since 4.0.0
 */
export function isIssue(u: unknown): u is Issue {
  return hasProperty(u, TypeId)
}

/**
 * Union of all terminal (leaf) issue types that have no inner `Issue` children.
 *
 * **When to use**
 *
 * Use when constraining formatter hooks to only handle terminal nodes.
 * - Pattern-matching on the `_tag` of an issue when you only care about leaves.
 *
 * **Details**
 *
 * Members: {@link InvalidType}, {@link InvalidValue}, {@link MissingKey},
 * {@link UnexpectedKey}, {@link Forbidden}, {@link OneOf}.
 *
 * @see {@link Issue} — the full union including composite nodes
 * @see {@link LeafHook} — formatter hook that operates on `Leaf` values
 *
 * @category models
 * @since 4.0.0
 */
export type Leaf =
  | InvalidType
  | InvalidValue
  | MissingKey
  | UnexpectedKey
  | Forbidden
  | OneOf

/**
 * The root discriminated union of all validation error nodes.
 *
 * **When to use**
 *
 * Use when typing the error channel in `Effect<A, Issue, R>` results from schema
 *   parsing.
 * - Writing custom formatters or issue-tree walkers.
 *
 * **Details**
 *
 * Every node has a `_tag` field for pattern-matching. The union includes both
 * terminal {@link Leaf} types and composite types that wrap inner issues:
 * {@link Filter}, {@link Encoding}, {@link Pointer}, {@link Composite},
 * {@link AnyOf}. All `Issue` instances have a `toString()` that delegates to
 * the default formatter, so `String(issue)` produces a human-readable message.
 *
 * @see {@link Leaf} — the terminal subset
 * @see {@link isIssue} — type guard
 * @see {@link getActual} — extract the actual value from any issue
 *
 * @category models
 * @since 4.0.0
 */
export type Issue =
  | Leaf
  // composite
  | Filter
  | Encoding
  | Pointer
  | Composite
  | AnyOf

class Base {
  readonly [TypeId] = TypeId
  toString(this: Issue): string {
    return defaultFormatter(this)
  }
}

/**
 * Represents a schema issue produced when a schema filter (refinement check) fails.
 *
 * **When to use**
 *
 * Use when you need to inspect which filter rejected the value.
 *
 * **Details**
 *
 * - `actual` is the raw input value that was tested (plain `unknown`, not
 *   wrapped in `Option`).
 * - `filter` is the AST filter node that produced this issue.
 * - `issue` is the inner issue describing the failure reason.
 *
 * **Example** (Matching a Filter issue)
 *
 * ```ts
 * import { SchemaIssue } from "effect"
 *
 * function describe(issue: SchemaIssue.Issue): string {
 *   if (issue._tag === "Filter") {
 *     return `Filter failed on: ${JSON.stringify(issue.actual)}`
 *   }
 *   return String(issue)
 * }
 * ```
 *
 * @see {@link Leaf} — terminal issue types that commonly appear as the inner `issue`
 * @see {@link CheckHook} — formatter hook for `Filter` issues
 *
 * @category models
 * @since 4.0.0
 */
export class Filter extends Base {
  readonly _tag = "Filter"
  /**
   * The input value that caused the issue.
   */
  readonly actual: unknown
  /**
   * The filter that failed.
   */
  readonly filter: AST.Filter<unknown>
  /**
   * The issue that occurred.
   */
  readonly issue: Issue

  constructor(
    /**
     * The input value that caused the issue.
     */
    actual: unknown,
    /**
     * The filter that failed.
     */
    filter: AST.Filter<any>,
    /**
     * The issue that occurred.
     */
    issue: Issue
  ) {
    super()
    this.actual = actual
    this.filter = filter
    this.issue = issue
  }
}

/**
 * Represents a schema issue produced when a schema transformation (encode/decode step) fails.
 *
 * **When to use**
 *
 * Use when you need to inspect failures from `Schema.decodeTo` / `Schema.encodeTo`
 *   transformations.
 *
 * **Details**
 *
 * - `ast` is the AST node for the transformation that failed.
 * - `actual` is `Option.some(value)` when the input was present, or
 *   `Option.none()` when it was absent.
 * - `issue` is the inner issue describing the failure.
 *
 * @see {@link Filter} — failure from a refinement check (not a transformation)
 * @see {@link Composite} — multiple issues from a single schema node
 *
 * @category models
 * @since 4.0.0
 */
export class Encoding extends Base {
  readonly _tag = "Encoding"
  /**
   * The schema that caused the issue.
   */
  readonly ast: AST.AST
  /**
   * The input value that caused the issue.
   */
  readonly actual: Option.Option<unknown>
  /**
   * The issue that occurred.
   */
  readonly issue: Issue

  constructor(
    /**
     * The schema that caused the issue.
     */
    ast: AST.AST,
    /**
     * The input value that caused the issue.
     */
    actual: Option.Option<unknown>,
    /**
     * The issue that occurred.
     */
    issue: Issue
  ) {
    super()
    this.ast = ast
    this.actual = actual
    this.issue = issue
  }
}

/**
 * Wraps an inner {@link Issue} with a property-key path, indicating *where* in
 * a nested structure the error occurred.
 *
 * **When to use**
 *
 * Use when you need to walk the issue tree to accumulate path segments for error
 * reporting.
 *
 * **Details**
 *
 * - `path` is an array of property keys (strings, numbers, or symbols).
 * - Has no `actual` value — {@link getActual} returns `Option.none()`.
 * - Formatters concatenate nested `Pointer` paths into a single path like
 *   `["a"]["b"][0]`.
 *
 * @see {@link getActual} — returns `Option.none()` for `Pointer`
 * @see {@link Composite} — groups multiple issues under one schema node
 *
 * @category models
 * @since 3.10.0
 */
export class Pointer extends Base {
  readonly _tag = "Pointer"
  /**
   * The path to the location in the input that caused the issue.
   */
  readonly path: ReadonlyArray<PropertyKey>
  /**
   * The issue that occurred.
   */
  readonly issue: Issue

  constructor(
    /**
     * The path to the location in the input that caused the issue.
     */
    path: ReadonlyArray<PropertyKey>,
    /**
     * The issue that occurred.
     */
    issue: Issue
  ) {
    super()
    this.path = path
    this.issue = issue
  }
}

/**
 * Represents a schema issue produced when a required key or tuple index is missing from the input.
 *
 * **When to use**
 *
 * Use when you need to detect absent fields in struct/tuple validation.
 *
 * **Details**
 *
 * - Has no `actual` value — {@link getActual} returns `Option.none()`.
 * - `annotations` may contain a custom `messageMissingKey` for formatting.
 *
 * @see {@link Pointer} — wraps this issue with the missing key's path
 * @see {@link UnexpectedKey} — the opposite case (extra key present)
 *
 * @category models
 * @since 4.0.0
 */
export class MissingKey extends Base {
  readonly _tag = "MissingKey"
  /**
   * The metadata for the issue.
   */
  readonly annotations: Schema.Annotations.Key<unknown> | undefined

  constructor(
    /**
     * The metadata for the issue.
     */
    annotations: Schema.Annotations.Key<unknown> | undefined
  ) {
    super()
    this.annotations = annotations
  }
}

/**
 * Represents a schema issue produced when an input object or tuple contains a key/index not
 * declared by the schema.
 *
 * **When to use**
 *
 * Use when you need to detect excess properties during strict struct/tuple
 * validation.
 *
 * **Details**
 *
 * - `actual` is the raw value at the unexpected key (plain `unknown`).
 * - `ast` is the schema that was being validated against.
 * - `annotations` on `ast` may contain a custom `messageUnexpectedKey`.
 *
 * @see {@link MissingKey} — the opposite case (required key absent)
 * @see {@link Pointer} — wraps this issue with the unexpected key's path
 *
 * @category models
 * @since 4.0.0
 */
export class UnexpectedKey extends Base {
  readonly _tag = "UnexpectedKey"
  /**
   * The schema that caused the issue.
   */
  readonly ast: AST.AST
  /**
   * The input value that caused the issue.
   */
  readonly actual: unknown

  constructor(
    /**
     * The schema that caused the issue.
     */
    ast: AST.AST,
    /**
     * The input value that caused the issue.
     */
    actual: unknown
  ) {
    super()
    this.ast = ast
    this.actual = actual
  }
}

/**
 * Represents a schema issue that groups multiple child issues under a single schema node.
 *
 * **When to use**
 *
 * Use when you need to walk the issue tree for struct/tuple schemas that collect
 * all field errors rather than failing on the first.
 *
 * **Details**
 *
 * - `issues` is a non-empty readonly array (at least one child).
 * - `actual` is `Option.some(value)` when the input was present, or
 *   `Option.none()` when absent.
 * - Formatters flatten `Composite` by recursing into each child.
 *
 * @see {@link AnyOf} — used for union no-match errors (similar but different semantics)
 * @see {@link Pointer} — adds path context to individual issues
 *
 * @category models
 * @since 3.10.0
 */
export class Composite extends Base {
  readonly _tag = "Composite"
  /**
   * The schema that caused the issue.
   */
  readonly ast: AST.AST
  /**
   * The input value that caused the issue.
   */
  readonly actual: Option.Option<unknown>
  /**
   * The issues that occurred.
   */
  readonly issues: readonly [Issue, ...Array<Issue>]

  constructor(
    /**
     * The schema that caused the issue.
     */
    ast: AST.AST,
    /**
     * The input value that caused the issue.
     */
    actual: Option.Option<unknown>,
    /**
     * The issues that occurred.
     */
    issues: readonly [Issue, ...Array<Issue>]
  ) {
    super()
    this.ast = ast
    this.actual = actual
    this.issues = issues
  }
}

/**
 * Represents a schema issue produced when the runtime type of the input does not match the type
 * expected by the schema (e.g. got `null` when `string` was expected).
 *
 * **When to use**
 *
 * Use when you need to detect basic type mismatches, such as a wrong primitive
 * or `null` where an object was expected.
 *
 * **Details**
 *
 * - `ast` is the schema node that expected a different type.
 * - `actual` is `Option.some(value)` when the input was present, or
 *   `Option.none()` when no value was provided.
 * - The default formatter renders this as `"Expected <type>, got <actual>"`.
 *
 * **Example** (Formatted output)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * try {
 *   Schema.decodeUnknownSync(Schema.String)(42)
 * } catch (e) {
 *   if (Schema.isSchemaError(e)) {
 *     console.log(String(e.issue))
 *     // "Expected string, got 42"
 *   }
 * }
 * ```
 *
 * @see {@link InvalidValue} — the input has the right type but fails a value constraint
 *
 * @category models
 * @since 4.0.0
 */
export class InvalidType extends Base {
  readonly _tag = "InvalidType"
  /**
   * The schema that caused the issue.
   */
  readonly ast: AST.AST
  /**
   * The input value that caused the issue.
   */
  readonly actual: Option.Option<unknown>

  constructor(
    /**
     * The schema that caused the issue.
     */
    ast: AST.AST,
    /**
     * The input value that caused the issue.
     */
    actual: Option.Option<unknown>
  ) {
    super()
    this.ast = ast
    this.actual = actual
  }
}

/**
 * Represents a schema issue produced when the input has the correct type but its value violates a
 * constraint (e.g. a string that is too short, a number out of range).
 *
 * **When to use**
 *
 * Use when you need to detect constraint violations from `Schema.filter`,
 * `Schema.minLength`, `Schema.greaterThan`, or similar checks.
 *
 * **Details**
 *
 * - `actual` is `Option.some(value)` when the failing value is known, or
 *   `Option.none()` when absent.
 * - `annotations` optionally carries a `message` string for formatting.
 * - The default formatter renders this as `"Invalid data <actual>"` unless a
 *   custom `message` annotation is provided.
 *
 * **Example** (Custom filter returning InvalidValue)
 *
 * ```ts
 * import { Option, SchemaIssue } from "effect"
 *
 * const issue = new SchemaIssue.InvalidValue(
 *   Option.some(""),
 *   { message: "must not be empty" }
 * )
 * console.log(String(issue))
 * // "must not be empty"
 * ```
 *
 * @see {@link InvalidType} — the input has the wrong type entirely
 * @see {@link Filter} — composite wrapper when a schema filter produces this issue
 *
 * @category models
 * @since 4.0.0
 */
export class InvalidValue extends Base {
  readonly _tag = "InvalidValue"
  /**
   * The value that caused the issue.
   */
  readonly actual: Option.Option<unknown>
  /**
   * The metadata for the issue.
   */
  readonly annotations: Schema.Annotations.Issue | undefined

  constructor(
    /**
     * The value that caused the issue.
     */
    actual: Option.Option<unknown>,
    /**
     * The metadata for the issue.
     */
    annotations?: Schema.Annotations.Issue | undefined
  ) {
    super()
    this.actual = actual
    this.annotations = annotations
  }
}

/**
 * Represents a schema issue produced when a forbidden operation is encountered during parsing,
 * such as an asynchronous Effect running inside `Schema.decodeUnknownSync`.
 *
 * **When to use**
 *
 * Use when you need to detect that a schema requires async execution but was run
 * synchronously.
 *
 * **Details**
 *
 * - `actual` is `Option.some(value)` when the input is known, or
 *   `Option.none()` when absent.
 * - `annotations` optionally carries a `message` string.
 * - The default formatter renders this as `"Forbidden operation"`.
 *
 * **Example** (Creating a Forbidden issue)
 *
 * ```ts
 * import { Option, SchemaIssue } from "effect"
 *
 * const issue = new SchemaIssue.Forbidden(
 *   Option.none(),
 *   { message: "async operation not allowed in sync context" }
 * )
 * console.log(String(issue))
 * // "async operation not allowed in sync context"
 * ```
 *
 * @see {@link InvalidValue} — for value-constraint failures (not operation failures)
 *
 * @category models
 * @since 3.10.0
 */
export class Forbidden extends Base {
  readonly _tag = "Forbidden"
  /**
   * The input value that caused the issue.
   */
  readonly actual: Option.Option<unknown>
  /**
   * The metadata for the issue.
   */
  readonly annotations: Schema.Annotations.Issue | undefined

  constructor(
    /**
     * The input value that caused the issue.
     */
    actual: Option.Option<unknown>,
    /**
     * The metadata for the issue.
     */
    annotations: Schema.Annotations.Issue | undefined
  ) {
    super()
    this.actual = actual
    this.annotations = annotations
  }
}

/**
 * Represents a schema issue produced when a value does not match *any* member of a union schema.
 *
 * **When to use**
 *
 * Use when you need to inspect which union members were attempted and why each
 * failed.
 *
 * **Details**
 *
 * - `ast` is the `Union` AST node.
 * - `actual` is the raw input value (plain `unknown`).
 * - `issues` contains per-member failures. When empty, the formatter falls
 *   back to the union's `expected` annotation.
 *
 * @see {@link OneOf} — the opposite: *too many* members matched
 * @see {@link Composite} — groups multiple issues under a non-union schema
 *
 * @category models
 * @since 4.0.0
 */
export class AnyOf extends Base {
  readonly _tag = "AnyOf"
  /**
   * The schema that caused the issue.
   */
  readonly ast: AST.Union
  /**
   * The input value that caused the issue.
   */
  readonly actual: unknown
  /**
   * The issues that occurred.
   */
  readonly issues: ReadonlyArray<Issue>

  constructor(
    /**
     * The schema that caused the issue.
     */
    ast: AST.Union,
    /**
     * The input value that caused the issue.
     */
    actual: unknown,
    /**
     * The issues that occurred.
     */
    issues: ReadonlyArray<Issue>
  ) {
    super()
    this.ast = ast
    this.actual = actual
    this.issues = issues
  }
}

/**
 * Represents a schema issue produced when a value matches *multiple* members of a union that is
 * configured to allow exactly one match (oneOf mode).
 *
 * **When to use**
 *
 * Use when you need to detect ambiguous union matches when `oneOf` validation is
 * enabled.
 *
 * **Details**
 *
 * - `ast` is the `Union` AST node.
 * - `actual` is the raw input value (plain `unknown`).
 * - `successes` lists the AST nodes of each member that accepted the input.
 * - The default formatter renders this as
 *   `"Expected exactly one member to match the input <actual>"`.
 *
 * @see {@link AnyOf} — the opposite: *no* members matched
 *
 * @category models
 * @since 4.0.0
 */
export class OneOf extends Base {
  readonly _tag = "OneOf"
  /**
   * The schema that caused the issue.
   */
  readonly ast: AST.Union
  /**
   * The input value that caused the issue.
   */
  readonly actual: unknown
  /**
   * The schemas that were successful.
   */
  readonly successes: ReadonlyArray<AST.AST>

  constructor(
    /**
     * The schema that caused the issue.
     */
    ast: AST.Union,
    /**
     * The input value that caused the issue.
     */
    actual: unknown,
    /**
     * The schemas that were successful.
     */
    successes: ReadonlyArray<AST.AST>
  ) {
    super()
    this.ast = ast
    this.actual = actual
    this.successes = successes
  }
}

/**
 * Extracts the actual input value from any {@link Issue} variant.
 *
 * **When to use**
 *
 * Use when retrieve the offending value for logging or custom error rendering.
 * - Uniformly access `actual` regardless of which issue variant you have.
 *
 * **Details**
 *
 * - Returns `Option.none()` for `Pointer` and `MissingKey` (they carry no
 *   value).
 * - Returns the existing `Option` for variants that already store `actual` as
 *   `Option<unknown>` (`InvalidType`, `InvalidValue`, `Forbidden`, `Encoding`,
 *   `Composite`).
 * - Wraps `actual` with `Option.some` for variants that store it as plain
 *   `unknown` (`AnyOf`, `UnexpectedKey`, `OneOf`, `Filter`).
 *
 * **Example** (Extracting the actual value)
 *
 * ```ts
 * import { Option, SchemaIssue } from "effect"
 *
 * const issue = new SchemaIssue.MissingKey(undefined)
 * console.log(SchemaIssue.getActual(issue))
 * // { _tag: "None" }
 * ```
 *
 * @see {@link Issue}
 * @see {@link isIssue}
 *
 * @category getters
 * @since 4.0.0
 */
export function getActual(issue: Issue): Option.Option<unknown> {
  switch (issue._tag) {
    case "Pointer":
    case "MissingKey":
      return Option.none()
    case "InvalidType":
    case "InvalidValue":
    case "Forbidden":
    case "Encoding":
    case "Composite":
      return issue.actual
    case "AnyOf":
    case "UnexpectedKey":
    case "OneOf":
    case "Filter":
      return Option.some(issue.actual)
  }
}

function makeFilterIssue(input: unknown, entry: Schema.FilterIssue): Issue {
  if (isIssue(entry)) {
    return entry
  }
  if (typeof entry === "string") {
    return new InvalidValue(Option.some(input), { message: entry })
  }
  const inner = typeof entry.issue === "string"
    ? new InvalidValue(Option.some(input), { message: entry.issue })
    : entry.issue
  return new Pointer(entry.path, inner)
}

/** @internal */
export function makeSingle(input: unknown, out: undefined | boolean | Schema.FilterIssue): Issue | undefined {
  if (out === undefined) {
    return undefined
  }
  if (typeof out === "boolean") {
    return out ? undefined : new InvalidValue(Option.some(input))
  }
  return makeFilterIssue(input, out)
}

/** @internal */
export function make(input: unknown, ast: AST.AST, out: Schema.FilterOutput): Issue | undefined {
  if (Array.isArray(out)) {
    if (Arr.isReadonlyArrayNonEmpty(out)) {
      if (out.length === 1) {
        return makeFilterIssue(input, out[0])
      }
      return new Composite(ast, Option.some(input), Arr.map(out, (entry) => makeFilterIssue(input, entry)))
    }
    return undefined
  }
  return makeSingle(input, out as undefined | boolean | Schema.FilterIssue)
}

/**
 * A function type that converts an {@link Issue} into a formatted
 * representation. Specialisation of the generic `Formatter` from
 * `Formatter.ts` with `Value` fixed to `Issue`.
 *
 * @see {@link makeFormatterDefault} — creates a `Formatter<string>`
 * @see {@link makeFormatterStandardSchemaV1} — creates a `Formatter<StandardSchemaV1.FailureResult>`
 *
 * @category Formatter
 * @since 4.0.0
 */
export interface Formatter<out Format> extends FormatterI<Issue, Format> {}

/**
 * Callback type used to format {@link Leaf} issues into strings.
 *
 * **When to use**
 *
 * Use when customizing how {@link makeFormatterStandardSchemaV1} renders
 * terminal issues.
 *
 * @see {@link defaultLeafHook} — the built-in implementation
 * @see {@link Leaf} — the union of terminal issue types
 *
 * @category Formatter
 * @since 4.0.0
 */
export type LeafHook = (issue: Leaf) => string

/**
 * Returns the built-in {@link LeafHook} used by default formatters.
 *
 * **When to use**
 *
 * Use as the default leaf renderer when you only need to customise the
 * {@link CheckHook}.
 * - Reference as a starting point for custom `LeafHook` implementations.
 *
 * **Details**
 *
 * - Checks for a `message` annotation first; returns it if present.
 * - Otherwise generates a default message per `_tag`:
 *   - `InvalidType` → `"Expected <type>, got <actual>"`
 *   - `InvalidValue` → `"Invalid data <actual>"`
 *   - `MissingKey` → `"Missing key"`
 *   - `UnexpectedKey` → `"Unexpected key with value <actual>"`
 *   - `Forbidden` → `"Forbidden operation"`
 *   - `OneOf` → `"Expected exactly one member to match the input <actual>"`
 *
 * **Example** (Using defaultLeafHook with Standard Schema formatter)
 *
 * ```ts
 * import { SchemaIssue } from "effect"
 *
 * const formatter = SchemaIssue.makeFormatterStandardSchemaV1({
 *   leafHook: SchemaIssue.defaultLeafHook
 * })
 * ```
 *
 * @see {@link LeafHook}
 * @see {@link makeFormatterStandardSchemaV1}
 *
 * @category Formatter
 * @since 4.0.0
 */
export const defaultLeafHook: LeafHook = (issue): string => {
  const message = findMessage(issue)
  if (message !== undefined) return message
  switch (issue._tag) {
    case "InvalidType":
      return getExpectedMessage(InternalAnnotations.getExpected(issue.ast), formatOption(issue.actual))
    case "InvalidValue":
      return `Invalid data ${formatOption(issue.actual)}`
    case "MissingKey":
      return "Missing key"
    case "UnexpectedKey":
      return `Unexpected key with value ${format(issue.actual)}`
    case "Forbidden":
      return "Forbidden operation"
    case "OneOf":
      return `Expected exactly one member to match the input ${format(issue.actual)}`
  }
}

/**
 * Callback type used to format {@link Filter} issues into strings.
 *
 * **When to use**
 *
 * Use when customizing how {@link makeFormatterStandardSchemaV1} renders
 * filter failures.
 *
 * **Details**
 *
 * - Returns `string` to override the message, or `undefined` to fall back to
 *   the default formatting.
 *
 * @see {@link defaultCheckHook} — the built-in implementation
 * @see {@link Filter} — the issue type this hook formats
 *
 * @category Formatter
 * @since 4.0.0
 */
export type CheckHook = (issue: Filter) => string | undefined

/**
 * Returns the built-in {@link CheckHook} used by default formatters.
 *
 * **When to use**
 *
 * Use as the default filter renderer when you only need to customise the
 * {@link LeafHook}.
 *
 * **Details**
 *
 * - Looks for a `message` annotation on the inner issue first, then on the
 *   filter itself.
 * - Returns `undefined` when no annotation is found, causing the formatter to
 *   fall back to `"Expected <filter>, got <actual>"`.
 *
 * @see {@link CheckHook}
 * @see {@link makeFormatterStandardSchemaV1}
 *
 * @category Formatter
 * @since 4.0.0
 */
export const defaultCheckHook: CheckHook = (issue): string | undefined => {
  return findMessage(issue.issue) ?? findMessage(issue)
}

/**
 * Creates a {@link Formatter} that produces a `StandardSchemaV1.FailureResult`.
 *
 * **When to use**
 *
 * Use when integrate with libraries that consume the
 *   [Standard Schema V1](https://github.com/standard-schema/standard-schema)
 *   error format.
 * - Customise error rendering by providing `leafHook` and/or `checkHook`.
 *
 * **Details**
 *
 * - Returns a `Formatter<StandardSchemaV1.FailureResult>`.
 * - Each leaf issue is flattened into `{ message, path }` entries.
 * - `Pointer` paths are accumulated to produce full property paths.
 * - Falls back to {@link defaultLeafHook} / {@link defaultCheckHook} when no
 *   hooks are provided.
 *
 * **Example** (Creating a Standard Schema V1 formatter)
 *
 * ```ts
 * import { SchemaIssue } from "effect"
 *
 * const formatter = SchemaIssue.makeFormatterStandardSchemaV1()
 * ```
 *
 * @see {@link makeFormatterDefault} — produces a plain string instead
 * @see {@link LeafHook}
 * @see {@link CheckHook}
 *
 * @category Formatter
 * @since 4.0.0
 */
export function makeFormatterStandardSchemaV1(options?: {
  readonly leafHook?: LeafHook | undefined
  readonly checkHook?: CheckHook | undefined
}): Formatter<StandardSchemaV1.FailureResult> {
  return (issue) => ({
    issues: toDefaultIssues(issue, [], options?.leafHook ?? defaultLeafHook, options?.checkHook ?? defaultCheckHook)
  })
}

// A subtype of StandardSchemaV1.Issue
type DefaultIssue = {
  readonly message: string
  readonly path: ReadonlyArray<PropertyKey>
}

function getExpectedMessage(expected: string, actual: string): string {
  return `Expected ${expected}, got ${actual}`
}

function toDefaultIssues(
  issue: Issue,
  path: ReadonlyArray<PropertyKey>,
  leafHook: LeafHook,
  checkHook: CheckHook
): Array<DefaultIssue> {
  switch (issue._tag) {
    case "Filter": {
      const message = checkHook(issue)
      if (message !== undefined) {
        return [{ path, message }]
      }
      switch (issue.issue._tag) {
        case "InvalidValue":
          return [{
            path,
            message: getExpectedMessage(formatCheck(issue.filter), format(issue.actual))
          }]
        default:
          return toDefaultIssues(issue.issue, path, leafHook, checkHook)
      }
    }
    case "Encoding":
      return toDefaultIssues(issue.issue, path, leafHook, checkHook)
    case "Pointer":
      return toDefaultIssues(issue.issue, [...path, ...issue.path], leafHook, checkHook)
    case "Composite":
      return issue.issues.flatMap((issue) => toDefaultIssues(issue, path, leafHook, checkHook))
    case "AnyOf": {
      const message = findMessage(issue)
      if (issue.issues.length === 0) {
        if (message !== undefined) return [{ path, message }]

        const expected = getExpectedMessage(InternalAnnotations.getExpected(issue.ast), format(issue.actual))
        return [{ path, message: expected }]
      }
      return issue.issues.flatMap((issue) => toDefaultIssues(issue, path, leafHook, checkHook))
    }
    default:
      return [{ path, message: leafHook(issue) }]
  }
}

function formatCheck<T>(check: AST.Check<T>): string {
  const expected = check.annotations?.expected
  if (typeof expected === "string") return expected

  switch (check._tag) {
    case "Filter":
      return "<filter>"
    case "FilterGroup":
      return check.checks.map((check) => formatCheck(check)).join(" & ")
  }
}

/**
 * Creates a {@link Formatter} that converts an {@link Issue} into a
 * human-readable multi-line string.
 *
 * **When to use**
 *
 * Use when produce error messages for logging, CLI output, or developer-facing
 *   diagnostics.
 * - This is the default formatter used by `Issue.toString()`.
 *
 * **Details**
 *
 * - Flattens the issue tree into `{ message, path }` entries using
 *   {@link defaultLeafHook} and {@link defaultCheckHook}.
 * - Each entry is rendered as `"<message>"` or `"<message>\n  at <path>"`.
 * - Multiple entries are joined with newlines.
 *
 * **Example** (Formatting an issue as a string)
 *
 * ```ts
 * import { SchemaIssue } from "effect"
 *
 * const formatter = SchemaIssue.makeFormatterDefault()
 * ```
 *
 * @see {@link makeFormatterStandardSchemaV1} — produces Standard Schema V1 format instead
 * @see {@link Formatter}
 *
 * @category Formatter
 * @since 4.0.0
 */
export function makeFormatterDefault(): Formatter<string> {
  return (issue) =>
    toDefaultIssues(issue, [], defaultLeafHook, defaultCheckHook)
      .map(formatDefaultIssue)
      .join("\n")
}

/** @internal */
export const defaultFormatter = makeFormatterDefault()

function formatDefaultIssue(issue: DefaultIssue): string {
  let out = issue.message
  if (issue.path && issue.path.length > 0) {
    const path = formatPath(issue.path as ReadonlyArray<PropertyKey>)
    out += `\n  at ${path}`
  }
  return out
}

function findMessage(issue: Issue): string | undefined {
  switch (issue._tag) {
    case "InvalidType":
    case "OneOf":
    case "Composite":
    case "AnyOf":
      return getMessageAnnotation(issue.ast.annotations)
    case "InvalidValue":
    case "Forbidden":
      return getMessageAnnotation(issue.annotations)
    case "MissingKey":
      return getMessageAnnotation(issue.annotations, "messageMissingKey")
    case "UnexpectedKey":
      return getMessageAnnotation(issue.ast.annotations, "messageUnexpectedKey")
    case "Filter":
      return getMessageAnnotation(issue.filter.annotations)
    case "Encoding":
      return findMessage(issue.issue)
  }
}

function getMessageAnnotation(
  annotations: Schema.Annotations.Annotations | undefined,
  type: "message" | "messageMissingKey" | "messageUnexpectedKey" = "message"
): string | undefined {
  const message = annotations?.[type]
  if (typeof message === "string") return message
}

function formatOption(actual: Option.Option<unknown>): string {
  if (Option.isNone(actual)) return "no value provided"
  return format(actual.value)
}

/** @internal */
export function redact(issue: Issue): Issue {
  switch (issue._tag) {
    case "MissingKey":
      return issue
    case "Forbidden":
      return new Forbidden(Option.map(issue.actual, Redacted.make), issue.annotations)
    case "Filter":
      return new Filter(Redacted.make(issue.actual), issue.filter, redact(issue.issue))
    case "Pointer":
      return new Pointer(issue.path, redact(issue.issue))

    case "Encoding":
    case "InvalidType":
    case "InvalidValue":
    case "Composite":
      return new InvalidValue(Option.map(issue.actual, Redacted.make))

    case "AnyOf":
    case "OneOf":
    case "UnexpectedKey":
      return new InvalidValue(Option.some(Redacted.make(issue.actual)))
  }
}
